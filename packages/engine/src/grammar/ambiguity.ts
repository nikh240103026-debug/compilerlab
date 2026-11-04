import { TraceRecorder, type Trace } from '../core/trace';
import {
  addChartDerivation,
  buildChartTree,
  grammarUsefulInfo,
  type ChartChild,
  type ChartDerivation,
  type ChartTable,
} from './chart';
import { formatGrammarProduction } from './cfg';
import { grammarDerivationSteps, type GrammarDerivationStep } from './derivation';
import { grammarTreeYield } from './forest';
import type { Grammar, GrammarParseTree, GrammarProduction } from './types';

export const DEFAULT_AMBIGUITY_LENGTH = 12;
export const MAX_AMBIGUITY_LENGTH = 24;
const DEFAULT_MAX_SENTENCES = 60_000;
const DEFAULT_MAX_WORK = 3_000_000;

export interface GrammarAmbiguityOptions {
  /** Sentences longer than this many tokens are not searched. */
  readonly maxLength?: number;
  /** Stop after remembering this many (nonterminal, string) pairs. */
  readonly maxSentences?: number;
  /** Stop after this many search steps. */
  readonly maxWork?: number;
}

export interface GrammarAmbiguityWitness {
  /** A full sentence of the language that has two different parse trees. */
  readonly sentence: readonly string[];
  /** The nonterminal where the two trees part ways, and the part of the sentence it covers. */
  readonly nonterminal: string;
  readonly fragment: readonly string[];
  readonly trees: readonly [GrammarParseTree, GrammarParseTree];
}

export type GrammarAmbiguityStop = 'found' | 'length' | 'sentences' | 'work' | 'no-sentences';

export interface GrammarAmbiguityResult {
  readonly witness: GrammarAmbiguityWitness | null;
  /** The limits this search ran with. */
  readonly bound: {
    readonly maxLength: number;
    readonly maxSentences: number;
    readonly maxWork: number;
  };
  /**
   * Every string of up to this many tokens, derived from any useful nonterminal, was fully checked.
   * It is -1 if the search was stopped before finishing even the empty string.
   */
  readonly checkedLength: number;
  readonly stoppedBy: GrammarAmbiguityStop;
  /** How many (nonterminal, string) pairs were looked at. */
  readonly sentencesSeen: number;
  /** The conclusion in words. It always says plainly that the search is bounded. */
  readonly message: string;
  readonly trace: Trace<GrammarTreeComparisonStep>;
}

export interface GrammarTreeComparisonSide {
  /** Which nodes of the tree exist so far. */
  readonly step: GrammarDerivationStep;
  readonly production: number | null;
}

export interface GrammarTreeComparisonStep {
  /** Null when there is no pair of trees to compare. */
  readonly left: GrammarTreeComparisonSide | null;
  readonly right: GrammarTreeComparisonSide | null;
  readonly diverged: boolean;
}

/**
 * Plays two parse trees of one sentence side by side as leftmost derivations. A grammar is
 * ambiguous exactly when some sentence has two leftmost derivations, so this shows where they part.
 */
export function grammarCompareTrees(
  grammar: Grammar,
  trees: readonly [GrammarParseTree, GrammarParseTree],
): Trace<GrammarTreeComparisonStep> {
  const recorder = new TraceRecorder<GrammarTreeComparisonStep>();
  const left = grammarDerivationSteps(trees[0], 'leftmost');
  const right = grammarDerivationSteps(trees[1], 'leftmost');
  const name = (production: number | null) =>
    production === null
      ? 'nothing'
      : formatGrammarProduction(grammar.productions[production] as GrammarProduction);
  const sentence = grammarTreeYield(trees[0]).join(' ') || 'the empty string';
  let diverged = false;
  const steps = Math.max(left.length, right.length);
  for (let index = 0; index < steps; index++) {
    const leftStep = (left[index] ?? left.at(-1)) as GrammarDerivationStep;
    const rightStep = (right[index] ?? right.at(-1)) as GrammarDerivationStep;
    const leftUse = left[index]?.production ?? null;
    const rightUse = right[index]?.production ?? null;
    const partsHere = !diverged && index > 0 && leftUse !== rightUse;
    if (partsHere) diverged = true;
    const state: GrammarTreeComparisonStep = {
      left: { step: leftStep, production: leftUse },
      right: { step: rightStep, production: rightUse },
      diverged,
    };
    if (index === 0) {
      recorder.add(
        'Two trees, one sentence',
        `The sentence ${sentence} has two different parse trees. A grammar with any such sentence is ambiguous. Step through both leftmost derivations to see where they part.`,
        state,
      );
    } else if (partsHere) {
      recorder.add(
        'The derivations part here',
        `Both have the same sentential form so far, but the first tree uses ${name(leftUse)} and the second uses ${name(rightUse)}. Two different choices that still reach the same sentence: that is ambiguity.`,
        state,
      );
    } else if (index === steps - 1) {
      recorder.add(
        'Both reach the sentence',
        `The two derivations end at the same sentence, ${sentence}, by different routes. A parser for this grammar has to choose, and the choice can change the meaning.`,
        state,
      );
    } else if (diverged) {
      recorder.add(
        'Still different',
        `First tree: ${leftStep.form.join(' ')}. Second tree: ${rightStep.form.join(' ')}.`,
        state,
      );
    } else {
      recorder.add(
        'Same so far',
        `Both derivations use ${name(leftUse)}, giving ${leftStep.form.join(' ')}.`,
        state,
      );
    }
  }
  return recorder.finish();
}

function noWitnessTrace(message: string): Trace<GrammarTreeComparisonStep> {
  const recorder = new TraceRecorder<GrammarTreeComparisonStep>();
  recorder.add('No ambiguity found', message, { left: null, right: null, diverged: false });
  return recorder.finish();
}

/**
 * Searches for a sentence with two different parse trees. Ambiguity of a context-free grammar is
 * undecidable, so no program can always answer this: the search is bounded, and finding nothing
 * only means nothing was found inside the bound. Finding a witness is a real proof, though.
 *
 * It builds, shortest strings first, a table of which strings each nonterminal derives and how.
 * The first time one (nonterminal, string) pair gets a second derivation, that is ambiguity. If
 * the nonterminal is not the start symbol, the witness wraps its string in a shortest derivation
 * from the start symbol, so what comes back is always a complete sentence.
 */
export function grammarFindAmbiguity(
  grammar: Grammar,
  options: GrammarAmbiguityOptions = {},
): GrammarAmbiguityResult {
  const maxLength = Math.min(
    MAX_AMBIGUITY_LENGTH,
    Math.max(0, options.maxLength ?? DEFAULT_AMBIGUITY_LENGTH),
  );
  const maxSentences = options.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const maxWork = options.maxWork ?? DEFAULT_MAX_WORK;
  const bound = { maxLength, maxSentences, maxWork };
  const info = grammarUsefulInfo(grammar);

  if (info.useful.length === 0) {
    const message = `${grammar.start} derives no string of terminals, so this grammar has no sentences to be ambiguous about.`;
    return {
      witness: null,
      bound,
      checkedLength: maxLength,
      stoppedBy: 'no-sentences',
      sentencesSeen: 0,
      message,
      trace: noWitnessTrace(message),
    };
  }

  // Each terminal becomes one character, so joining strings is just joining text.
  const terminalCode = new Map(
    grammar.terminals.map((terminal, index) => [terminal, String.fromCharCode(0x100 + index)]),
  );
  const terminalAt = (code: string) => grammar.terminals[code.charCodeAt(0) - 0x100] as string;
  const table: ChartTable = new Map();
  const nonterminalIndex = new Map(grammar.nonterminals.map((name, index) => [name, index]));
  const wordsBy = grammar.nonterminals.map(() =>
    Array.from({ length: maxLength + 1 }, () => [] as string[]),
  );
  const wordKey = (symbol: string, word: string) => `${symbol}|${word}`;

  let work = 0;
  let sentencesSeen = 0;
  // In an object because the search below sets these from inside a closure.
  const search = {
    stoppedBy: 'length' as GrammarAmbiguityStop,
    found: null as { symbol: string; word: string } | null,
  };
  let halted = false;
  let checkedLength = -1;

  for (let length = 0; length <= maxLength && !halted; length++) {
    let changed = true;
    const walk = (
      production: GrammarProduction,
      rest: readonly number[],
      index: number,
      remaining: number,
      word: string,
      children: readonly ChartChild[],
    ): void => {
      if (halted) return;
      if (++work > maxWork) {
        search.stoppedBy = 'work';
        halted = true;
        return;
      }
      const symbol = production.body[index];
      if (symbol === undefined) {
        if (remaining !== 0) return;
        const key = wordKey(production.head, word);
        const isNew = !table.has(key);
        const derivation: ChartDerivation = {
          production: production.id,
          children,
          signature: `${production.id}/${children
            .map((child) =>
              'terminal' in child
                ? 't'
                : `${child.key.length - child.nonterminal.length}#${child.which}`,
            )
            .join(',')}`,
        };
        if (!addChartDerivation(table, key, derivation)) return;
        changed = true;
        if (isNew) {
          sentencesSeen++;
          (wordsBy[nonterminalIndex.get(production.head) as number]?.[length] as string[]).push(
            word,
          );
          if (sentencesSeen > maxSentences) {
            search.stoppedBy = 'sentences';
            halted = true;
          }
        } else if (!halted) {
          search.found = { symbol: production.head, word };
          search.stoppedBy = 'found';
          halted = true;
        }
        return;
      }
      const after = rest[index + 1] as number;
      if (!info.isNonterminal(symbol)) {
        if (remaining - 1 >= after) {
          walk(
            production,
            rest,
            index + 1,
            remaining - 1,
            word + (terminalCode.get(symbol) as string),
            [...children, { terminal: symbol }],
          );
        }
        return;
      }
      const words = wordsBy[nonterminalIndex.get(symbol) as number] as string[][];
      const shortest = info.minLength.get(symbol) as number;
      for (let piece = shortest; piece + after <= remaining && !halted; piece++) {
        const list = words[piece] as string[];
        // By index, because a same-length entry can grow while this runs. The next pass sees it.
        for (let at = 0; at < list.length && !halted; at++) {
          const piecedWord = list[at] as string;
          const key = wordKey(symbol, piecedWord);
          const derivationCount = (table.get(key) as ChartDerivation[]).length;
          for (let which = 0; which < derivationCount && !halted; which++) {
            walk(production, rest, index + 1, remaining - piece, word + piecedWord, [
              ...children,
              { nonterminal: symbol, key, which },
            ]);
          }
        }
      }
    };

    // A unit or nullable step lets one nonterminal depend on another at the same length.
    while (changed && !halted) {
      changed = false;
      for (const production of info.useful) {
        const rest = info.restLength.get(production.id) as readonly number[];
        if ((rest[0] as number) <= length) walk(production, rest, 0, length, '', []);
        if (halted) break;
      }
    }
    if (!halted) checkedLength = length;
  }

  const { stoppedBy, found: witnessAt } = search;
  if (witnessAt) {
    const key = wordKey(witnessAt.symbol, witnessAt.word);
    const first = buildChartTree(grammar, info, table, witnessAt.symbol, key, 0);
    const second = buildChartTree(grammar, info, table, witnessAt.symbol, key, 1);
    const sentence = grammarTreeYield(first);
    const trees: [GrammarParseTree, GrammarParseTree] = [first, second];
    const shown = sentence.join(' ') || 'the empty string';
    return {
      witness: {
        sentence,
        nonterminal: witnessAt.symbol,
        fragment: [...witnessAt.word].map(terminalAt),
        trees,
      },
      bound,
      checkedLength,
      stoppedBy: 'found',
      sentencesSeen,
      message: `This grammar is ambiguous: ${shown} has two different parse trees. This one is a proof, because a single such sentence is enough.`,
      trace: grammarCompareTrees(grammar, trees),
    };
  }

  const reason =
    stoppedBy === 'length'
      ? `every string of up to ${maxLength} tokens was checked`
      : stoppedBy === 'sentences'
        ? `the search stopped after remembering ${maxSentences} strings, with every string of up to ${Math.max(0, checkedLength)} tokens checked`
        : `the search stopped after ${maxWork} steps, with every string of up to ${Math.max(0, checkedLength)} tokens checked`;
  const message = `No sentence with two parse trees was found: ${reason}. This is a bounded search and not a proof. Deciding ambiguity is impossible in general, so a longer sentence could still have two trees.`;
  return {
    witness: null,
    bound,
    checkedLength,
    stoppedBy,
    sentencesSeen,
    message,
    trace: noWitnessTrace(message),
  };
}
