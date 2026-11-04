import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import {
  grammarFromRules,
  grammarSymbolOrder,
  indexGrammar,
  sortGrammarSymbols,
  type GrammarIndex,
} from './cfg';
import { grammarFirstOfSequence, grammarSetMaps, type GrammarSetMaps } from './sets';
import { GRAMMAR_END_MARKER, type Grammar, type GrammarProduction } from './types';

/** A generous limit for grammars a student writes, and a firm one against a canonical explosion. */
export const MAX_LR_STATES = 3_000;

export type LrAutomatonKind = 'lr0' | 'lr1' | 'lalr';

/** A dotted production. LR(0) items have no lookaheads. */
export interface LrItem {
  /** In the numbering of the augmented grammar, where production 0 is S' → S. */
  readonly production: number;
  readonly dot: number;
  readonly lookaheads: readonly string[];
  /** Kernel items are the ones the state was made from. Closure added the rest. */
  readonly kernel: boolean;
}

export interface LrTransition {
  readonly symbol: string;
  readonly to: number;
}

export interface LrState {
  readonly id: number;
  /** The name to show: "3", or "36" for an LALR state merged from canonical states 3 and 6. */
  readonly label: string;
  readonly items: readonly LrItem[];
  readonly transitions: readonly LrTransition[];
  /** For an LALR state, the canonical LR(1) states merged into it. Otherwise just its own id. */
  readonly sources: readonly number[];
}

export interface LrEdge {
  readonly from: number;
  readonly symbol: string;
  readonly to: number;
}

/**
 * One step of building an automaton or a table. It only counts what exists so far: the states and
 * edges come from the finished automaton, so a large automaton does not repeat them in every step.
 */
export interface LrBuildStep {
  readonly stage: 'collection' | 'table';
  /** States with an id below this exist. */
  readonly stateCount: number;
  /** The first this many entries of `edges` exist, as long as both ends do. */
  readonly edgeCount: number;
  readonly activeState: number | null;
  readonly activeSymbol: string | null;
  readonly target: number | null;
  /** Whether `target` was created by this step. */
  readonly created: boolean;
  /** Table rows with a state id below this are filled in. */
  readonly filledRows: number;
  /** The first this many of the table's conflicts exist. */
  readonly conflictCount: number;
}

export interface LrAutomaton {
  readonly kind: LrAutomatonKind;
  /** The augmented grammar, whose production numbers every item uses. */
  readonly grammar: Grammar;
  readonly states: readonly LrState[];
  /** Every transition, in the order they were found. */
  readonly edges: readonly LrEdge[];
  /** The state holding S' → S ·. */
  readonly acceptState: number;
  /** For LALR, how many canonical LR(1) states it was merged from. */
  readonly canonicalStateCount: number;
  readonly trace: Trace<LrBuildStep>;
}

/**
 * Adds a new start symbol S' with the single production S' → S, so that the parser can tell when
 * it is finished: reducing by production 0 means accept. A name is primed until it is unused.
 */
export function lrAugmentGrammar(grammar: Grammar): Grammar {
  const taken = new Set([...grammar.nonterminals, ...grammar.terminals]);
  let start = `${grammar.start}'`;
  while (taken.has(start)) start += "'";
  return grammarFromRules(
    start,
    [{ head: start, body: [grammar.start] }, ...grammar.productions],
    grammar.warnings,
  );
}

/** Formats an item the way the book does: [C → · c C, c/d]. */
export function lrFormatItem(grammar: Grammar, item: LrItem): string {
  const { head, body } = grammar.productions[item.production] as GrammarProduction;
  const parts = [...body.slice(0, item.dot), '·', ...body.slice(item.dot)];
  const core = `${head} → ${parts.join(' ')}`;
  return item.lookaheads.length > 0 ? `${core}, ${item.lookaheads.join('/')}` : core;
}

interface WorkItem {
  readonly production: number;
  readonly dot: number;
  readonly lookaheads: Set<string>;
  readonly kernel: boolean;
}

interface Context {
  readonly grammar: Grammar;
  readonly index: GrammarIndex;
  readonly maps: GrammarSetMaps | null;
  /** FIRST of what follows each dot position, cached because it is asked for constantly. */
  readonly firstAfter: Map<string, { items: string[]; nullable: boolean }>;
  readonly order: ReadonlyMap<string, number>;
}

function makeContext(grammar: Grammar, withLookaheads: boolean): Context {
  return {
    grammar,
    index: indexGrammar(grammar),
    maps: withLookaheads ? grammarSetMaps(grammar) : null,
    firstAfter: new Map(),
    order: grammarSymbolOrder(grammar),
  };
}

const itemKey = (item: { production: number; dot: number }) => `${item.production}.${item.dot}`;

function bodyOf(context: Context, production: number): readonly string[] {
  return (context.grammar.productions[production] as GrammarProduction).body;
}

/** For each item with a dot before a nonterminal, adds that nonterminal's productions. */
function closure(context: Context, kernel: readonly WorkItem[]): WorkItem[] {
  const items = new Map<string, WorkItem>(kernel.map((item) => [itemKey(item), item]));
  const queue = [...kernel];
  const queued = new Set(kernel.map(itemKey));

  for (let head = 0; head < queue.length; head++) {
    const item = queue[head] as WorkItem;
    queued.delete(itemKey(item));
    const body = bodyOf(context, item.production);
    const next = body[item.dot];
    if (next === undefined || !context.index.nonterminals.has(next)) continue;

    // [A → α · B β, a] adds [B → · γ, b] for each b in FIRST(β a).
    const lookaheads = new Set<string>();
    if (context.maps) {
      const key = itemKey(item);
      let after = context.firstAfter.get(key);
      if (!after) {
        after = grammarFirstOfSequence(context.maps, body.slice(item.dot + 1));
        context.firstAfter.set(key, after);
      }
      for (const terminal of after.items) lookaheads.add(terminal);
      if (after.nullable) for (const terminal of item.lookaheads) lookaheads.add(terminal);
    }

    for (const { id } of context.index.byHead.get(next) ?? []) {
      const key = `${id}.0`;
      let target = items.get(key);
      let grew = false;
      if (!target) {
        target = { production: id, dot: 0, lookaheads: new Set(), kernel: false };
        items.set(key, target);
        grew = true;
      }
      for (const terminal of lookaheads) {
        if (!target.lookaheads.has(terminal)) {
          target.lookaheads.add(terminal);
          grew = true;
        }
      }
      if (grew && !queued.has(key)) {
        queue.push(target);
        queued.add(key);
      }
    }
  }
  return [...items.values()];
}

/** Moves the dot over `symbol` in every item that allows it. These are the kernel of GOTO. */
function gotoKernel(context: Context, items: readonly WorkItem[], symbol: string): WorkItem[] {
  return items
    .filter((item) => bodyOf(context, item.production)[item.dot] === symbol)
    .map((item) => ({
      production: item.production,
      dot: item.dot + 1,
      lookaheads: new Set(item.lookaheads),
      kernel: true,
    }))
    .sort((a, b) => a.production - b.production || a.dot - b.dot);
}

function finishItem(context: Context, item: WorkItem): LrItem {
  return {
    production: item.production,
    dot: item.dot,
    lookaheads: sortGrammarSymbols(context.order, item.lookaheads),
    kernel: item.kernel,
  };
}

function toWorkItem(item: Pick<LrItem, 'production' | 'dot'> & Partial<LrItem>): WorkItem {
  return {
    production: item.production,
    dot: item.dot,
    lookaheads: new Set(item.lookaheads ?? []),
    kernel: item.kernel ?? true,
  };
}

/** CLOSURE of a set of LR(0) items, for an augmented grammar. */
export function lr0Closure(
  augmented: Grammar,
  items: readonly Pick<LrItem, 'production' | 'dot'>[],
): LrItem[] {
  const context = makeContext(augmented, false);
  return closure(context, items.map(toWorkItem)).map((item) => finishItem(context, item));
}

/** GOTO(I, X) on LR(0) items: the closure of the items in I with the dot moved over X. */
export function lr0Goto(
  augmented: Grammar,
  items: readonly Pick<LrItem, 'production' | 'dot'>[],
  symbol: string,
): LrItem[] {
  const context = makeContext(augmented, false);
  const kernel = gotoKernel(context, items.map(toWorkItem), symbol);
  return closure(context, kernel).map((item) => finishItem(context, item));
}

/** CLOSURE of a set of LR(1) items, for an augmented grammar. */
export function lr1Closure(
  augmented: Grammar,
  items: readonly Pick<LrItem, 'production' | 'dot' | 'lookaheads'>[],
): LrItem[] {
  const context = makeContext(augmented, true);
  return closure(context, items.map(toWorkItem)).map((item) => finishItem(context, item));
}

/** GOTO(I, X) on LR(1) items. */
export function lr1Goto(
  augmented: Grammar,
  items: readonly Pick<LrItem, 'production' | 'dot' | 'lookaheads'>[],
  symbol: string,
): LrItem[] {
  const context = makeContext(augmented, true);
  const kernel = gotoKernel(context, items.map(toWorkItem), symbol);
  return closure(context, kernel).map((item) => finishItem(context, item));
}

function kernelKey(context: Context, kernel: readonly WorkItem[]): string {
  return kernel
    .map((item) => {
      const lookaheads = sortGrammarSymbols(context.order, item.lookaheads).join('\u0001');
      return `${itemKey(item)}\u0002${lookaheads}`;
    })
    .join('\u0003');
}

function tooManyStates(kind: LrAutomatonKind, limit: number): EngineError {
  return new EngineError({
    code: 'too_many_lr_states',
    message: `The ${kind === 'lr0' ? 'LR(0)' : 'canonical LR(1)'} collection for this grammar needs over ${limit} states.`,
    hint:
      kind === 'lr0'
        ? 'Try a smaller grammar.'
        : 'LR(1) collections can be far bigger than LR(0) ones. Try SLR(1), or a smaller grammar.',
  });
}

const baseStep = {
  stage: 'collection',
  filledRows: 0,
  conflictCount: 0,
} as const;

/** The canonical collection of sets of items: Dragon Book Figure 4.33 and Figure 4.40. */
function canonicalCollection(
  augmented: Grammar,
  kind: 'lr0' | 'lr1',
  maxStates: number,
): LrAutomaton {
  const context = makeContext(augmented, kind === 'lr1');
  const recorder = new TraceRecorder<LrBuildStep>(maxStates * 100);
  const closed: WorkItem[][] = [];
  const transitions: LrTransition[][] = [];
  const edges: LrEdge[] = [];
  const idOf = new Map<string, number>();

  const addState = (kernel: readonly WorkItem[]): number => {
    if (closed.length >= maxStates) throw tooManyStates(kind, maxStates);
    const id = closed.length;
    closed.push(closure(context, kernel));
    transitions.push([]);
    idOf.set(kernelKey(context, kernel), id);
    return id;
  };

  const start = kind === 'lr1' ? new Set([GRAMMAR_END_MARKER]) : new Set<string>();
  addState([{ production: 0, dot: 0, lookaheads: start, kernel: true }]);
  const firstItem = lrFormatItem(augmented, {
    production: 0,
    dot: 0,
    lookaheads: kind === 'lr1' ? [GRAMMAR_END_MARKER] : [],
    kernel: true,
  });
  recorder.add(
    'Start state I0',
    `Begin with [${firstItem}], which says the parser has seen nothing and expects a whole sentence. CLOSURE adds an item for each production of any nonterminal right after a dot, because expecting that nonterminal means expecting whatever it can start with.${kind === 'lr1' ? ' Each added item also records which terminal may follow it, its lookahead.' : ''}`,
    {
      ...baseStep,
      stateCount: 1,
      edgeCount: 0,
      activeState: 0,
      activeSymbol: null,
      target: null,
      created: true,
    },
  );

  for (let current = 0; current < closed.length; current++) {
    const items = closed[current] as WorkItem[];
    const symbols = new Set<string>();
    for (const item of items) {
      const next = bodyOf(context, item.production)[item.dot];
      if (next !== undefined) symbols.add(next);
    }
    for (const symbol of symbols) {
      const kernel = gotoKernel(context, items, symbol);
      const key = kernelKey(context, kernel);
      let target = idOf.get(key);
      const created = target === undefined;
      if (target === undefined) target = addState(kernel);
      (transitions[current] as LrTransition[]).push({ symbol, to: target });
      edges.push({ from: current, symbol, to: target });
      const moved = kernel
        .slice(0, 3)
        .map((item) => `[${lrFormatItem(augmented, finishItem(context, item))}]`)
        .join(', ');
      recorder.add(
        `GOTO(I${current}, ${symbol})`,
        `Moving the dot over ${symbol} in I${current} gives ${moved}${kernel.length > 3 ? ' and more' : ''}. ${created ? `That is a new set of items, so it becomes I${target}.` : `That is the same set as I${target}, so no new state is needed.`}`,
        {
          ...baseStep,
          stateCount: closed.length,
          edgeCount: edges.length,
          activeState: current,
          activeSymbol: symbol,
          target,
          created,
        },
      );
    }
  }

  const states: LrState[] = closed.map((items, id) => ({
    id,
    label: String(id),
    items: items.map((item) => finishItem(context, item)),
    transitions: transitions[id] as LrTransition[],
    sources: [id],
  }));
  recorder.add(
    'The collection is complete',
    `No set of items has a new GOTO left, so the ${kind === 'lr1' ? 'canonical LR(1)' : 'LR(0)'} automaton has ${states.length} state${states.length === 1 ? '' : 's'}.`,
    {
      ...baseStep,
      stateCount: states.length,
      edgeCount: edges.length,
      activeState: null,
      activeSymbol: null,
      target: null,
      created: false,
    },
  );

  const acceptState =
    transitions[0]?.find(({ symbol }) => symbol === (augmented.productions[0]?.body[0] as string))
      ?.to ?? 0;
  return {
    kind,
    grammar: augmented,
    states,
    edges,
    acceptState,
    canonicalStateCount: states.length,
    trace: recorder.finish(),
  };
}

const coreKey = (state: LrState) =>
  state.items
    .filter((item) => item.kernel)
    .map(itemKey)
    .join(',');

const mergedLabel = (sources: readonly number[]) =>
  sources.length === 1
    ? String(sources[0])
    : sources.join(sources.every((source) => source < 10) ? '' : ',');

/**
 * Dragon Book Algorithm 4.59: build the canonical LR(1) collection, then merge states that have the
 * same core, uniting their lookaheads. Merging can create a reduce/reduce conflict that was not
 * there before, but never a shift/reduce one.
 */
function mergeIntoLalr(canonical: LrAutomaton): LrAutomaton {
  const context = makeContext(canonical.grammar, false);
  const groups: LrState[][] = [];
  const groupOf = new Map<number, number>();
  const groupByCore = new Map<string, number>();
  for (const state of canonical.states) {
    const key = coreKey(state);
    let group = groupByCore.get(key);
    if (group === undefined) {
      group = groups.length;
      groups.push([]);
      groupByCore.set(key, group);
    }
    (groups[group] as LrState[]).push(state);
    groupOf.set(state.id, group);
  }

  const states: LrState[] = groups.map((members, id) => {
    const first = members[0] as LrState;
    const lookaheads = new Map(first.items.map((item) => [itemKey(item), new Set<string>()]));
    for (const member of members) {
      for (const item of member.items) {
        for (const terminal of item.lookaheads) lookaheads.get(itemKey(item))?.add(terminal);
      }
    }
    const sources = members.map(({ id: source }) => source);
    return {
      id,
      label: mergedLabel(sources),
      items: first.items.map((item) => ({
        ...item,
        lookaheads: sortGrammarSymbols(context.order, lookaheads.get(itemKey(item)) ?? []),
      })),
      transitions: first.transitions.map(({ symbol, to }) => ({
        symbol,
        to: groupOf.get(to) as number,
      })),
      sources,
    };
  });
  const edges: LrEdge[] = states.flatMap((state) =>
    state.transitions.map(({ symbol, to }) => ({ from: state.id, symbol, to })),
  );

  const recorder = new TraceRecorder<LrBuildStep>(states.length + 2);
  recorder.add(
    'Start from the canonical LR(1) collection',
    `The canonical LR(1) collection for this grammar has ${canonical.states.length} state${canonical.states.length === 1 ? '' : 's'}. Many of them differ only in their lookaheads. Two states have the same core when their items match with the lookaheads ignored, and LALR(1) merges all such states into one.`,
    {
      ...baseStep,
      stateCount: 0,
      edgeCount: 0,
      activeState: null,
      activeSymbol: null,
      target: null,
      created: false,
    },
  );
  let edgeCount = 0;
  states.forEach((state, id) => {
    edgeCount += state.transitions.length;
    recorder.add(
      state.sources.length > 1
        ? `Merge ${state.sources.map((source) => `I${source}`).join(' and ')}`
        : `Keep I${state.label}`,
      state.sources.length > 1
        ? `These canonical states have the same core, so they become one state, ${state.label}, whose lookaheads are the union of theirs. Their GOTOs agree too, because GOTO only depends on the core.`
        : `No other canonical state has the same core as I${state.label}, so it carries over as it is.`,
      {
        ...baseStep,
        stateCount: id + 1,
        edgeCount,
        activeState: id,
        activeSymbol: null,
        target: null,
        created: true,
      },
    );
  });
  recorder.add(
    'The LALR(1) automaton is complete',
    `${canonical.states.length} canonical states merged into ${states.length} LALR(1) state${states.length === 1 ? '' : 's'}. That is the same number of states an LR(0) automaton of this grammar has, because LALR states are the LR(0) states with lookaheads attached.`,
    {
      ...baseStep,
      stateCount: states.length,
      edgeCount: edges.length,
      activeState: null,
      activeSymbol: null,
      target: null,
      created: false,
    },
  );

  return {
    kind: 'lalr',
    grammar: canonical.grammar,
    states,
    edges,
    acceptState: groupOf.get(canonical.acceptState) as number,
    canonicalStateCount: canonical.states.length,
    trace: recorder.finish(),
  };
}

/**
 * Builds the LR automaton of a grammar, which is augmented first. `lr0` is the canonical collection
 * of LR(0) items, `lr1` the canonical collection of LR(1) items, and `lalr` the second one merged.
 */
export function lrBuildAutomaton(
  grammar: Grammar,
  kind: LrAutomatonKind,
  maxStates: number = MAX_LR_STATES,
): LrAutomaton {
  const augmented = lrAugmentGrammar(grammar);
  if (kind === 'lr0') return canonicalCollection(augmented, 'lr0', maxStates);
  const canonical = canonicalCollection(augmented, 'lr1', maxStates);
  return kind === 'lr1' ? canonical : mergeIntoLalr(canonical);
}
