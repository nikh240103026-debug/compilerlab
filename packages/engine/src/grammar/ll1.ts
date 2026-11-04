import { TraceRecorder, type Trace } from '../core/trace';
import { formatGrammarProduction, sortGrammarSymbols, grammarSymbolOrder } from './cfg';
import {
  grammarFirstOfSequence,
  grammarSetMaps,
  grammarSetRows,
  type GrammarSetMaps,
} from './sets';
import {
  GRAMMAR_END_MARKER,
  type Grammar,
  type GrammarProduction,
  type GrammarSetRow,
  type GrammarTableCell,
} from './types';

export type Ll1ConflictKind = 'first-first' | 'first-follow' | 'both-nullable';

export interface Ll1Conflict {
  readonly row: number;
  readonly column: number;
  readonly nonterminal: string;
  readonly terminal: string;
  /** In the order they were entered. The parser uses the first. */
  readonly productions: readonly number[];
  readonly kind: Ll1ConflictKind;
  readonly message: string;
}

export interface Ll1TableStep {
  /** [row][column] gives the productions in that cell. */
  readonly cells: readonly (readonly (readonly number[])[])[];
  /** The production being entered. Null on the first and last steps. */
  readonly production: number | null;
  /** The cells this step wrote to. */
  readonly added: readonly GrammarTableCell[];
  /** The terminals it was entered under because of FIRST(body), and because of FOLLOW(head). */
  readonly viaFirst: readonly string[];
  readonly viaFollow: readonly string[];
}

export interface Ll1Table {
  readonly grammar: Grammar;
  readonly nullable: readonly string[];
  readonly first: readonly GrammarSetRow[];
  readonly follow: readonly GrammarSetRow[];
  /** The rows of the table, in grammar order. */
  readonly nonterminals: readonly string[];
  /** The columns of the table: the grammar's terminals, then $. */
  readonly terminals: readonly string[];
  readonly cells: readonly (readonly (readonly number[])[])[];
  /**
   * Cells that are empty but whose terminal is in FOLLOW(row). In panic mode these say to pop the
   * nonterminal rather than skip the input, as in Dragon Book Figure 4.22.
   */
  readonly synch: readonly (readonly boolean[])[];
  readonly conflicts: readonly Ll1Conflict[];
  readonly isLl1: boolean;
  readonly trace: Trace<Ll1TableStep>;
}

function describeConflict(
  grammar: Grammar,
  nonterminal: string,
  terminal: string,
  productions: readonly number[],
  kind: Ll1ConflictKind,
): string {
  const names = productions
    .map((id) => formatGrammarProduction(grammar.productions[id] as GrammarProduction))
    .join(' and ');
  const where = `M[${nonterminal}, ${terminal}] holds both ${names}.`;
  if (kind === 'first-first')
    return `${where} FIRST/FIRST conflict: both bodies can start with ${terminal}.`;
  if (kind === 'first-follow') {
    return `${where} FIRST/FOLLOW conflict: one body can start with ${terminal}, and another can vanish with ${terminal} in FOLLOW(${nonterminal}).`;
  }
  return `${where} Both bodies can vanish, so with ${terminal} next there is no way to choose between them.`;
}

/**
 * Dragon Book Algorithm 4.31. For each production A → α, enter it under every terminal in
 * FIRST(α), and if α can vanish, under everything in FOLLOW(A) too. A cell with two productions
 * means the grammar is not LL(1).
 */
export function ll1BuildTable(grammar: Grammar): Ll1Table {
  const maps: GrammarSetMaps = grammarSetMaps(grammar);
  const order = grammarSymbolOrder(grammar);
  const nonterminals = grammar.nonterminals;
  const terminals = [...grammar.terminals, GRAMMAR_END_MARKER];
  const rowOf = new Map(nonterminals.map((symbol, index) => [symbol, index]));
  const columnOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const recorder = new TraceRecorder<Ll1TableStep>();

  // A row is replaced whenever it changes, so earlier snapshots can share the rest of the table.
  const rows: (readonly (readonly number[])[])[] = nonterminals.map(() => terminals.map(() => []));
  const reasons = new Map<string, ('first' | 'follow')[]>();

  recorder.add(
    'Start with an empty table',
    'There is one row per nonterminal and one column per terminal, plus $. M[A, a] will say which production to use when A is on top of the stack and a is the next token.',
    { cells: rows.slice(), production: null, added: [], viaFirst: [], viaFollow: [] },
  );

  for (const production of grammar.productions) {
    const row = rowOf.get(production.head) as number;
    const { items, nullable } = grammarFirstOfSequence(maps, production.body);
    const added: GrammarTableCell[] = [];
    const enter = (terminal: string, via: 'first' | 'follow') => {
      const column = columnOf.get(terminal) as number;
      const current = rows[row] as readonly (readonly number[])[];
      if ((current[column] as readonly number[]).includes(production.id)) return;
      const updated = current.slice();
      updated[column] = [...(current[column] as readonly number[]), production.id];
      rows[row] = updated;
      added.push({ row, column });
      const key = `${row}:${column}`;
      reasons.set(key, [...(reasons.get(key) ?? []), via]);
    };
    const viaFirst = sortGrammarSymbols(order, items);
    for (const terminal of viaFirst) enter(terminal, 'first');
    const viaFollow = nullable
      ? sortGrammarSymbols(order, maps.follow.get(production.head) ?? [])
      : [];
    for (const terminal of viaFollow) enter(terminal, 'follow');

    const why: string[] = [];
    if (viaFirst.length > 0) {
      why.push(
        `The body can start with ${viaFirst.join(', ')}, so it goes under ${viaFirst.length > 1 ? 'those columns' : 'that column'}.`,
      );
    }
    if (nullable) {
      why.push(
        viaFollow.length > 0
          ? `The body can vanish, so it also goes under FOLLOW(${production.head}) = ${viaFollow.join(', ')}.`
          : `The body can vanish, but FOLLOW(${production.head}) is empty, so that adds nothing.`,
      );
    }
    recorder.add(
      `Enter ${formatGrammarProduction(production)}`,
      why.join(' ') || `The body can derive nothing, so this production never gets a cell.`,
      { cells: rows.slice(), production: production.id, added, viaFirst, viaFollow },
    );
  }

  const conflicts: Ll1Conflict[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, column) => {
      if (cell.length < 2) return;
      const via = reasons.get(`${rowIndex}:${column}`) ?? [];
      const fromFollow = via.filter((reason) => reason === 'follow').length;
      const kind: Ll1ConflictKind =
        fromFollow >= 2 ? 'both-nullable' : fromFollow === 1 ? 'first-follow' : 'first-first';
      const nonterminal = nonterminals[rowIndex] as string;
      const terminal = terminals[column] as string;
      conflicts.push({
        row: rowIndex,
        column,
        nonterminal,
        terminal,
        productions: cell,
        kind,
        message: describeConflict(grammar, nonterminal, terminal, cell, kind),
      });
    });
  });

  const synch = rows.map((row, rowIndex) => {
    const follow = maps.follow.get(nonterminals[rowIndex] as string) ?? new Set<string>();
    return row.map((cell, column) => cell.length === 0 && follow.has(terminals[column] as string));
  });

  recorder.add(
    'Finished',
    conflicts.length === 0
      ? 'No cell has more than one production, so this grammar is LL(1). One token of lookahead always decides.'
      : `${conflicts.length} cell${conflicts.length === 1 ? ' has' : 's have'} more than one production, so this grammar is not LL(1). Left recursion and common prefixes are the usual causes, and an ambiguous grammar can never be LL(1).`,
    { cells: rows.slice(), production: null, added: [], viaFirst: [], viaFollow: [] },
  );

  return {
    grammar,
    nullable: nonterminals.filter((symbol) => maps.nullable.has(symbol)),
    first: grammarSetRows(grammar, maps.first),
    follow: grammarSetRows(grammar, maps.follow),
    nonterminals,
    terminals,
    cells: rows,
    synch,
    conflicts,
    isLl1: conflicts.length === 0,
    trace: recorder.finish(),
  };
}
