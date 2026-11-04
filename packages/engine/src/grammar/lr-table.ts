import { TraceRecorder, type Trace } from '../core/trace';
import { formatGrammarProduction } from './cfg';
import {
  lrBuildAutomaton,
  lrFormatItem,
  MAX_LR_STATES,
  type LrAutomaton,
  type LrBuildStep,
  type LrState,
} from './lr-items';
import { grammarSetMaps } from './sets';
import {
  GRAMMAR_END_MARKER,
  type Grammar,
  type GrammarPrecedence,
  type GrammarPrecedenceLevel,
  type GrammarProduction,
} from './types';

export type LrTableKind = 'lr0' | 'slr' | 'lr1' | 'lalr';

export type LrAction =
  | { readonly type: 'shift'; readonly state: number }
  | { readonly type: 'reduce'; readonly production: number }
  | { readonly type: 'accept' };

export type LrConflictKind = 'shift-reduce' | 'reduce-reduce';

export interface LrConflict {
  readonly state: number;
  readonly terminal: string;
  /** shift-reduce if a shift is involved, even if two reductions are too. */
  readonly kind: LrConflictKind;
  /** Every action competing for this cell. */
  readonly actions: readonly LrAction[];
  /** What the parser does anyway: shift beats reduce, and the earlier production beats the later. */
  readonly chosen: LrAction;
  /** The items in this state responsible for the competing actions. */
  readonly items: readonly string[];
  readonly message: string;
}

/** A shift/reduce choice settled by precedence, so it is not a conflict. Bison reports these too. */
export interface LrPrecedenceResolution {
  readonly state: number;
  readonly terminal: string;
  readonly production: number;
  readonly winner: 'shift' | 'reduce' | 'error';
  readonly reason: string;
}

export interface LrTable {
  readonly kind: LrTableKind;
  /** The augmented grammar. Reduce actions use its numbers, so r1 is the first production written. */
  readonly grammar: Grammar;
  readonly automaton: LrAutomaton;
  /** The ACTION columns: the grammar's terminals, then $. */
  readonly terminals: readonly string[];
  /** The GOTO columns. S' is not one, because nothing ever goes to it. */
  readonly nonterminals: readonly string[];
  /** [state][terminal]: every action left after precedence. More than one means a conflict. */
  readonly cells: readonly (readonly (readonly LrAction[])[])[];
  /** [state][terminal]: the action the parser takes, or null for an error. */
  readonly action: readonly (readonly (LrAction | null)[])[];
  /** [state][nonterminal]: the state to go to, or null. */
  readonly goto: readonly (readonly (number | null)[])[];
  /** In order of state. */
  readonly conflicts: readonly LrConflict[];
  /** Counted the way Bison counts: one per terminal with a shift and a reduce... */
  readonly shiftReduceCount: number;
  /** ...and one per extra reduction in a cell. */
  readonly reduceReduceCount: number;
  readonly resolutions: readonly LrPrecedenceResolution[];
  readonly trace: Trace<LrBuildStep>;
}

export interface LrTableOptions {
  /** Settles shift/reduce conflicts as %left, %right, %nonassoc and %prec do in Yacc. */
  readonly precedence?: GrammarPrecedence;
  readonly maxStates?: number;
}

/** "s5", "r3" or "acc", as the book writes them. State labels matter for merged LALR states. */
export function lrFormatAction(table: Pick<LrTable, 'automaton'>, action: LrAction): string {
  if (action.type === 'shift')
    return `s${table.automaton.states[action.state]?.label ?? action.state}`;
  return action.type === 'accept' ? 'acc' : `r${action.production}`;
}

function describeAction(table: { grammar: Grammar; automaton: LrAutomaton }, action: LrAction) {
  if (action.type === 'shift') {
    return `shift to state ${table.automaton.states[action.state]?.label ?? action.state}`;
  }
  if (action.type === 'accept') return 'accept';
  const production = table.grammar.productions[action.production] as GrammarProduction;
  return `reduce by ${formatGrammarProduction(production)}`;
}

const actionRank = (action: LrAction) =>
  action.type === 'shift' ? -2 : action.type === 'accept' ? -1 : action.production;

/** How precedence is compared: the level of each terminal, and each production's own level. */
function precedenceLookup(augmented: Grammar, precedence: GrammarPrecedence | undefined) {
  const levelOf = new Map<string, { level: number; assoc: GrammarPrecedenceLevel['assoc'] }>();
  precedence?.levels.forEach(({ assoc, terminals }, level) => {
    for (const terminal of terminals) levelOf.set(terminal, { level, assoc });
  });
  const overrides = new Map(
    (precedence?.productions ?? []).map(({ production, terminal }) => [production + 1, terminal]),
  );
  const terminals = new Set(augmented.terminals);
  return {
    terminal: (terminal: string) => levelOf.get(terminal),
    production: (id: number) => {
      const override = overrides.get(id);
      if (override !== undefined) return levelOf.get(override);
      const body = (augmented.productions[id] as GrammarProduction).body;
      const last = body.findLast((symbol) => terminals.has(symbol));
      return last === undefined ? undefined : levelOf.get(last);
    },
  };
}

/**
 * Fills in ACTION and GOTO from an automaton: Dragon Book Algorithm 4.46 for SLR(1), and 4.56 for
 * canonical LR(1). LALR(1) uses the same rule as LR(1), on the merged automaton. The kinds differ
 * only in when a complete item [A → α ·] reduces:
 *
 *   lr0   on every terminal
 *   slr   on FOLLOW(A)
 *   lr1   on the item's own lookaheads
 *   lalr  on the merged lookaheads
 *
 * The shift, accept and GOTO entries are the same in all of them. A cell that ends up with more
 * than one action is a conflict. The table still gets a default, as Yacc's does, so a grammar with
 * conflicts can run.
 */
export function lrBuildTable(
  grammar: Grammar,
  kind: LrTableKind,
  options: LrTableOptions = {},
): LrTable {
  const automaton = lrBuildAutomaton(
    grammar,
    kind === 'slr' ? 'lr0' : kind,
    options.maxStates ?? MAX_LR_STATES,
  );
  const augmented = automaton.grammar;
  const terminals = [...augmented.terminals, GRAMMAR_END_MARKER];
  const nonterminals = augmented.nonterminals.filter((symbol) => symbol !== augmented.start);
  const columnOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const gotoColumnOf = new Map(nonterminals.map((symbol, index) => [symbol, index]));
  const follow = kind === 'slr' ? grammarSetMaps(augmented).follow : null;
  const precedence = precedenceLookup(augmented, options.precedence);
  const context = { grammar: augmented, automaton };

  const recorder = new TraceRecorder<LrBuildStep>(automaton.states.length + 2);
  const cells: LrAction[][][] = [];
  const action: (LrAction | null)[][] = [];
  const gotos: (number | null)[][] = [];
  const conflicts: LrConflict[] = [];
  const resolutions: LrPrecedenceResolution[] = [];
  let shiftReduceCount = 0;
  let reduceReduceCount = 0;

  const stepAt = (
    stateCount: number,
    filledRows: number,
    activeState: number | null,
  ): LrBuildStep => ({
    stage: 'table',
    stateCount,
    edgeCount: automaton.edges.length,
    activeState,
    activeSymbol: null,
    target: null,
    created: false,
    filledRows,
    conflictCount: conflicts.length,
  });

  /** Removes the actions precedence rules out, the way Yacc does, one reduction at a time. */
  const applyPrecedence = (stateId: number, terminal: string, cell: LrAction[]): LrAction[] => {
    const terminalLevel = precedence.terminal(terminal);
    if (!terminalLevel || !cell.some(({ type }) => type === 'shift')) return cell;
    let kept = cell;
    for (const candidate of cell) {
      if (candidate.type !== 'reduce') continue;
      if (!kept.some(({ type }) => type === 'shift')) break;
      const productionLevel = precedence.production(candidate.production);
      if (!productionLevel) continue;
      let winner: LrPrecedenceResolution['winner'];
      if (productionLevel.level > terminalLevel.level) winner = 'reduce';
      else if (productionLevel.level < terminalLevel.level) winner = 'shift';
      else if (terminalLevel.assoc === 'left') winner = 'reduce';
      else if (terminalLevel.assoc === 'right') winner = 'shift';
      else winner = 'error';
      const name = formatGrammarProduction(
        augmented.productions[candidate.production] as GrammarProduction,
      );
      const reason =
        productionLevel.level !== terminalLevel.level
          ? `${name} has ${productionLevel.level > terminalLevel.level ? 'higher' : 'lower'} precedence than ${terminal}.`
          : `${name} and ${terminal} have the same precedence, and it is %${terminalLevel.assoc}.`;
      resolutions.push({
        state: stateId,
        terminal,
        production: candidate.production,
        winner,
        reason,
      });
      kept = kept.filter((other) => {
        if (other === candidate) return winner === 'reduce';
        if (other.type === 'shift') return winner === 'shift';
        return true;
      });
    }
    return kept;
  };

  const responsibleItems = (state: LrState, terminal: string, actions: readonly LrAction[]) => {
    const reductions = new Set(
      actions.flatMap((item) => (item.type === 'reduce' ? [item.production] : [])),
    );
    return state.items
      .filter((item) => {
        const { body } = augmented.productions[item.production] as GrammarProduction;
        return item.dot === body.length
          ? reductions.has(item.production)
          : body[item.dot] === terminal;
      })
      .map((item) => lrFormatItem(augmented, item));
  };

  recorder.add(
    'Fill in the table',
    `Each state gets one row. ${
      kind === 'lr0'
        ? 'In an LR(0) table, a complete item reduces on every terminal.'
        : kind === 'slr'
          ? 'In an SLR(1) table, a complete item for A reduces on everything in FOLLOW(A).'
          : 'A complete item reduces only on its own lookaheads.'
    } An item with the dot before a terminal shifts it. A transition on a nonterminal goes in GOTO.`,
    stepAt(automaton.states.length, 0, null),
  );

  for (const state of automaton.states) {
    const row: LrAction[][] = terminals.map(() => []);
    const gotoRow: (number | null)[] = nonterminals.map(() => null);
    for (const { symbol, to } of state.transitions) {
      const column = columnOf.get(symbol);
      if (column !== undefined) (row[column] as LrAction[]).push({ type: 'shift', state: to });
      else {
        const gotoColumn = gotoColumnOf.get(symbol);
        if (gotoColumn !== undefined) gotoRow[gotoColumn] = to;
      }
    }
    const reasons: string[] = [];
    for (const item of state.items) {
      const { head, body } = augmented.productions[item.production] as GrammarProduction;
      if (item.dot !== body.length) continue;
      if (item.production === 0) {
        (row[columnOf.get(GRAMMAR_END_MARKER) as number] as LrAction[]).push({ type: 'accept' });
        reasons.push(`[${lrFormatItem(augmented, item)}] accepts on $.`);
        continue;
      }
      const lookaheads =
        kind === 'lr0' ? terminals : follow ? [...(follow.get(head) ?? [])] : item.lookaheads;
      for (const terminal of lookaheads) {
        (row[columnOf.get(terminal) as number] as LrAction[]).push({
          type: 'reduce',
          production: item.production,
        });
      }
      reasons.push(
        `[${lrFormatItem(augmented, item)}] reduces on ${lookaheads.join(', ') || 'nothing'}.`,
      );
    }

    const before = conflicts.length;
    const finalRow = row.map((cell, column) => {
      const terminal = terminals[column] as string;
      const kept = applyPrecedence(state.id, terminal, cell).toSorted(
        (a, b) => actionRank(a) - actionRank(b),
      );
      if (kept.length > 1) {
        const hasShift = kept.some(({ type }) => type === 'shift');
        const reductions = kept.filter(({ type }) => type !== 'shift').length;
        if (hasShift) shiftReduceCount++;
        reduceReduceCount += Math.max(0, reductions - 1);
        const conflictKind: LrConflictKind = hasShift ? 'shift-reduce' : 'reduce-reduce';
        const chosen = kept[0] as LrAction;
        conflicts.push({
          state: state.id,
          terminal,
          kind: conflictKind,
          actions: kept,
          chosen,
          items: responsibleItems(state, terminal, kept),
          message: `State ${state.label} on ${terminal}: ${kept.map((item) => describeAction(context, item)).join(', or ')}. This is a ${conflictKind === 'shift-reduce' ? 'shift/reduce' : 'reduce/reduce'} conflict, and by default the parser will ${describeAction(context, chosen)}.`,
        });
      }
      return kept;
    });
    cells.push(finalRow);
    action.push(finalRow.map((cell) => cell[0] ?? null));
    gotos.push(gotoRow);

    const shifts = state.transitions.filter(({ symbol }) => columnOf.has(symbol));
    const shiftText =
      shifts.length > 0
        ? `It shifts ${shifts.map(({ symbol }) => symbol).join(', ')}.`
        : 'It has nothing to shift.';
    const newConflicts = conflicts.length - before;
    recorder.add(
      `Row for state ${state.label}`,
      `${shiftText} ${reasons.join(' ')}${newConflicts > 0 ? ` That gives ${newConflicts} conflict${newConflicts === 1 ? '' : 's'} in this row.` : ''}`,
      stepAt(automaton.states.length, state.id + 1, state.id),
    );
  }

  const name = { lr0: 'LR(0)', slr: 'SLR(1)', lr1: 'LR(1)', lalr: 'LALR(1)' }[kind];
  recorder.add(
    'The table is complete',
    conflicts.length === 0
      ? `No cell has more than one action, so this grammar is ${name}.`
      : `This grammar is not ${name}: ${shiftReduceCount} shift/reduce and ${reduceReduceCount} reduce/reduce conflict${reduceReduceCount === 1 ? '' : 's'}. The table still works, because each conflict has a default, but it may not parse what you intended.`,
    stepAt(automaton.states.length, automaton.states.length, null),
  );

  return {
    kind,
    grammar: augmented,
    automaton,
    terminals,
    nonterminals,
    cells,
    action,
    goto: gotos,
    conflicts,
    shiftReduceCount,
    reduceReduceCount,
    resolutions,
    trace: recorder.finish(),
  };
}
