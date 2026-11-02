import { subsetConstruct, MAX_DFA_STATES, epsilonClosure, indexNfa } from '../automata/subset';
import { thompson } from '../automata/thompson';
import { NO_TRANSITION, type Dfa, type Nfa, type NfaTransition } from '../automata/types';
import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { atomIndexOf, formatChar } from '../regex/charset';
import { parseRegex } from '../regex/parser';

export const TOKEN_CATEGORIES = [
  'keyword',
  'identifier',
  'literal',
  'operator',
  'punctuation',
  'comment',
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export interface LexRule {
  name: string;
  pattern: string;
  /** Matched but not passed to the parser, like whitespace and comments. */
  skip?: boolean;
  category?: TokenCategory;
}

export interface LexWarning {
  rule: string;
  message: string;
}

export interface Lexer {
  rules: LexRule[];
  dfa: Dfa;
  warnings: LexWarning[];
}

export interface Token {
  type: string;
  lexeme: string;
  /** Offsets count code points, so they index the same array the scanner reads. */
  start: number;
  end: number;
  line: number;
  column: number;
  skipped: boolean;
  category?: TokenCategory;
}

export interface LexError {
  message: string;
  lexeme: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export type ScanAction = 'begin' | 'read' | 'stuck' | 'emit' | 'skip' | 'error' | 'done';

export interface ScanState {
  action: ScanAction;
  /** Where the current lexeme begins. */
  lexemeStart: number;
  /** The next character to read. */
  forward: number;
  dfaState: number | null;
  /** The longest match seen so far for this lexeme. */
  lastAccept: { rule: number; end: number } | null;
  /** How many items of the result's tokens and errors exist at this step. */
  tokenCount: number;
  errorCount: number;
}

export interface ScanResult {
  tokens: Token[];
  errors: LexError[];
}

export interface TracedScanResult extends ScanResult {
  /** The input, one code point per entry. Trace offsets index this. */
  input: string[];
  trace: Trace<ScanState>;
}

export const MAX_TRACED_INPUT = 4000;

/** Compiles rules into one DFA: earlier rules win ties, and longest match is up to the scanner. */
export function buildLexer(rules: readonly LexRule[]): Lexer {
  if (rules.length === 0) {
    throw new EngineError({
      code: 'no_rules',
      message: 'A lexer needs at least one rule.',
      hint: 'Add a line like: NUMBER [0-9]+',
    });
  }

  const seen = new Set<string>();
  const parts: { nfa: Nfa; offset: number }[] = [];
  let nextState = 1;
  for (const rule of rules) {
    if (seen.has(rule.name)) {
      throw new EngineError({
        code: 'duplicate_rule',
        message: `There are two rules named ${rule.name}.`,
        hint: 'Give each rule its own name.',
      });
    }
    seen.add(rule.name);
    let nfa: Nfa;
    try {
      nfa = thompson(parseRegex(rule.pattern)).nfa;
    } catch (error) {
      if (error instanceof EngineError) {
        throw new EngineError({
          ...error.info,
          code: 'bad_rule_pattern',
          message: `Rule ${rule.name}: ${error.info.message}`,
        });
      }
      throw error;
    }
    const index = indexNfa(nfa);
    if (epsilonClosure(index, [nfa.start]).some((state) => nfa.accepts.includes(state))) {
      throw new EngineError({
        code: 'rule_matches_empty',
        message: `Rule ${rule.name} can match the empty string, so the scanner could stop making progress.`,
        hint: 'Require at least one character, for example by using + instead of *.',
      });
    }
    parts.push({ nfa, offset: nextState });
    nextState += nfa.stateCount;
  }

  // One start state with an ε-edge into each rule's NFA.
  const transitions: NfaTransition[] = [];
  const acceptRule: Record<number, number> = {};
  const accepts: number[] = [];
  parts.forEach(({ nfa, offset }, ruleIndex) => {
    transitions.push({ from: 0, to: nfa.start + offset, on: null });
    for (const { from, to, on } of nfa.transitions) {
      transitions.push({ from: from + offset, to: to + offset, on });
    }
    for (const accept of nfa.accepts) {
      accepts.push(accept + offset);
      acceptRule[accept + offset] = ruleIndex;
    }
  });
  const combined: Nfa = { stateCount: nextState, start: 0, accepts, transitions, acceptRule };
  const { dfa } = subsetConstruct(combined, MAX_DFA_STATES);

  // A rule whose accepting state never wins any DFA state can never produce a token.
  const winners = new Set(dfa.acceptRule);
  const warnings: LexWarning[] = rules.flatMap((rule, ruleIndex) => {
    if (winners.has(ruleIndex)) return [];
    const part = parts[ruleIndex] as (typeof parts)[number];
    const acceptState = (part.nfa.accepts[0] as number) + part.offset;
    const stateWhereItLoses = dfa.sources.findIndex((states) => states.includes(acceptState));
    const winner = dfa.acceptRule?.[stateWhereItLoses];
    const winnerName = winner === null || winner === undefined ? null : rules[winner]?.name;
    return [
      {
        rule: rule.name,
        message: `Rule ${rule.name} can never match: every string it matches is claimed by ${winnerName ? `the earlier rule ${winnerName}` : 'an earlier rule'}. Move it higher up.`,
      },
    ];
  });

  return { rules: [...rules], dfa, warnings };
}

function lineStarts(input: readonly string[]): number[] {
  const starts = [0];
  input.forEach((char, i) => {
    if (char === '\n') starts.push(i + 1);
  });
  return starts;
}

function locate(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}

const pointOf = (char: string) => char.codePointAt(0) as number;

const showLexeme = (lexeme: string) =>
  `"${[...lexeme].map((c) => formatChar(pointOf(c))).join('')}"`;

/**
 * Runs the scanner: maximal munch from each position, with panic-mode recovery that deletes
 * characters no rule can start with. Bad input never stops the scan, it just records errors.
 */
function scan(lexer: Lexer, inputText: string, recorder: TraceRecorder<ScanState> | null) {
  const { dfa, rules } = lexer;
  const input = [...inputText];
  const starts = lineStarts(input);
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const stateName = (state: number) => dfa.names[state] as string;
  const acceptRule = dfa.acceptRule as (number | null)[];

  let lexemeStart = 0;

  const record = (
    action: ScanAction,
    title: string,
    explanation: string,
    forward: number,
    dfaState: number | null,
    lastAccept: ScanState['lastAccept'],
  ) => {
    recorder?.add(title, explanation, {
      action,
      lexemeStart,
      forward,
      dfaState,
      lastAccept,
      tokenCount: tokens.length,
      errorCount: errors.length,
    });
  };

  while (lexemeStart < input.length) {
    let state = dfa.start;
    let forward = lexemeStart;
    let lastAccept: ScanState['lastAccept'] = null;
    const { line, column } = locate(starts, lexemeStart);

    record(
      'begin',
      `New lexeme at ${line}:${column}`,
      `Start a new lexeme here. Both pointers sit on the next unread character, and the DFA goes back to its start state, ${stateName(state)}.`,
      forward,
      state,
      null,
    );

    while (forward < input.length) {
      const char = input[forward] as string;
      const symbol = atomIndexOf(dfa.alphabet, pointOf(char));
      const target =
        symbol === -1 ? NO_TRANSITION : ((dfa.delta[state] as number[])[symbol] as number);
      const shown = formatChar(pointOf(char));
      if (target === NO_TRANSITION) {
        record(
          'stuck',
          `Stuck on ${shown}`,
          `State ${stateName(state)} has no move on ${shown}, so no longer match is possible. ${lastAccept ? 'The scanner falls back to the last accepting point it saw.' : 'No rule has matched yet.'}`,
          forward,
          state,
          lastAccept,
        );
        break;
      }
      state = target;
      forward++;
      const rule = acceptRule[state];
      if (rule !== null && rule !== undefined) {
        lastAccept = { rule, end: forward };
        record(
          'read',
          `Read ${shown}: matches ${(rules[rule] as LexRule).name}`,
          `Moved to state ${stateName(state)}, which accepts ${(rules[rule] as LexRule).name}. Remember this match, but keep reading, because a longer one may exist.`,
          forward,
          state,
          lastAccept,
        );
      } else {
        record(
          'read',
          `Read ${shown}`,
          `Moved to state ${stateName(state)}, which is not accepting. Keep reading.`,
          forward,
          state,
          lastAccept,
        );
      }
    }

    if (lastAccept) {
      const rule = rules[lastAccept.rule] as LexRule;
      const lexeme = input.slice(lexemeStart, lastAccept.end).join('');
      const skipped = rule.skip === true;
      tokens.push({
        type: rule.name,
        lexeme,
        start: lexemeStart,
        end: lastAccept.end,
        line,
        column,
        skipped,
        ...(rule.category ? { category: rule.category } : {}),
      });
      const backedUp = forward - lastAccept.end;
      record(
        skipped ? 'skip' : 'emit',
        skipped ? `Skip ${rule.name}` : `Emit ${rule.name}`,
        `${backedUp > 0 ? `Back up ${backedUp} character${backedUp === 1 ? '' : 's'} to the last accepting point. ` : ''}The longest match is ${showLexeme(lexeme)}, from rule ${rule.name}. ${skipped ? 'This rule is marked skip, so no token goes to the parser.' : `The token ⟨${rule.name}, ${showLexeme(lexeme)}⟩ goes to the parser.`}`,
        lastAccept.end,
        null,
        lastAccept,
      );
      lexemeStart = lastAccept.end;
      continue;
    }

    // Panic mode: delete this character and retry. Adjacent bad characters share one error.
    const char = input[lexemeStart] as string;
    const previous = errors.at(-1);
    let message: string;
    if (previous && previous.end === lexemeStart) {
      previous.lexeme += char;
      previous.end = lexemeStart + 1;
      previous.message = `No rule matches ${showLexeme(previous.lexeme)}.`;
      message = previous.message;
    } else {
      message = `No rule matches ${showLexeme(char)}.`;
      errors.push({
        message,
        lexeme: char,
        start: lexemeStart,
        end: lexemeStart + 1,
        line,
        column,
      });
    }
    record(
      'error',
      `Lexical error at ${line}:${column}`,
      `${message} Panic-mode recovery deletes this character and tries again from the next one, so one bad character does not stop the scan.`,
      lexemeStart + 1,
      null,
      null,
    );
    lexemeStart++;
  }

  const visible = tokens.filter((token) => !token.skipped).length;
  record(
    'done',
    'End of input',
    `The whole input has been read: ${visible} token${visible === 1 ? '' : 's'} for the parser${errors.length > 0 ? ` and ${errors.length} error${errors.length === 1 ? '' : 's'}` : ''}.`,
    input.length,
    null,
    null,
  );

  return { tokens, errors, input };
}

export function tokenize(lexer: Lexer, input: string): ScanResult {
  const { tokens, errors } = scan(lexer, input, null);
  return { tokens, errors };
}

export function traceTokenize(lexer: Lexer, input: string): TracedScanResult {
  if ([...input].length > MAX_TRACED_INPUT) {
    throw new EngineError({
      code: 'input_too_long',
      message: `This input is longer than the ${MAX_TRACED_INPUT} characters the player can animate.`,
      hint: 'Try a shorter piece of code.',
    });
  }
  const recorder = new TraceRecorder<ScanState>();
  const result = scan(lexer, input, recorder);
  return { ...result, trace: recorder.finish() };
}
