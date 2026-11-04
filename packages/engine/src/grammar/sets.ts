import { TraceRecorder, type Trace } from '../core/trace';
import { formatGrammarProduction, grammarSymbolOrder, sortGrammarSymbols } from './cfg';
import {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  type Grammar,
  type GrammarProduction,
  type GrammarSetRow,
} from './types';

/** The sets as plain lookups, for the algorithms that use them. */
export interface GrammarSetMaps {
  readonly nonterminals: ReadonlySet<string>;
  readonly nullable: ReadonlySet<string>;
  readonly first: ReadonlyMap<string, ReadonlySet<string>>;
  readonly follow: ReadonlyMap<string, ReadonlySet<string>>;
}

export type GrammarSetsPhase = 'nullable' | 'first' | 'follow' | 'done';

export interface GrammarSetsState {
  readonly phase: GrammarSetsPhase;
  /** Which pass over the productions this phase is on. */
  readonly pass: number;
  readonly nullable: readonly string[];
  readonly first: readonly GrammarSetRow[];
  readonly follow: readonly GrammarSetRow[];
  readonly production: number | null;
  /** The nonterminal whose set just grew. */
  readonly symbol: string | null;
  readonly added: readonly string[];
}

export interface GrammarSets {
  /** In the order of `grammar.nonterminals`. */
  readonly nullable: readonly string[];
  readonly first: readonly GrammarSetRow[];
  readonly follow: readonly GrammarSetRow[];
  readonly trace: Trace<GrammarSetsState>;
}

const list = (items: readonly string[]) => items.join(', ');

/**
 * FIRST of a string of symbols, without ε. `nullable` says whether the whole string can vanish,
 * which is exactly when ε belongs in its FIRST set.
 */
export function grammarFirstOfSequence(
  maps: GrammarSetMaps,
  sequence: readonly string[],
): { items: string[]; nullable: boolean } {
  const items = new Set<string>();
  for (const symbol of sequence) {
    if (!maps.nonterminals.has(symbol)) {
      items.add(symbol);
      return { items: [...items], nullable: false };
    }
    for (const item of maps.first.get(symbol) ?? []) {
      if (item !== GRAMMAR_EPSILON) items.add(item);
    }
    if (!maps.nullable.has(symbol)) return { items: [...items], nullable: false };
  }
  return { items: [...items], nullable: true };
}

/** All three computations are fixed points: repeat over the productions until a pass adds nothing. */
function compute(
  grammar: Grammar,
  recorder: TraceRecorder<GrammarSetsState> | null,
): GrammarSetMaps {
  const nonterminals = new Set(grammar.nonterminals);
  const nullable = new Set<string>();
  const first = new Map(grammar.nonterminals.map((symbol) => [symbol, new Set<string>()]));
  const follow = new Map(grammar.nonterminals.map((symbol) => [symbol, new Set<string>()]));
  const maps: GrammarSetMaps = { nonterminals, nullable, first, follow };
  const order = grammarSymbolOrder(grammar);

  const rows = (sets: ReadonlyMap<string, ReadonlySet<string>>): GrammarSetRow[] =>
    grammar.nonterminals.map((symbol) => ({
      symbol,
      items: sortGrammarSymbols(order, sets.get(symbol) ?? []),
    }));

  const record = (
    phase: GrammarSetsPhase,
    pass: number,
    title: string,
    explanation: string,
    production: GrammarProduction | null = null,
    symbol: string | null = null,
    added: readonly string[] = [],
  ) => {
    recorder?.add(title, explanation, {
      phase,
      pass,
      nullable: grammar.nonterminals.filter((name) => nullable.has(name)),
      first: rows(first),
      follow: rows(follow),
      production: production?.id ?? null,
      symbol,
      added: sortGrammarSymbols(order, added),
    });
  };

  // Nullable.
  record(
    'nullable',
    0,
    'Which nonterminals can vanish?',
    'A nonterminal is nullable if it can derive the empty string. It is nullable if some production body is empty, or if every symbol in some body is itself nullable. Repeat until nothing changes.',
  );
  let changed = true;
  for (let pass = 1; changed; pass++) {
    changed = false;
    for (const production of grammar.productions) {
      if (nullable.has(production.head)) continue;
      if (production.body.every((symbol) => nullable.has(symbol))) {
        nullable.add(production.head);
        changed = true;
        record(
          'nullable',
          pass,
          `${production.head} is nullable`,
          production.body.length === 0
            ? `${formatGrammarProduction(production)} derives the empty string directly.`
            : `Every symbol in ${formatGrammarProduction(production)} is nullable, so ${production.head} can vanish too.`,
          production,
          production.head,
        );
      }
    }
    record(
      'nullable',
      pass,
      `Nullable, pass ${pass} done`,
      changed
        ? 'This pass changed something, so go round again.'
        : `Nothing changed, so this is final. Nullable: ${list(grammar.nonterminals.filter((name) => nullable.has(name))) || 'none'}.`,
    );
  }

  // FIRST.
  changed = true;
  for (let pass = 1; changed; pass++) {
    changed = false;
    for (const production of grammar.productions) {
      const target = first.get(production.head) as Set<string>;
      const added: string[] = [];
      const read: string[] = [];
      let vanishes = true;
      for (const symbol of production.body) {
        read.push(symbol);
        const items = nonterminals.has(symbol) ? (first.get(symbol) as Set<string>) : [symbol];
        for (const item of items) {
          if (item !== GRAMMAR_EPSILON && !target.has(item)) {
            target.add(item);
            added.push(item);
          }
        }
        if (!nullable.has(symbol)) {
          vanishes = false;
          break;
        }
      }
      if (vanishes && !target.has(GRAMMAR_EPSILON)) {
        target.add(GRAMMAR_EPSILON);
        added.push(GRAMMAR_EPSILON);
      }
      if (added.length > 0) {
        changed = true;
        const why =
          production.body.length === 0
            ? 'The body is empty, so ε joins.'
            : read.length === 1
              ? `A string from this body starts with what ${read[0]} starts with.`
              : `The symbols ${list(read.slice(0, -1))} can vanish, so a string from this body can also start with what ${read.at(-1)} starts with.`;
        record(
          'first',
          pass,
          `FIRST(${production.head}) grows`,
          `${formatGrammarProduction(production)}: ${why} FIRST(${production.head}) gains ${list(sortGrammarSymbols(order, added))}.`,
          production,
          production.head,
          added,
        );
      }
    }
    record(
      'first',
      pass,
      `FIRST, pass ${pass} done`,
      changed
        ? 'This pass changed something, so go round again.'
        : 'Nothing changed, so the FIRST sets are final.',
    );
  }

  // FOLLOW.
  (follow.get(grammar.start) as Set<string>).add(GRAMMAR_END_MARKER);
  record(
    'follow',
    0,
    `$ joins FOLLOW(${grammar.start})`,
    `A sentence derived from ${grammar.start} is followed by the end of the input, so ${GRAMMAR_END_MARKER} goes in FOLLOW(${grammar.start}).`,
    null,
    grammar.start,
    [GRAMMAR_END_MARKER],
  );
  changed = true;
  for (let pass = 1; changed; pass++) {
    changed = false;
    for (const production of grammar.productions) {
      for (const [index, symbol] of production.body.entries()) {
        if (!nonterminals.has(symbol)) continue;
        const target = follow.get(symbol) as Set<string>;
        const rest = production.body.slice(index + 1);
        const { items, nullable: restVanishes } = grammarFirstOfSequence(maps, rest);
        const added = items.filter((item) => !target.has(item));
        for (const item of added) target.add(item);
        const fromHead: string[] = [];
        if (restVanishes) {
          for (const item of follow.get(production.head) as Set<string>) {
            if (!target.has(item)) {
              target.add(item);
              fromHead.push(item);
            }
          }
        }
        if (added.length + fromHead.length === 0) continue;
        changed = true;
        const parts: string[] = [];
        if (added.length > 0) {
          parts.push(
            `After ${symbol} comes ${rest.join(' ')}, so what that can start with joins FOLLOW(${symbol}): ${list(sortGrammarSymbols(order, added))}.`,
          );
        }
        if (fromHead.length > 0) {
          parts.push(
            `${rest.length === 0 ? `${symbol} ends the body` : `What follows ${symbol} can vanish`}, so whatever follows ${production.head} can follow ${symbol}: ${list(sortGrammarSymbols(order, fromHead))}.`,
          );
        }
        record(
          'follow',
          pass,
          `FOLLOW(${symbol}) grows`,
          `${formatGrammarProduction(production)}: ${parts.join(' ')}`,
          production,
          symbol,
          [...added, ...fromHead],
        );
      }
    }
    record(
      'follow',
      pass,
      `FOLLOW, pass ${pass} done`,
      changed
        ? 'This pass changed something, so go round again.'
        : 'Nothing changed, so the FOLLOW sets are final.',
    );
  }

  record(
    'done',
    0,
    'Finished',
    'Nullable, FIRST and FOLLOW have all reached a fixed point. FOLLOW never contains ε, and only a FIRST set of a nullable nonterminal contains it.',
  );
  return maps;
}

/** The sets without a trace, for other algorithms. */
export function grammarSetMaps(grammar: Grammar): GrammarSetMaps {
  return compute(grammar, null);
}

export function grammarSetRows(
  grammar: Grammar,
  sets: ReadonlyMap<string, ReadonlySet<string>>,
): GrammarSetRow[] {
  const order = grammarSymbolOrder(grammar);
  return grammar.nonterminals.map((symbol) => ({
    symbol,
    items: sortGrammarSymbols(order, sets.get(symbol) ?? []),
  }));
}

/** Nullable, FIRST and FOLLOW, with a trace of every pass that changed something. */
export function grammarSets(grammar: Grammar): GrammarSets {
  const recorder = new TraceRecorder<GrammarSetsState>();
  const maps = compute(grammar, recorder);
  return {
    nullable: grammar.nonterminals.filter((symbol) => maps.nullable.has(symbol)),
    first: grammarSetRows(grammar, maps.first),
    follow: grammarSetRows(grammar, maps.follow),
    trace: recorder.finish(),
  };
}

const EPSILON_ANSWERS: ReadonlySet<string> = new Set([GRAMMAR_EPSILON, 'eps', 'epsilon']);

/** Reads a student's set: "{a, b}", "a b" and "a,b" all work, and eps means ε. */
export function grammarParseSetText(grammar: Grammar, text: string): string[] {
  const known = new Set([...grammar.terminals, GRAMMAR_END_MARKER, GRAMMAR_EPSILON]);
  let cleaned = text.trim();
  if (!known.has('{')) cleaned = cleaned.replace(/^\{/, '');
  if (!known.has('}')) cleaned = cleaned.replace(/\}$/, '');
  const items = new Set<string>();
  const add = (raw: string) => {
    const part = raw.replace(/^(['"])(.+)\1$/, '$2');
    if (part) items.add(EPSILON_ANSWERS.has(part) ? GRAMMAR_EPSILON : part);
  };
  for (const chunk of cleaned.split(/\s+/)) {
    if (known.has(chunk)) add(chunk);
    else for (const part of chunk.split(',')) add(part);
  }
  return [...items];
}

export type GrammarSetKind = 'first' | 'follow';

export interface GrammarSetAnswer {
  readonly symbol: string;
  readonly kind: GrammarSetKind;
  readonly text: string;
}

export interface GrammarSetVerdict {
  readonly symbol: string;
  readonly kind: GrammarSetKind;
  readonly correct: boolean;
  readonly given: readonly string[];
  readonly missing: readonly string[];
  /** Items the student gave that do not belong. */
  readonly extra: readonly string[];
  readonly expected: readonly string[];
}

export interface GrammarSetCheck {
  /** Every nonterminal's FIRST, then every nonterminal's FOLLOW. */
  readonly verdicts: readonly GrammarSetVerdict[];
  readonly correctCount: number;
  readonly allCorrect: boolean;
}

/** Marks a student's FIRST and FOLLOW sets. The engine is the source of truth, cell by cell. */
export function grammarCheckSets(
  grammar: Grammar,
  answers: readonly GrammarSetAnswer[],
): GrammarSetCheck {
  const maps = grammarSetMaps(grammar);
  const order = grammarSymbolOrder(grammar);
  const verdicts: GrammarSetVerdict[] = [];
  for (const kind of ['first', 'follow'] as const) {
    for (const symbol of grammar.nonterminals) {
      const answer = answers.find((item) => item.symbol === symbol && item.kind === kind);
      const given = grammarParseSetText(grammar, answer?.text ?? '');
      const expected = (kind === 'first' ? maps.first : maps.follow).get(symbol) ?? new Set();
      const missing = [...expected].filter((item) => !given.includes(item));
      const extra = given.filter((item) => !expected.has(item));
      verdicts.push({
        symbol,
        kind,
        correct: missing.length === 0 && extra.length === 0,
        given,
        missing: sortGrammarSymbols(order, missing),
        extra,
        expected: sortGrammarSymbols(order, expected),
      });
    }
  }
  const correctCount = verdicts.filter((verdict) => verdict.correct).length;
  return { verdicts, correctCount, allCorrect: correctCount === verdicts.length };
}
