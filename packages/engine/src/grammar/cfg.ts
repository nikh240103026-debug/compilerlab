import { EngineError } from '../core/result';
import { deepFreeze } from '../core/trace';
import {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  MAX_GRAMMAR_BODY,
  MAX_GRAMMAR_INPUT_TOKENS,
  MAX_GRAMMAR_PRODUCTIONS,
  MAX_GRAMMAR_TEXT,
  type Grammar,
  type GrammarPrecedence,
  type GrammarPrecedenceLevel,
  type GrammarProduction,
  type GrammarWarning,
} from './types';

/*
 * The grammar format, for lessons and error messages to point at:
 *
 *   # A comment runs to the end of the line.
 *   E -> E + T | T
 *   T -> T * F
 *      | F
 *   F -> ( E ) | id
 *   A -> a A | ε
 *
 * - The first head is the start symbol. A head can appear on several lines.
 * - The arrow can be ->, → or ::=.
 * - ε, eps, epsilon or %empty mean the empty string.
 * - Symbols are separated by spaces, but brackets and operators split on their own, so (E)+id reads
 *   as ( E ) + id. Letters and digits stick together, so aSb is one symbol: write a S b.
 * - Quotes force a terminal, for symbols the format uses itself: '|', '#', 'a b'.
 * - $ is reserved for the end marker.
 */

const ARROWS = ['->', '→', '::='] as const;
const EPSILON_WORDS: ReadonlySet<string> = new Set([GRAMMAR_EPSILON, 'eps', 'epsilon']);
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_']*/uy;
const INPUT_WORD = /[\p{L}\p{N}_']+|\S/uy;
const SINGLE_CHARACTERS: ReadonlySet<string> = new Set('()[]{},;:.');
const OPERATOR_CHARACTERS: ReadonlySet<string> = new Set('+-*/%=<>!&^~?@\\`');

type CfgTokenKind = 'symbol' | 'quoted' | 'epsilon' | 'arrow' | 'bar';

interface CfgToken {
  kind: CfgTokenKind;
  text: string;
  start: number;
  end: number;
}

function locate(text: string, position: number) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

function failAt(
  text: string,
  code: string,
  message: string,
  position: number,
  length: number,
  hint?: string,
): never {
  const { line, column } = locate(text, position);
  throw new EngineError({
    code,
    message: `Line ${line}, column ${column}: ${message}`,
    position,
    length,
    ...(hint ? { hint } : {}),
  });
}

function lexLines(text: string): CfgToken[][] {
  const lines: CfgToken[][] = [[]];
  const push = (kind: CfgTokenKind, start: number, end: number, value?: string) => {
    (lines.at(-1) as CfgToken[]).push({ kind, text: value ?? text.slice(start, end), start, end });
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (char === '\n') {
      lines.push([]);
      at++;
      continue;
    }
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (char === '#') {
      while (at < text.length && text[at] !== '\n') at++;
      continue;
    }
    const arrow = ARROWS.find((candidate) => text.startsWith(candidate, at));
    if (arrow) {
      push('arrow', at, at + arrow.length);
      at += arrow.length;
      continue;
    }
    if (char === '|') {
      push('bar', at, at + 1);
      at++;
      continue;
    }
    if (char === "'" || char === '"') {
      let close = at + 1;
      while (close < text.length && text[close] !== char && text[close] !== '\n') close++;
      if (text[close] !== char) {
        failAt(
          text,
          'unclosed_quote',
          `This ${char} is never closed.`,
          at,
          close - at,
          'A quoted symbol has to end on the same line.',
        );
      }
      if (close === at + 1) {
        failAt(
          text,
          'empty_quote',
          'Quotes need a symbol between them.',
          at,
          2,
          'Write ε for empty.',
        );
      }
      push('quoted', at, close + 1, text.slice(at + 1, close));
      at = close + 1;
      continue;
    }
    if (text.startsWith('%empty', at)) {
      push('epsilon', at, at + 6);
      at += 6;
      continue;
    }
    WORD.lastIndex = at;
    const word = WORD.exec(text)?.[0];
    if (word) {
      push(EPSILON_WORDS.has(word) ? 'epsilon' : 'symbol', at, at + word.length);
      at += word.length;
      continue;
    }
    if (SINGLE_CHARACTERS.has(char)) {
      push('symbol', at, at + 1);
      at++;
      continue;
    }
    if (OPERATOR_CHARACTERS.has(char)) {
      let end = at + 1;
      while (
        end < text.length &&
        OPERATOR_CHARACTERS.has(text[end] as string) &&
        !text.startsWith('->', end)
      ) {
        end++;
      }
      push('symbol', at, end);
      at = end;
      continue;
    }
    const whole = String.fromCodePoint(text.codePointAt(at) as number);
    push('symbol', at, at + whole.length);
    at += whole.length;
  }
  return lines;
}

/** Joins a line that starts with | or follows one that ends with | onto its rule. */
function logicalLines(lines: readonly CfgToken[][]): CfgToken[][] {
  const logical: CfgToken[][] = [];
  for (const line of lines) {
    const first = line[0];
    if (!first) continue;
    const previous = logical.at(-1);
    if (previous && (first.kind === 'bar' || previous.at(-1)?.kind === 'bar')) {
      previous.push(...line);
    } else {
      logical.push([...line]);
    }
  }
  return logical;
}

function isBareSymbol(symbol: string): boolean {
  if (EPSILON_WORDS.has(symbol)) return false;
  WORD.lastIndex = 0;
  const word = WORD.exec(symbol)?.[0];
  if (word === symbol) return true;
  if (symbol.length === 1 && SINGLE_CHARACTERS.has(symbol)) return true;
  return (
    symbol.length > 0 &&
    !symbol.includes('->') &&
    [...symbol].every((char) => OPERATOR_CHARACTERS.has(char))
  );
}

export function formatGrammarBody(body: readonly string[]): string {
  return body.length > 0 ? body.join(' ') : GRAMMAR_EPSILON;
}

/** For display, such as "E → E + T". */
export function formatGrammarProduction(production: Pick<GrammarProduction, 'head' | 'body'>) {
  return `${production.head} → ${formatGrammarBody(production.body)}`;
}

/** Text that `parseGrammar` reads back as the same grammar. */
export function formatGrammar(grammar: Grammar): string {
  const write = (symbol: string) => (isBareSymbol(symbol) ? symbol : `'${symbol}'`);
  return grammar.nonterminals
    .map((head) => {
      const bodies = grammar.productions
        .filter((production) => production.head === head)
        .map(({ body }) => (body.length > 0 ? body.map(write).join(' ') : GRAMMAR_EPSILON));
      return `${write(head)} -> ${bodies.join(' | ')}`;
    })
    .join('\n');
}

export interface GrammarRule {
  readonly head: string;
  readonly body: readonly string[];
}

/** Builds a grammar from rules that are already split into symbols. */
export function grammarFromRules(
  start: string,
  rules: readonly GrammarRule[],
  warnings: readonly GrammarWarning[] = [],
): Grammar {
  const heads = new Set(rules.map((rule) => rule.head));
  const terminals = new Set<string>();
  for (const { body } of rules) {
    for (const symbol of body) if (!heads.has(symbol)) terminals.add(symbol);
  }
  return deepFreeze({
    start,
    nonterminals: [...heads],
    terminals: [...terminals],
    productions: rules.map((rule, id) => ({ id, head: rule.head, body: [...rule.body] })),
    warnings,
  });
}

function sourceWarnings(
  nonterminals: readonly string[],
  terminals: readonly string[],
  quoted: ReadonlySet<string>,
  duplicates: readonly string[],
): GrammarWarning[] {
  const warnings: GrammarWarning[] = duplicates.map((production) => ({
    code: 'duplicate_production',
    message: `${production} was written twice, so the copy was ignored.`,
    symbols: [],
  }));
  for (const terminal of terminals) {
    if (quoted.has(terminal)) continue;
    if (/^[A-Z][0-9']*$/.test(terminal)) {
      warnings.push({
        code: 'undefined_symbol',
        message: `${terminal} has no production, so it is a terminal. If you meant a nonterminal, give it a production.`,
        symbols: [terminal],
      });
    } else if (
      /\p{Ll}/u.test(terminal) &&
      /\p{Lu}/u.test(terminal) &&
      nonterminals.some((name) => terminal.includes(name))
    ) {
      warnings.push({
        code: 'joined_symbols',
        message: `${terminal} is one terminal, because letters that touch form one symbol. If you meant several symbols, put spaces between them.`,
        symbols: [terminal],
      });
    }
  }
  return warnings;
}

/**
 * Reads a grammar from text in the format at the top of this file. The first head is the start
 * symbol. Throws an EngineError with a position for anything it cannot read.
 */
export function parseGrammar(text: string): Grammar {
  if (text.length > MAX_GRAMMAR_TEXT) {
    throw new EngineError({
      code: 'grammar_too_long',
      message: `This grammar is over ${MAX_GRAMMAR_TEXT} characters long.`,
      hint: 'Try a smaller grammar.',
    });
  }

  const rules: GrammarRule[] = [];
  const quoted = new Set<string>();
  const quotedAt = new Map<string, CfgToken>();
  const seen = new Set<string>();
  const duplicates: string[] = [];

  const addAlternative = (head: string, tokens: readonly CfgToken[], before: CfgToken) => {
    if (tokens.length === 0) {
      failAt(
        text,
        'empty_alternative',
        before.kind === 'arrow'
          ? `${head} ${before.text} has nothing after the arrow.`
          : `${head} has an empty alternative here.`,
        before.start,
        before.end - before.start,
        `Write ε if you mean the empty string, as in ${head} -> a | ε.`,
      );
    }
    const body: string[] = [];
    for (const token of tokens) {
      if (token.kind === 'epsilon') continue;
      if (token.text === GRAMMAR_END_MARKER || token.text === GRAMMAR_EPSILON) {
        failAt(
          text,
          'reserved_symbol',
          `${token.text} is reserved, so a production cannot use it.`,
          token.start,
          token.end - token.start,
          `${GRAMMAR_END_MARKER} marks the end of the input, and every parser adds it for you.`,
        );
      }
      if (token.kind === 'quoted') {
        quoted.add(token.text);
        if (!quotedAt.has(token.text)) quotedAt.set(token.text, token);
      }
      body.push(token.text);
    }
    if (body.length > MAX_GRAMMAR_BODY) {
      failAt(
        text,
        'production_too_long',
        `This production has over ${MAX_GRAMMAR_BODY} symbols.`,
        (tokens[0] as CfgToken).start,
        1,
      );
    }
    const key = `${head}\u0000${body.join('\u0000')}`;
    if (seen.has(key)) {
      duplicates.push(formatGrammarProduction({ head, body }));
      return;
    }
    seen.add(key);
    rules.push({ head, body });
    if (rules.length > MAX_GRAMMAR_PRODUCTIONS) {
      throw new EngineError({
        code: 'too_many_productions',
        message: `This grammar has over ${MAX_GRAMMAR_PRODUCTIONS} productions.`,
        hint: 'Try a smaller grammar.',
      });
    }
  };

  for (const line of logicalLines(lexLines(text))) {
    const first = line[0] as CfgToken;
    const arrowIndex = line.findIndex((token) => token.kind === 'arrow');
    if (first.kind === 'bar') {
      failAt(
        text,
        'missing_head',
        'This | has no rule above it to continue.',
        first.start,
        1,
        'Start with a head and an arrow, as in E -> E + T | T.',
      );
    }
    if (arrowIndex === -1) {
      failAt(
        text,
        'missing_arrow',
        `Expected an arrow after ${first.text}.`,
        first.start,
        first.end - first.start,
        'Each rule needs a head, then ->, then its alternatives, as in E -> E + T | T.',
      );
    }
    if (arrowIndex === 0) {
      failAt(
        text,
        'missing_head',
        'This arrow has no nonterminal on its left.',
        first.start,
        first.end - first.start,
        'Each rule starts with a head, as in E -> E + T | T.',
      );
    }
    if (arrowIndex > 1) {
      const extra = line[1] as CfgToken;
      failAt(
        text,
        'long_head',
        `A rule's left side must be one symbol, but ${extra.text} follows ${first.text}.`,
        extra.start,
        extra.end - extra.start,
        'A context-free grammar has exactly one nonterminal on the left of the arrow.',
      );
    }
    if (first.kind !== 'symbol' || first.text === GRAMMAR_END_MARKER) {
      failAt(
        text,
        'bad_head',
        first.kind === 'quoted'
          ? 'A quoted symbol is a terminal, so it cannot have productions.'
          : `${first.text} cannot have productions.`,
        first.start,
        first.end - first.start,
      );
    }

    const head = first.text;
    let alternative: CfgToken[] = [];
    let before = line[arrowIndex] as CfgToken;
    for (const token of line.slice(arrowIndex + 1)) {
      if (token.kind === 'arrow') {
        failAt(
          text,
          'extra_arrow',
          'This rule has a second arrow.',
          token.start,
          token.end - token.start,
          'Put each rule on its own line. If -> is meant to be a terminal, quote it.',
        );
      }
      if (token.kind === 'bar') {
        addAlternative(head, alternative, before);
        alternative = [];
        before = token;
      } else {
        alternative.push(token);
      }
    }
    addAlternative(head, alternative, before);
  }

  const start = rules[0]?.head;
  if (start === undefined) {
    throw new EngineError({
      code: 'empty_grammar',
      message: 'This grammar has no productions.',
      hint: 'Add a rule such as S -> a S | ε.',
    });
  }

  const heads = new Set(rules.map((rule) => rule.head));
  for (const [name, token] of quotedAt) {
    if (heads.has(name)) {
      failAt(
        text,
        'quoted_nonterminal',
        `${name} is quoted here as a terminal, but it also has productions.`,
        token.start,
        token.end - token.start,
        'Give the terminal a different name.',
      );
    }
  }

  const plain = grammarFromRules(start, rules);
  return grammarFromRules(
    start,
    rules,
    sourceWarnings(plain.nonterminals, plain.terminals, quoted, duplicates),
  );
}

export interface GrammarIndex {
  readonly nonterminals: ReadonlySet<string>;
  readonly byHead: ReadonlyMap<string, readonly GrammarProduction[]>;
}

export function indexGrammar(grammar: Grammar): GrammarIndex {
  const byHead = new Map<string, GrammarProduction[]>();
  for (const head of grammar.nonterminals) byHead.set(head, []);
  for (const production of grammar.productions) byHead.get(production.head)?.push(production);
  return { nonterminals: new Set(grammar.nonterminals), byHead };
}

/** Puts terminals in grammar order, with $ and then ε at the end, so sets always read the same. */
export function grammarSymbolOrder(grammar: Grammar): ReadonlyMap<string, number> {
  const order = new Map(grammar.terminals.map((terminal, index) => [terminal, index]));
  order.set(GRAMMAR_END_MARKER, grammar.terminals.length);
  order.set(GRAMMAR_EPSILON, grammar.terminals.length + 1);
  return order;
}

export function sortGrammarSymbols(
  order: ReadonlyMap<string, number>,
  symbols: Iterable<string>,
): string[] {
  return [...symbols].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

export interface GrammarInputToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Errors whose position is in the sentence, not the grammar. */
export const GRAMMAR_INPUT_ERROR_CODES: readonly string[] = ['unknown_terminal', 'input_too_long'];

/**
 * Splits a sentence into the grammar's terminals, taking the longest terminal at each point, so
 * id+id*id needs no spaces. A trailing $ is allowed, as the book writes w$.
 */
export function tokenizeGrammarInput(grammar: Grammar, text: string): GrammarInputToken[] {
  const names = grammar.terminals.toSorted((a, b) => b.length - a.length);
  const tokens: GrammarInputToken[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/.test(text[at] as string)) {
      at++;
      continue;
    }
    const name = names.find((terminal) => text.startsWith(terminal, at));
    if (name) {
      tokens.push({ text: name, start: at, end: at + name.length });
      at += name.length;
      if (tokens.length > MAX_GRAMMAR_INPUT_TOKENS) {
        throw new EngineError({
          code: 'input_too_long',
          message: `This sentence has over ${MAX_GRAMMAR_INPUT_TOKENS} tokens.`,
          hint: 'Try a shorter sentence.',
          position: at,
          length: 1,
        });
      }
      continue;
    }
    const isLast = text.slice(at + 1).trim() === '';
    if (text[at] === GRAMMAR_END_MARKER && isLast) break;
    if (text[at] === GRAMMAR_EPSILON && isLast && tokens.length === 0) break;
    INPUT_WORD.lastIndex = at;
    const word = INPUT_WORD.exec(text)?.[0] ?? (text[at] as string);
    throw new EngineError({
      code: 'unknown_terminal',
      message: grammar.nonterminals.includes(word)
        ? `${word} is a nonterminal, and a sentence contains only terminals.`
        : `"${word}" is not a terminal of this grammar.`,
      hint:
        grammar.terminals.length > 0
          ? `Its terminals are: ${grammar.terminals.slice(0, 16).join('  ')}`
          : 'This grammar has no terminals, so its only possible sentence is the empty one.',
      position: at,
      length: word.length,
    });
  }
  return tokens;
}

const PRECEDENCE_KEYWORDS: ReadonlyMap<string, GrammarPrecedenceLevel['assoc']> = new Map([
  ['%left', 'left'],
  ['%right', 'right'],
  ['%nonassoc', 'nonassoc'],
]);

/**
 * Reads %left, %right and %nonassoc lines, lowest precedence first, the way a Yacc file does.
 * An empty text gives no levels.
 */
export function parseGrammarPrecedence(text: string): GrammarPrecedence {
  const levels: GrammarPrecedenceLevel[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const content = line.replace(/#.*$/, '').trim();
    if (content) {
      const [keyword, ...symbols] = content.split(/\s+/) as [string, ...string[]];
      const assoc = PRECEDENCE_KEYWORDS.get(keyword);
      if (!assoc || symbols.length === 0) {
        failAt(
          text,
          'bad_precedence',
          assoc
            ? `${keyword} needs at least one terminal.`
            : `Expected %left, %right or %nonassoc.`,
          offset + line.indexOf(keyword),
          keyword.length,
          'Write one level per line, lowest precedence first, such as %left + -',
        );
      }
      levels.push({
        assoc,
        terminals: symbols.map((symbol) => symbol.replace(/^(['"])(.+)\1$/, '$2')),
      });
    }
    offset += line.length + 1;
  }
  return { levels };
}
