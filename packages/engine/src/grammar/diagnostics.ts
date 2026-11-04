import { formatGrammarProduction, indexGrammar } from './cfg';
import { grammarSetMaps } from './sets';
import type { Grammar, GrammarWarning } from './types';

export type GrammarLeftRecursionKind = 'immediate' | 'indirect' | 'hidden';

export interface GrammarLeftRecursion {
  readonly symbol: string;
  /**
   * `immediate` is A → A α. `indirect` goes through other nonterminals, as A → B x, B → A y.
   * `hidden` needs a nullable symbol to vanish first, as A → B A x with B nullable.
   */
  readonly kind: GrammarLeftRecursionKind;
  /** A path of nonterminals from the symbol back to itself. */
  readonly path: readonly string[];
}

function shortestCycle(
  start: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  const parent = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    for (const next of edges.get(current) ?? []) {
      if (next === start) {
        const path = [current];
        for (let at = current; at !== start; at = parent.get(at) as string) {
          path.unshift(parent.get(at) as string);
        }
        return [...path, start];
      }
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Every left-recursive nonterminal: those with a derivation A ⇒+ A α. */
export function grammarLeftRecursion(grammar: Grammar): GrammarLeftRecursion[] {
  const maps = grammarSetMaps(grammar);
  const firstOnly = new Map(grammar.nonterminals.map((name) => [name, new Set<string>()]));
  const anyVanishing = new Map(grammar.nonterminals.map((name) => [name, new Set<string>()]));
  for (const { head, body } of grammar.productions) {
    for (const [index, symbol] of body.entries()) {
      if (!maps.nonterminals.has(symbol)) break;
      if (index === 0) firstOnly.get(head)?.add(symbol);
      anyVanishing.get(head)?.add(symbol);
      if (!maps.nullable.has(symbol)) break;
    }
  }
  const found: GrammarLeftRecursion[] = [];
  for (const symbol of grammar.nonterminals) {
    if (firstOnly.get(symbol)?.has(symbol)) {
      found.push({ symbol, kind: 'immediate', path: [symbol, symbol] });
      continue;
    }
    const indirect = shortestCycle(symbol, firstOnly);
    if (indirect) {
      found.push({ symbol, kind: 'indirect', path: indirect });
      continue;
    }
    const hidden = shortestCycle(symbol, anyVanishing);
    if (hidden) found.push({ symbol, kind: 'hidden', path: hidden });
  }
  return found;
}

/** Nonterminals with a derivation A ⇒+ A. Such a grammar is ambiguous and defeats every parser. */
export function grammarCycles(grammar: Grammar): string[] {
  const maps = grammarSetMaps(grammar);
  const edges = new Map(grammar.nonterminals.map((name) => [name, new Set<string>()]));
  for (const { head, body } of grammar.productions) {
    for (const [index, symbol] of body.entries()) {
      if (!maps.nonterminals.has(symbol)) continue;
      const othersVanish = body.every(
        (other, otherIndex) => otherIndex === index || maps.nullable.has(other),
      );
      if (othersVanish) edges.get(head)?.add(symbol);
    }
  }
  return grammar.nonterminals.filter((name) => shortestCycle(name, edges) !== null);
}

/** Nonterminals that can derive some string of terminals. */
export function grammarProductiveSymbols(grammar: Grammar): Set<string> {
  const { nonterminals } = indexGrammar(grammar);
  const productive = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { head, body } of grammar.productions) {
      if (productive.has(head)) continue;
      if (body.every((symbol) => !nonterminals.has(symbol) || productive.has(symbol))) {
        productive.add(head);
        changed = true;
      }
    }
  }
  return productive;
}

/** Nonterminals that appear in some sentential form derived from the start symbol. */
export function grammarReachableSymbols(grammar: Grammar): Set<string> {
  const { nonterminals, byHead } = indexGrammar(grammar);
  const reachable = new Set([grammar.start]);
  const pending = [grammar.start];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const { body } of byHead.get(at) ?? []) {
      for (const symbol of body) {
        if (nonterminals.has(symbol) && !reachable.has(symbol)) {
          reachable.add(symbol);
          pending.push(symbol);
        }
      }
    }
  }
  return reachable;
}

/** Everything worth telling a student about a grammar before they use it. */
export function grammarDiagnostics(grammar: Grammar): GrammarWarning[] {
  const warnings: GrammarWarning[] = [...grammar.warnings];
  const { byHead } = indexGrammar(grammar);

  const productive = grammarProductiveSymbols(grammar);
  const reachable = grammarReachableSymbols(grammar);
  for (const symbol of grammar.nonterminals) {
    if (!productive.has(symbol)) {
      warnings.push({
        code: 'nonproductive',
        message: `${symbol} can never finish: every one of its derivations keeps a nonterminal forever, so it derives no string of terminals.`,
        symbols: [symbol],
      });
    }
    if (!reachable.has(symbol)) {
      warnings.push({
        code: 'unreachable',
        message: `${symbol} is unreachable: no derivation from ${grammar.start} ever uses it.`,
        symbols: [symbol],
      });
    }
  }

  for (const { symbol, kind, path } of grammarLeftRecursion(grammar)) {
    const route =
      kind === 'immediate'
        ? 'One of its productions starts with itself.'
        : kind === 'indirect'
          ? `It gets back to itself through ${path.join(' ⇒ ')}.`
          : `It gets back to itself through ${path.join(' ⇒ ')}, after a nullable symbol vanishes.`;
    warnings.push({
      code: `left_recursion_${kind}`,
      message: `${symbol} is left recursive. ${route} A top-down parser would call ${symbol} forever without reading any input.`,
      symbols: [symbol],
    });
  }

  for (const symbol of grammarCycles(grammar)) {
    warnings.push({
      code: 'cycle',
      message: `${symbol} has a cycle: it can derive just itself, so any sentence that uses it has endless parse trees.`,
      symbols: [symbol],
    });
  }

  for (const [head, productions] of byHead) {
    const groups = new Map<string, number>();
    for (const { body } of productions) {
      const first = body[0];
      if (first !== undefined) groups.set(first, (groups.get(first) ?? 0) + 1);
    }
    const shared = [...groups].filter(([, count]) => count > 1).map(([symbol]) => symbol);
    if (shared.length > 0) {
      const examples = productions
        .filter(({ body }) => body[0] !== undefined && shared.includes(body[0]))
        .slice(0, 3)
        .map(formatGrammarProduction)
        .join(', ');
      warnings.push({
        code: 'common_prefix',
        message: `${head} has alternatives that start the same way (${examples}), so one token of lookahead cannot choose between them. Left factoring fixes this.`,
        symbols: [head],
      });
    }
  }
  return warnings;
}
