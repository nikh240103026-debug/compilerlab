import { EngineError } from '../core/result';
import { indexGrammar } from './cfg';
import { ForestBuilder } from './forest';
import {
  GRAMMAR_EPSILON,
  type Grammar,
  type GrammarParseNode,
  type GrammarParseTree,
  type GrammarProduction,
} from './types';

/*
 * Tables shared by the general parser here and the ambiguity search. Each entry holds at most two
 * derivations of one nonterminal over one piece of text, because two is all it takes to prove
 * ambiguity. A derivation names its children by table key, plus which of their derivations it uses.
 * It can only name one that already exists, so a tree built from them always ends, even in a
 * grammar with a cycle like A → A.
 */

export type ChartChild =
  | { readonly terminal: string }
  | { readonly nonterminal: string; readonly key: string; readonly which: number };

export interface ChartDerivation {
  readonly production: number;
  readonly children: readonly ChartChild[];
  readonly signature: string;
}

export type ChartTable = Map<string, ChartDerivation[]>;

const MAX_DERIVATIONS = 2;

/** Adds a derivation unless the entry is full or has it already. Returns whether it was added. */
export function addChartDerivation(
  table: ChartTable,
  key: string,
  derivation: ChartDerivation,
): boolean {
  let entry = table.get(key);
  if (!entry) {
    entry = [];
    table.set(key, entry);
  }
  if (entry.length >= MAX_DERIVATIONS) return false;
  if (entry.some(({ signature }) => signature === derivation.signature)) return false;
  entry.push(derivation);
  return true;
}

/** Facts about the part of a grammar that can actually take part in a sentence. */
export interface GrammarUsefulInfo {
  /** The fewest terminals each productive nonterminal can derive. */
  readonly minLength: ReadonlyMap<string, number>;
  /** A production that achieves it. Following these always ends, even with cycles around. */
  readonly minProduction: ReadonlyMap<string, GrammarProduction>;
  /** Productions of reachable nonterminals whose symbols are all productive. */
  readonly useful: readonly GrammarProduction[];
  /** For each production, the fewest terminals its body from each index on can derive. */
  readonly restLength: ReadonlyMap<number, readonly number[]>;
  /** A way to reach each useful nonterminal from the start symbol. */
  readonly reachedBy: ReadonlyMap<string, { production: GrammarProduction; position: number }>;
  readonly isNonterminal: (symbol: string) => boolean;
}

export function grammarUsefulInfo(grammar: Grammar): GrammarUsefulInfo {
  const { nonterminals, byHead } = indexGrammar(grammar);
  const minLength = new Map<string, number>();
  const minProduction = new Map<string, GrammarProduction>();
  const bodyLength = (body: readonly string[]) => {
    let total = 0;
    for (const symbol of body) {
      total += nonterminals.has(symbol) ? (minLength.get(symbol) ?? Infinity) : 1;
    }
    return total;
  };
  // Updates only on a strict improvement, which is what keeps these choices free of cycles.
  let changed = true;
  while (changed) {
    changed = false;
    for (const production of grammar.productions) {
      const length = bodyLength(production.body);
      if (length < (minLength.get(production.head) ?? Infinity)) {
        minLength.set(production.head, length);
        minProduction.set(production.head, production);
        changed = true;
      }
    }
  }

  const useful: GrammarProduction[] = [];
  const reachedBy = new Map<string, { production: GrammarProduction; position: number }>();
  if (minLength.has(grammar.start)) {
    const reached = new Set([grammar.start]);
    const queue = [grammar.start];
    for (let head = 0; head < queue.length; head++) {
      for (const production of byHead.get(queue[head] as string) ?? []) {
        if (bodyLength(production.body) === Infinity) continue;
        useful.push(production);
        for (const [position, symbol] of production.body.entries()) {
          if (nonterminals.has(symbol) && !reached.has(symbol)) {
            reached.add(symbol);
            reachedBy.set(symbol, { production, position });
            queue.push(symbol);
          }
        }
      }
    }
  }

  const restLength = new Map<number, readonly number[]>();
  for (const production of useful) {
    const rest = new Array<number>(production.body.length + 1).fill(0);
    for (let index = production.body.length - 1; index >= 0; index--) {
      const symbol = production.body[index] as string;
      rest[index] =
        (rest[index + 1] as number) +
        (nonterminals.has(symbol) ? (minLength.get(symbol) as number) : 1);
    }
    restLength.set(production.id, rest);
  }

  return {
    minLength,
    minProduction,
    useful,
    restLength,
    reachedBy,
    isNonterminal: (symbol) => nonterminals.has(symbol),
  };
}

interface TreeCounters {
  token: number;
}

function addDerivation(
  forest: ForestBuilder,
  table: ChartTable,
  symbol: string,
  key: string,
  which: number,
  parent: number | null,
  counters: TreeCounters,
): number {
  const id = forest.add(symbol, 'nonterminal', { parent });
  const derivation = (table.get(key) as ChartDerivation[])[which] as ChartDerivation;
  const children: number[] = [];
  if (derivation.children.length === 0) {
    children.push(forest.add(GRAMMAR_EPSILON, 'epsilon', { parent: id }));
  }
  for (const child of derivation.children) {
    if ('terminal' in child) {
      children.push(
        forest.add(child.terminal, 'terminal', { parent: id, token: counters.token++ }),
      );
    } else {
      children.push(
        addDerivation(forest, table, child.nonterminal, child.key, child.which, id, counters),
      );
    }
  }
  forest.adopt(id, derivation.production, children);
  return id;
}

/** Builds the shortest derivation of a nonterminal, using the productions `grammarUsefulInfo` chose. */
function addMinimal(
  forest: ForestBuilder,
  info: GrammarUsefulInfo,
  symbol: string,
  parent: number,
  counters: TreeCounters,
): number {
  if (!info.isNonterminal(symbol)) {
    return forest.add(symbol, 'terminal', { parent, token: counters.token++ });
  }
  const id = forest.add(symbol, 'nonterminal', { parent });
  const production = info.minProduction.get(symbol) as GrammarProduction;
  const children =
    production.body.length === 0
      ? [forest.add(GRAMMAR_EPSILON, 'epsilon', { parent: id })]
      : production.body.map((child) => addMinimal(forest, info, child, id, counters));
  forest.adopt(id, production.id, children);
  return id;
}

/**
 * A parse tree for the whole sentence with one chosen derivation at `target`. If `target` is not
 * the start symbol, the tree around it comes from the shortest path down from the start symbol,
 * and every other nonterminal on the way takes its shortest derivation.
 */
export function buildChartTree(
  grammar: Grammar,
  info: GrammarUsefulInfo,
  table: ChartTable,
  target: string,
  key: string,
  which: number,
): GrammarParseTree {
  const path: { production: GrammarProduction; position: number }[] = [];
  for (let at = target; at !== grammar.start;) {
    const link = info.reachedBy.get(at) as { production: GrammarProduction; position: number };
    path.unshift(link);
    at = link.production.head;
  }

  const forest = new ForestBuilder();
  const counters: TreeCounters = { token: 0 };
  const descend = (depth: number, symbol: string, parent: number | null): number => {
    const link = path[depth];
    if (!link) return addDerivation(forest, table, symbol, key, which, parent, counters);
    const id = forest.add(symbol, 'nonterminal', { parent });
    const children = link.production.body.map((child, position) =>
      position === link.position
        ? descend(depth + 1, child, id)
        : addMinimal(forest, info, child, id, counters),
    );
    forest.adopt(id, link.production.id, children);
    return id;
  };
  const root = descend(0, grammar.start, null);
  return { nodes: forest.finish() as readonly GrammarParseNode[], root };
}

export interface GrammarChartResult {
  readonly tokens: readonly string[];
  readonly accepted: boolean;
  /** No trees if the sentence is not in the language, one if it has exactly one, else two. */
  readonly trees: readonly GrammarParseTree[];
  /** Exact, not a bound: this looked at every way of parsing this one sentence. */
  readonly ambiguous: boolean;
}

export const MAX_CHART_TOKENS = 80;
const MAX_CHART_WORK = 4_000_000;

/**
 * A general parser for any context-free grammar, including left-recursive and ambiguous ones. For
 * each span of the input, shortest first, it works out which nonterminals derive that span, the
 * way CYK does, but without first converting the grammar to Chomsky normal form.
 */
export function grammarChartParse(grammar: Grammar, tokens: readonly string[]): GrammarChartResult {
  if (tokens.length > MAX_CHART_TOKENS) {
    throw new EngineError({
      code: 'chart_input_too_long',
      message: `This sentence has over ${MAX_CHART_TOKENS} tokens, too many for the general parser.`,
      hint: 'Try a shorter sentence.',
    });
  }
  const info = grammarUsefulInfo(grammar);
  const table: ChartTable = new Map();
  const count = tokens.length;
  const spanKey = (symbol: string, from: number, to: number) => `${symbol}|${from}|${to}`;
  let work = 0;

  for (let length = 0; length <= count; length++) {
    for (let from = 0; from + length <= count; from++) {
      const to = from + length;
      let changed = true;
      const walk = (
        production: GrammarProduction,
        rest: readonly number[],
        index: number,
        at: number,
        children: readonly ChartChild[],
      ): void => {
        if (++work > MAX_CHART_WORK) {
          throw new EngineError({
            code: 'chart_too_slow',
            message: 'This grammar and sentence need too much work for the general parser.',
            hint: 'Try a shorter sentence.',
          });
        }
        const symbol = production.body[index];
        if (symbol === undefined) {
          if (at !== to) return;
          const signature = `${production.id}/${children
            .map((child) => ('terminal' in child ? 't' : `${child.key}#${child.which}`))
            .join(',')}`;
          const added = addChartDerivation(table, spanKey(production.head, from, to), {
            production: production.id,
            children,
            signature,
          });
          if (added) changed = true;
          return;
        }
        const after = rest[index + 1] as number;
        if (!info.isNonterminal(symbol)) {
          if (at + 1 + after <= to && tokens[at] === symbol) {
            walk(production, rest, index + 1, at + 1, [...children, { terminal: symbol }]);
          }
          return;
        }
        const shortest = info.minLength.get(symbol) as number;
        for (let end = at + shortest; end + after <= to; end++) {
          const key = spanKey(symbol, at, end);
          const entry = table.get(key);
          if (!entry) continue;
          for (let which = 0; which < entry.length; which++) {
            walk(production, rest, index + 1, end, [
              ...children,
              { nonterminal: symbol, key, which },
            ]);
          }
        }
      };

      // Within one span, one nonterminal can depend on another through a unit or nullable step.
      while (changed) {
        changed = false;
        for (const production of info.useful) {
          const rest = info.restLength.get(production.id) as readonly number[];
          if ((rest[0] as number) <= length) walk(production, rest, 0, from, []);
        }
      }
    }
  }

  const rootKey = spanKey(grammar.start, 0, count);
  const entry = table.get(rootKey) ?? [];
  const trees = entry.map((_, which) =>
    buildChartTree(grammar, info, table, grammar.start, rootKey, which),
  );
  return { tokens, accepted: trees.length > 0, trees, ambiguous: trees.length > 1 };
}
