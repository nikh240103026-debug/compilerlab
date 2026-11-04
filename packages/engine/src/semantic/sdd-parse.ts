import { EngineError } from '../core/result';
import {
  SDD_IDENTIFIER_TERMINALS,
  SDD_NUMBER_TERMINALS,
  type SddOccurrence,
  type SddProduction,
  type SddSpec,
} from './sdd-spec';

// Reads the input with the definition's own grammar. Students write grammars with left recursion
// and ε on purpose, because that is how the book writes them, so this has to take any CFG. An
// Earley chart does that in a few lines, and no parser table is needed.

export const MAX_SDD_INPUT_TOKENS = 300;
export const MAX_SDD_TREE_NODES = 2000;
const MAX_EARLEY_ITEMS = 200_000;
const MAX_TREE_SEARCH = 200_000;

export interface SddToken {
  text: string;
  start: number;
  end: number;
  numeric: boolean;
  identifier: boolean;
}

export interface SddTreeNode {
  id: number;
  /** The grammar symbol, like E. */
  symbol: string;
  /** How the parent's production wrote it, like E1. */
  written: string;
  kind: 'nonterminal' | 'terminal' | 'epsilon';
  parent: number | null;
  children: number[];
  /** The production used here, for a nonterminal. */
  production: number | null;
  /** The token matched here, for a terminal. */
  token: number | null;
  lexeme: string | null;
  /** The tokens this node covers: tokens[from..to). */
  from: number;
  to: number;
}

export interface SddParseTree {
  tokens: SddToken[];
  /** Every node, in preorder, with its id as its index. */
  nodes: SddTreeNode[];
  root: number;
  warnings: string[];
}

function byHead(spec: SddSpec): Map<string, SddProduction[]> {
  const map = new Map<string, SddProduction[]>();
  for (const production of spec.productions) {
    map.set(production.head, [...(map.get(production.head) ?? []), production]);
  }
  return map;
}

function literalTerminals(spec: SddSpec): string[] {
  return spec.terminals.filter(
    (terminal) =>
      !SDD_NUMBER_TERMINALS.includes(terminal) && !SDD_IDENTIFIER_TERMINALS.includes(terminal),
  );
}

/** Splits the input using the terminals the grammar actually has. */
export function sddTokenize(spec: SddSpec, input: string): SddToken[] {
  const literals = literalTerminals(spec).toSorted((a, b) => b.length - a.length);
  const punctuation = literals.filter((text) => !/^[A-Za-z0-9_]/.test(text));
  const words = literals.filter((text) => /^[A-Za-z0-9_]/.test(text));
  const hasNumbers = spec.terminals.some((terminal) => SDD_NUMBER_TERMINALS.includes(terminal));
  const hasNames = spec.terminals.some((terminal) => SDD_IDENTIFIER_TERMINALS.includes(terminal));

  const tokens: SddToken[] = [];
  let at = 0;
  while (at < input.length) {
    const char = input[at] as string;
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    let text = punctuation.find((candidate) => input.startsWith(candidate, at));
    if (text === undefined) {
      const rest = input.slice(at, at + 64);
      const number = /^[0-9]+(?:\.[0-9]+)?/.exec(rest);
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      // With no number or id class in the grammar, a run like aabb means a, a, b, b.
      const useWhole = number ? hasNumbers : hasNames;
      if ((number || name) && !useWhole) {
        text = words.find((candidate) => input.startsWith(candidate, at));
      }
      text ??= number?.[0] ?? name?.[0] ?? String.fromCodePoint(input.codePointAt(at) as number);
    }
    tokens.push({
      text,
      start: at,
      end: at + text.length,
      numeric: /^[0-9]/.test(text),
      identifier: /^[A-Za-z_]/.test(text),
    });
    at += text.length;
    if (tokens.length > MAX_SDD_INPUT_TOKENS) {
      throw new EngineError({
        code: 'sdd_input_too_long',
        message: `This input has more than ${MAX_SDD_INPUT_TOKENS} tokens.`,
        hint: 'Try a shorter input. Each token adds nodes and attributes to the tree.',
        position: at,
      });
    }
  }
  return tokens;
}

function tokenMatcher(spec: SddSpec): (token: SddToken, terminal: string) => boolean {
  const literals = new Set(literalTerminals(spec));
  return (token, terminal) => {
    if (SDD_NUMBER_TERMINALS.includes(terminal)) return token.numeric;
    if (SDD_IDENTIFIER_TERMINALS.includes(terminal)) {
      return token.identifier && !literals.has(token.text);
    }
    return token.text === terminal;
  };
}

function nullableSet(spec: SddSpec): Set<string> {
  const nullable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { head, body } of spec.productions) {
      if (nullable.has(head)) continue;
      if (body.every((symbol) => !symbol.terminal && nullable.has(symbol.symbol))) {
        nullable.add(head);
        changed = true;
      }
    }
  }
  return nullable;
}

interface EarleyItem {
  rule: number;
  dot: number;
  origin: number;
}

/**
 * Runs the Earley recognizer. It returns, for each `symbol@start`, every end position it can
 * reach, largest first. The predictor also steps over nullable symbols (Aycock and Horspool), so
 * ε-productions need no second pass.
 */
function earley(
  spec: SddSpec,
  tokens: SddToken[],
  input: string,
  rules: Map<string, SddProduction[]>,
  matches: (token: SddToken, terminal: string) => boolean,
): Map<string, number[]> {
  const count = tokens.length;
  const nullable = nullableSet(spec);
  const longestBody = Math.max(...spec.productions.map((production) => production.body.length));
  const charts: EarleyItem[][] = Array.from({ length: count + 1 }, () => []);
  const seen: Set<number>[] = Array.from({ length: count + 1 }, () => new Set());
  const ends = new Map<string, Set<number>>();
  let total = 0;

  const add = (position: number, item: EarleyItem): void => {
    const key = (item.rule * (longestBody + 1) + item.dot) * (count + 1) + item.origin;
    const set = seen[position] as Set<number>;
    if (set.has(key)) return;
    set.add(key);
    (charts[position] as EarleyItem[]).push(item);
    if (++total > MAX_EARLEY_ITEMS) {
      throw new EngineError({
        code: 'sdd_input_too_hard',
        message: 'This grammar and input need too much work to parse.',
        hint: 'Try a shorter input, or a less ambiguous grammar.',
      });
    }
  };

  for (const production of rules.get(spec.start) as SddProduction[]) {
    add(0, { rule: production.index, dot: 0, origin: 0 });
  }
  for (let position = 0; position <= count; position++) {
    const chart = charts[position] as EarleyItem[];
    // The chart grows while this loop runs, so a plain index loop is what is wanted.
    for (let i = 0; i < chart.length; i++) {
      const item = chart[i] as EarleyItem;
      const production = spec.productions[item.rule] as SddProduction;
      const next = production.body[item.dot];
      if (!next) {
        const key = `${production.head}@${item.origin}`;
        ends.set(key, (ends.get(key) ?? new Set()).add(position));
        for (const waiting of charts[item.origin] as EarleyItem[]) {
          const wanted = (spec.productions[waiting.rule] as SddProduction).body[waiting.dot];
          if (wanted && !wanted.terminal && wanted.symbol === production.head) {
            add(position, { ...waiting, dot: waiting.dot + 1 });
          }
        }
      } else if (next.terminal) {
        const token = tokens[position];
        if (token && matches(token, next.symbol)) {
          add(position + 1, { ...item, dot: item.dot + 1 });
        }
      } else {
        for (const predicted of rules.get(next.symbol) as SddProduction[]) {
          add(position, { rule: predicted.index, dot: 0, origin: position });
        }
        if (nullable.has(next.symbol)) add(position, { ...item, dot: item.dot + 1 });
      }
    }
  }

  if (!ends.get(`${spec.start}@0`)?.has(count)) {
    let furthest = count;
    while (furthest > 0 && (charts[furthest] as EarleyItem[]).length === 0) furthest--;
    const expected = new Set<string>();
    for (const item of charts[furthest] as EarleyItem[]) {
      const next = (spec.productions[item.rule] as SddProduction).body[item.dot];
      if (next?.terminal) expected.add(next.symbol);
    }
    const token = tokens[furthest];
    const wanted = expected.size > 0 ? [...expected].join(', ') : 'nothing more';
    throw new EngineError({
      code: 'sdd_input_syntax',
      message: token
        ? `The input stops fitting the grammar at "${token.text}".`
        : 'The input ends before the grammar is satisfied.',
      hint: `At this point the grammar expects: ${wanted}.`,
      position: token ? token.start : input.length,
      length: token ? token.end - token.start : 0,
    });
  }

  const sorted = new Map<string, number[]>();
  for (const [key, set] of ends)
    sorted.set(
      key,
      [...set].toSorted((a, b) => b - a),
    );
  return sorted;
}

interface Shape {
  symbol: string;
  production: number | null;
  token: number | null;
  children: Shape[];
  from: number;
  to: number;
}

/** Turns the chart into one tree. Ties prefer earlier productions and longer left parts. */
function buildShape(
  spec: SddSpec,
  tokens: SddToken[],
  rules: Map<string, SddProduction[]>,
  matches: (token: SddToken, terminal: string) => boolean,
  ends: Map<string, number[]>,
): Shape {
  const memo = new Map<string, Shape>();
  const inProgress = new Set<string>();
  const finishable = new Map<string, boolean>();
  let budget = MAX_TREE_SEARCH;

  const endsOf = (symbol: string, position: number): number[] =>
    ends.get(`${symbol}@${position}`) ?? [];

  const canFinish = (
    production: SddProduction,
    index: number,
    at: number,
    end: number,
  ): boolean => {
    const symbol = production.body[index];
    if (!symbol) return at === end;
    const key = `${production.index}:${index}:${at}:${end}`;
    const known = finishable.get(key);
    if (known !== undefined) return known;
    let result = false;
    if (symbol.terminal) {
      const token = tokens[at];
      result =
        at < end &&
        token !== undefined &&
        matches(token, symbol.symbol) &&
        canFinish(production, index + 1, at + 1, end);
    } else {
      result = endsOf(symbol.symbol, at).some(
        (next) => next <= end && canFinish(production, index + 1, next, end),
      );
    }
    finishable.set(key, result);
    return result;
  };

  const buildBody = (
    production: SddProduction,
    index: number,
    at: number,
    end: number,
  ): Shape[] | null => {
    if (--budget < 0) {
      throw new EngineError({
        code: 'sdd_input_too_hard',
        message: 'This grammar is too ambiguous for this input to pick one tree.',
        hint: 'Try a shorter input, or remove the ambiguity from the grammar.',
      });
    }
    const symbol = production.body[index];
    if (!symbol) return at === end ? [] : null;
    if (!canFinish(production, index, at, end)) return null;
    if (symbol.terminal) {
      const rest = buildBody(production, index + 1, at + 1, end);
      if (!rest) return null;
      const leaf: Shape = {
        symbol: symbol.symbol,
        production: null,
        token: at,
        children: [],
        from: at,
        to: at + 1,
      };
      return [leaf, ...rest];
    }
    for (const next of endsOf(symbol.symbol, at)) {
      if (next > end) continue;
      const child = buildNonterminal(symbol.symbol, at, next);
      if (!child) continue;
      const rest = buildBody(production, index + 1, next, end);
      if (rest) return [child, ...rest];
    }
    return null;
  };

  const buildNonterminal = (symbol: string, from: number, to: number): Shape | null => {
    const key = `${symbol}@${from}:${to}`;
    const done = memo.get(key);
    if (done) return done;
    // A unit cycle like A -> A would never end, so a node cannot sit inside itself.
    if (inProgress.has(key)) return null;
    inProgress.add(key);
    let result: Shape | null = null;
    for (const production of rules.get(symbol) as SddProduction[]) {
      const children = buildBody(production, 0, from, to);
      if (children) {
        result = { symbol, production: production.index, token: null, children, from, to };
        break;
      }
    }
    inProgress.delete(key);
    if (result) memo.set(key, result);
    return result;
  };

  return buildNonterminal(spec.start, 0, tokens.length) as Shape;
}

/** Whether a node has more than one way to split, which is what makes a grammar ambiguous here. */
function ambiguityWarning(
  tokens: SddToken[],
  nodes: SddTreeNode[],
  rules: Map<string, SddProduction[]>,
  matches: (token: SddToken, terminal: string) => boolean,
  ends: Map<string, number[]>,
): string | null {
  const memo = new Map<string, number>();
  const ways = (production: SddProduction, index: number, at: number, end: number): number => {
    const symbol = production.body[index];
    if (!symbol) return at === end ? 1 : 0;
    const key = `${production.index}:${index}:${at}:${end}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let total = 0;
    if (symbol.terminal) {
      const token = tokens[at];
      if (at < end && token && matches(token, symbol.symbol)) {
        total = ways(production, index + 1, at + 1, end);
      }
    } else {
      for (const next of ends.get(`${symbol.symbol}@${at}`) ?? []) {
        if (next <= end) total += ways(production, index + 1, next, end);
        if (total >= 2) break;
      }
    }
    memo.set(key, Math.min(total, 2));
    return Math.min(total, 2);
  };
  for (const node of nodes) {
    if (node.kind !== 'nonterminal') continue;
    let total = 0;
    for (const production of rules.get(node.symbol) as SddProduction[]) {
      total += ways(production, 0, node.from, node.to);
    }
    if (total > 1) {
      const text = tokens
        .slice(node.from, node.to)
        .map((token) => token.text)
        .join(' ');
      return `This grammar is ambiguous here: ${node.symbol} can derive "${text}" in more than one way. This tree uses the first production that fits and the longest left part. Changing the grammar could change the attribute values.`;
    }
  }
  return null;
}

/** Parses the input with the definition's grammar, and returns the tree as flat, plain data. */
export function sddParseInput(spec: SddSpec, input: string): SddParseTree {
  const tokens = sddTokenize(spec, input);
  const rules = byHead(spec);
  const matches = tokenMatcher(spec);
  const ends = earley(spec, tokens, input, rules, matches);
  const shape = buildShape(spec, tokens, rules, matches, ends);

  const nodes: SddTreeNode[] = [];
  const addNode = (node: Omit<SddTreeNode, 'id'>): SddTreeNode => {
    if (nodes.length >= MAX_SDD_TREE_NODES) {
      throw new EngineError({
        code: 'sdd_input_too_long',
        message: `The parse tree would have more than ${MAX_SDD_TREE_NODES} nodes.`,
        hint: 'Try a shorter input.',
      });
    }
    const created = { ...node, id: nodes.length };
    nodes.push(created);
    return created;
  };
  const flatten = (current: Shape, written: string, parent: number | null): number => {
    const isLeaf = current.token !== null;
    const node = addNode({
      symbol: current.symbol,
      written,
      kind: isLeaf ? 'terminal' : 'nonterminal',
      parent,
      children: [],
      production: current.production,
      token: current.token,
      lexeme: isLeaf ? (tokens[current.token as number] as SddToken).text : null,
      from: current.from,
      to: current.to,
    });
    if (isLeaf) return node.id;
    const body = (spec.productions[current.production as number] as SddProduction).body;
    if (body.length === 0) {
      const epsilon = addNode({
        symbol: 'ε',
        written: 'ε',
        kind: 'epsilon',
        parent: node.id,
        children: [],
        production: null,
        token: null,
        lexeme: null,
        from: current.from,
        to: current.to,
      });
      node.children.push(epsilon.id);
    }
    current.children.forEach((child, index) => {
      node.children.push(flatten(child, (body[index] as SddOccurrence).written, node.id));
    });
    return node.id;
  };
  const root = flatten(shape, shape.symbol, null);

  const warning = ambiguityWarning(tokens, nodes, rules, matches, ends);
  return { tokens, nodes, root, warnings: warning ? [warning] : [] };
}

/** A node's children that stand for body symbols, so index k means body[k]. */
export function sddBodyChildren(nodes: readonly SddTreeNode[], node: SddTreeNode): number[] {
  return node.children.filter((child) => (nodes[child] as SddTreeNode).kind !== 'epsilon');
}

/** What a terminal's attribute holds. Lexers give a number's value and a name's text. */
export function sddLexicalValue(node: SddTreeNode, attr: string): number | string | null {
  const lexeme = node.lexeme;
  if (lexeme === null) return null;
  if (['lexval', 'val', 'value'].includes(attr)) {
    return /^[0-9]/.test(lexeme) ? Number(lexeme) : lexeme;
  }
  if (['lexeme', 'entry', 'name', 'text', 'id'].includes(attr)) return lexeme;
  return null;
}
