import { EngineError } from '../core/result';
import { sddParseRules, type SddRule } from './sdd-expr';

// The text format for an SDD or an SDT, one production at a time:
//
//   E -> E1 + T { E.val = E1.val + T.val }
//   E -> T      { E.val = T.val }
//   R -> + T { print('+') } R1 | ε
//
// A symbol is a nonterminal if it heads a production. E1 and T1' are occurrences of E and T',
// which is the book's subscript. Braces in the middle of a body are embedded actions.

export const MAX_SDD_SPEC_LENGTH = 20_000;
export const MAX_SDD_PRODUCTIONS = 200;
const MAX_BODY_LENGTH = 40;

/** Terminals the input tokenizer treats as classes of tokens, not as literal text. */
export const SDD_NUMBER_TERMINALS: readonly string[] = ['digit', 'num', 'number'];
export const SDD_IDENTIFIER_TERMINALS: readonly string[] = ['id', 'identifier'];
const EPSILON_WORDS = new Set(['ε', 'epsilon', 'eps']);
const PRODUCTION_HINT = 'Write each production like this: E -> E1 + T { E.val = E1.val + T.val }';

export interface SddOccurrence {
  /** As written in this production, like E1. */
  written: string;
  /** The grammar symbol it is an occurrence of, like E. */
  symbol: string;
  terminal: boolean;
}

export interface SddActionBlock {
  /** How many grammar symbols of the body come before this block. */
  position: number;
  /** The text between the braces. */
  text: string;
  rules: SddRule[];
}

export interface SddProduction {
  index: number;
  head: string;
  body: SddOccurrence[];
  actions: SddActionBlock[];
  /** Every rule of every block, in written order. */
  rules: SddRule[];
  /** Like E → E1 + T, or T' → ε. */
  text: string;
}

export interface SddSpec {
  productions: SddProduction[];
  /** The head of the first production. */
  start: string;
  nonterminals: string[];
  terminals: string[];
}

export type SddAttributeKind = 'synthesized' | 'inherited' | 'lexical' | 'undefined';

export interface SddAttributeInfo {
  symbol: string;
  attr: string;
  kind: SddAttributeKind;
  /** Productions whose rules define this attribute. */
  definedIn: number[];
}

type SpecItem =
  | { kind: 'symbol'; text: string; quoted: boolean; start: number; end: number }
  | { kind: 'arrow'; start: number; end: number }
  | { kind: 'bar'; start: number; end: number }
  | { kind: 'action'; start: number; end: number };

function specError(
  code: string,
  message: string,
  position: number,
  length = 1,
  hint = PRODUCTION_HINT,
): never {
  throw new EngineError({ code: `sdd_spec_${code}`, message, hint, position, length });
}

const SYMBOL_NAME = /[A-Za-z_][A-Za-z0-9_]*'*[0-9]*'*/y;
const DIGITS = /[0-9]+/y;
const LONG_PUNCTUATION = ['||', '&&', '==', '!=', '<=', '>=', '++', '--', '<<', '>>'];
const ARROWS = ['::=', '->', '→'];

function findActionEnd(source: string, open: number): number {
  let at = open + 1;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === '}') return at;
    // A quote right after a name is a prime, as in T'. Anywhere else it opens a string.
    const startsString =
      char === '"' || (char === "'" && !/[A-Za-z0-9_']/.test(source[at - 1] as string));
    if (startsString) {
      const close = source.indexOf(char, at + 1);
      if (close === -1) {
        specError(
          'unclosed_text',
          'This quoted text is never closed.',
          at,
          1,
          `Add the closing ${char}.`,
        );
      }
      at = close;
    }
    at++;
  }
  specError(
    'unclosed_action',
    'This { is never closed.',
    open,
    1,
    'Add the matching } after the rules.',
  );
}

function scanSpec(source: string): SpecItem[] {
  const items: SpecItem[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (char === '#' || source.startsWith('//', at)) {
      const newline = source.indexOf('\n', at);
      at = newline === -1 ? source.length : newline;
    } else if (char === '{') {
      const close = findActionEnd(source, at);
      items.push({ kind: 'action', start: at, end: close + 1 });
      at = close + 1;
    } else if (char === '}') {
      specError('stray_brace', 'This } has no matching {.', at, 1, 'Remove it, or add the {.');
    } else if (char === "'" || char === '"') {
      const close = source.indexOf(char, at + 1);
      if (close === -1 || close === at + 1) {
        specError(
          'unclosed_text',
          'This quoted terminal is not closed.',
          at,
          1,
          `Write it like ${char}+${char}.`,
        );
      }
      items.push({
        kind: 'symbol',
        text: source.slice(at + 1, close),
        quoted: true,
        start: at,
        end: close + 1,
      });
      at = close + 1;
    } else {
      const arrow = ARROWS.find((text) => source.startsWith(text, at));
      if (arrow) {
        items.push({ kind: 'arrow', start: at, end: at + arrow.length });
        at += arrow.length;
        continue;
      }
      let text: string | undefined;
      if (/[A-Za-z_]/.test(char)) {
        SYMBOL_NAME.lastIndex = at;
        text = (SYMBOL_NAME.exec(source) as RegExpExecArray)[0];
      } else if (/[0-9]/.test(char)) {
        DIGITS.lastIndex = at;
        text = (DIGITS.exec(source) as RegExpExecArray)[0];
      } else {
        text = LONG_PUNCTUATION.find((candidate) => source.startsWith(candidate, at));
      }
      if (text === undefined && char === '|') {
        items.push({ kind: 'bar', start: at, end: at + 1 });
        at++;
        continue;
      }
      const symbol = text ?? String.fromCodePoint(source.codePointAt(at) as number);
      items.push({
        kind: 'symbol',
        text: symbol,
        quoted: false,
        start: at,
        end: at + symbol.length,
      });
      at += symbol.length;
    }
  }
  return items;
}

/** T1' and T'1 both give T', and E12 gives E. A name with no subscript comes back unchanged. */
function stripSubscript(name: string): string {
  const match = /^(.*?)[0-9]+('*)$/.exec(name);
  return match ? `${match[1]}${match[2]}` : name;
}

interface RawProduction {
  head: string;
  items: SpecItem[];
  start: number;
}

function groupProductions(items: SpecItem[]): RawProduction[] {
  const raw: RawProduction[] = [];
  let at = 0;
  while (at < items.length) {
    const head = items[at] as SpecItem;
    if (head.kind !== 'symbol' || head.quoted || items[at + 1]?.kind !== 'arrow') {
      specError(
        'expected_production',
        'A production is expected here, but this does not start one.',
        head.start,
        head.end - head.start,
      );
    }
    at += 2;
    for (;;) {
      const altItems: SpecItem[] = [];
      while (at < items.length) {
        const item = items[at] as SpecItem;
        if (item.kind === 'bar') break;
        if (item.kind === 'arrow') {
          specError(
            'stray_arrow',
            'This arrow has no head symbol to its left.',
            item.start,
            item.end - item.start,
          );
        }
        if (item.kind === 'symbol' && !item.quoted && items[at + 1]?.kind === 'arrow') break;
        altItems.push(item);
        at++;
      }
      raw.push({ head: head.text, items: altItems, start: head.start });
      if (items[at]?.kind !== 'bar') break;
      at++;
    }
  }
  return raw;
}

function buildProduction(
  source: string,
  raw: RawProduction,
  index: number,
  heads: Set<string>,
): SddProduction {
  const classify = (written: string, quoted: boolean): SddOccurrence => {
    if (quoted || heads.has(written))
      return { written, symbol: written, terminal: !heads.has(written) || quoted };
    const base = stripSubscript(written);
    if (base !== written && heads.has(base)) return { written, symbol: base, terminal: false };
    const isClass = SDD_NUMBER_TERMINALS.includes(base) || SDD_IDENTIFIER_TERMINALS.includes(base);
    return { written, symbol: isClass ? base : written, terminal: true };
  };

  const body: SddOccurrence[] = [];
  for (const item of raw.items) {
    if (item.kind !== 'symbol' || (!item.quoted && EPSILON_WORDS.has(item.text))) continue;
    body.push(classify(item.text, item.quoted));
  }
  if (body.length > MAX_BODY_LENGTH) {
    specError(
      'too_long',
      `A production body can have at most ${MAX_BODY_LENGTH} symbols.`,
      raw.start,
    );
  }

  const text = `${raw.head} → ${body.length > 0 ? body.map((symbol) => symbol.written).join(' ') : 'ε'}`;
  const resolve = (written: string, position: number, length: number): number => {
    if (written === raw.head) return -1;
    const found = body.findIndex((symbol) => symbol.written === written);
    if (found === -1) {
      specError(
        'unknown_symbol',
        `${written} is not a symbol of ${text}.`,
        position,
        length,
        'Write the symbol exactly as the production does, with the same subscript.',
      );
    }
    return found;
  };

  const actions: SddActionBlock[] = [];
  let position = 0;
  for (const item of raw.items) {
    if (item.kind === 'symbol' && (item.quoted || !EPSILON_WORDS.has(item.text))) position++;
    if (item.kind !== 'action') continue;
    const rules = sddParseRules(source, item.start + 1, item.end - 1, resolve);
    for (const rule of rules) {
      const occurrence = rule.target?.occurrence ?? -1;
      if (occurrence >= 0 && (body[occurrence] as SddOccurrence).terminal) {
        specError(
          'assign_terminal',
          `${rule.target?.written} is a terminal, so a rule cannot assign to it.`,
          rule.position,
          rule.length,
          'Terminals get their attributes from the lexer.',
        );
      }
    }
    actions.push({ position, text: source.slice(item.start + 1, item.end - 1).trim(), rules });
  }

  return {
    index,
    head: raw.head,
    body,
    actions,
    rules: actions.flatMap((block) => block.rules),
    text,
  };
}

/** Parses the text format. Works for both an SDD and an SDT. */
export function sddParseSpec(source: string): SddSpec {
  if (source.length > MAX_SDD_SPEC_LENGTH) {
    throw new EngineError({
      code: 'sdd_spec_too_long',
      message: `This definition is longer than ${MAX_SDD_SPEC_LENGTH} characters.`,
      hint: 'Try a smaller grammar.',
    });
  }
  const raw = groupProductions(scanSpec(source));
  if (raw.length === 0) {
    throw new EngineError({
      code: 'sdd_spec_empty',
      message: 'This definition has no productions.',
      hint: PRODUCTION_HINT,
    });
  }
  if (raw.length > MAX_SDD_PRODUCTIONS) {
    throw new EngineError({
      code: 'sdd_spec_too_many',
      message: `This definition has more than ${MAX_SDD_PRODUCTIONS} productions.`,
      hint: 'Try a smaller grammar.',
    });
  }
  const heads = new Set(raw.map((production) => production.head));
  const productions = raw.map((production, index) =>
    buildProduction(source, production, index, heads),
  );
  const terminals = [
    ...new Set(
      productions.flatMap((production) =>
        production.body.filter((symbol) => symbol.terminal).map((symbol) => symbol.symbol),
      ),
    ),
  ];
  return {
    productions,
    start: (raw[0] as RawProduction).head,
    nonterminals: [...heads],
    terminals,
  };
}

/** Which attributes exist and what kind each one is, in order of first appearance. */
export function sddAttributeTable(spec: SddSpec): SddAttributeInfo[] {
  const table = new Map<string, SddAttributeInfo>();
  const entry = (symbol: string, attr: string): SddAttributeInfo => {
    const key = `${symbol}.${attr}`;
    let info = table.get(key);
    if (!info) {
      info = { symbol, attr, kind: 'undefined', definedIn: [] };
      table.set(key, info);
    }
    return info;
  };
  for (const production of spec.productions) {
    const symbolOf = (occurrence: number): SddOccurrence =>
      occurrence === -1
        ? { written: production.head, symbol: production.head, terminal: false }
        : (production.body[occurrence] as SddOccurrence);
    for (const rule of production.rules) {
      if (rule.target) {
        const symbol = symbolOf(rule.target.occurrence).symbol;
        const info = entry(symbol, rule.target.attr);
        const kind = rule.target.occurrence === -1 ? 'synthesized' : 'inherited';
        if (info.kind !== 'undefined' && info.kind !== kind) {
          specError(
            'attribute_both',
            `${symbol}.${rule.target.attr} is defined both as synthesized and as inherited.`,
            rule.position,
            rule.length,
            'An attribute is one or the other. Give the inherited one its own name, like T.inh and T.syn.',
          );
        }
        info.kind = kind;
        if (!info.definedIn.includes(production.index)) info.definedIn.push(production.index);
      }
      for (const read of rule.reads) {
        const occurrence = symbolOf(read.occurrence);
        const info = entry(occurrence.symbol, read.attr);
        if (occurrence.terminal) info.kind = 'lexical';
      }
    }
  }
  return [...table.values()];
}

/** The checks that apply to an SDD but not to an SDT, where actions run in order. */
export function sddCheckDefinition(spec: SddSpec): void {
  sddAttributeTable(spec);
  for (const production of spec.productions) {
    const seen = new Set<string>();
    for (const rule of production.rules) {
      if (!rule.target) continue;
      const key = `${rule.target.written}.${rule.target.attr}`;
      if (seen.has(key)) {
        specError(
          'defined_twice',
          `${key} is defined twice in ${production.text}.`,
          rule.position,
          rule.length,
          'Keep one rule for each attribute of each symbol occurrence.',
        );
      }
      seen.add(key);
    }
  }
}
