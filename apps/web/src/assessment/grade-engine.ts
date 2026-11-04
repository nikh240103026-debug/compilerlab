// The question types the engine marks, because it can work out the right answer itself. The engine
// is the source of truth, so these can never disagree with what the visualizers show.
import {
  EngineError,
  dfaEquivalent,
  formatGrammarProduction,
  grammarChartParse,
  grammarCheckSets,
  grammarFindAmbiguity,
  grammarLeftRecursion,
  ll1BuildTable,
  ll1Parse,
  lrBuildTable,
  lrParse,
  parseGrammar,
  parseRegex,
  subsetConstruct,
  thompson,
  type Dfa,
  type EngineErrorInfo,
  type GrammarParserRun,
  type GrammarSetAnswer,
} from '@compilerlab/engine';
import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { buildAutomaton } from '../visualizers/builder-model';
import { isLrCellGiven, lrCellValues, sentenceTokens, type TableSpec } from './question-model';
import { traceMoveLabel } from './trace-moves';

type Question<T extends PracticeProblem['type']> = Extract<PracticeProblem, { type: T }>;
type Answer<T extends QuestionAnswer['type']> = Extract<QuestionAnswer, { type: T }>;

export type EngineQuestion = Question<'regex' | 'table' | 'automaton' | 'grammar' | 'trace'>;

export function isEngineQuestion(question: PracticeProblem): question is EngineQuestion {
  return ['regex', 'table', 'automaton', 'grammar', 'trace'].includes(question.type);
}

// Long enough to find the usual ambiguous examples, and still quick on a student's grammar.
const AMBIGUITY_LENGTH = 10;
const AMBIGUITY_WORK = 400_000;

function byEngine(score: number, summary: string, rest: Partial<GradeResult> = {}): GradeResult {
  return {
    verdict: score >= 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect',
    score,
    summary,
    details: [],
    gradedBy: 'engine',
    ...rest,
  };
}

const dfaOf = (regex: string): Dfa => subsetConstruct(thompson(parseRegex(regex)).nfa).dfa;
const showString = (text: string) => (text === '' ? 'the empty string' : `"${text}"`);

function gradeRegex(question: Question<'regex'>, answer: Answer<'regex'>): GradeResult {
  const outcome = dfaEquivalent(dfaOf(answer.text), dfaOf(question.reference));
  if (outcome.equivalent)
    return byEngine(1, 'Correct. Your expression describes exactly this language.');
  const shown = showString(outcome.witness);
  return byEngine(
    0,
    outcome.acceptedBy === 'first'
      ? `Your expression matches ${shown}, which is not in the language.`
      : `Your expression misses ${shown}, which is in the language.`,
    { counterexample: outcome.witness },
  );
}

function gradeAutomaton(question: Question<'automaton'>, answer: Answer<'automaton'>): GradeResult {
  const built = buildAutomaton(answer.drawing);
  if (!built.ok) {
    return byEngine(0, 'This automaton is not finished yet.', { details: built.problems });
  }
  if (question.machine === 'dfa' && built.kind !== 'DFA') {
    return byEngine(0, `The question asks for a DFA, and this is an ${built.kind}.`, {
      details: [
        built.kind === 'NFA'
          ? 'Some state has more than one move on the same symbol.'
          : 'It has a move that reads no input.',
      ],
    });
  }
  const outcome = dfaEquivalent(subsetConstruct(built.nfa).dfa, dfaOf(question.reference));
  if (!outcome.equivalent) {
    const shown = showString(outcome.witness);
    return byEngine(
      0,
      outcome.acceptedBy === 'first'
        ? `Your automaton accepts ${shown}, which is not in the language.`
        : `Your automaton rejects ${shown}, which is in the language.`,
      { counterexample: outcome.witness },
    );
  }
  const count = answer.drawing.states.length;
  if (question.maxStates !== undefined && count > question.maxStates) {
    return byEngine(
      0.5,
      `It accepts the right language, but it has ${count} states and the question asks for at most ${question.maxStates}.`,
    );
  }
  return byEngine(1, 'Correct. Your automaton accepts exactly this language.');
}

function gradeGrammar(question: Question<'grammar'>, answer: Answer<'grammar'>): GradeResult {
  const grammar = parseGrammar(answer.text);
  const derives = (sentence: string) =>
    grammarChartParse(grammar, sentenceTokens(sentence)).accepted;
  const missed = question.accepts.filter((sentence) => !derives(sentence));
  const wronglyDerived = question.rejects.filter(derives);

  const failedRequirements: string[] = [];
  for (const requirement of question.requires ?? []) {
    if (requirement === 'll1') {
      const table = ll1BuildTable(grammar);
      if (!table.isLl1) {
        failedRequirements.push(
          `The grammar must be LL(1), and it is not. ${table.conflicts[0]?.message ?? ''}`.trim(),
        );
      }
    } else if (requirement === 'no-left-recursion') {
      const found = grammarLeftRecursion(grammar);
      if (found.length > 0) {
        failedRequirements.push(
          `The grammar must have no left recursion, and these nonterminals have it: ${found.map(({ symbol }) => symbol).join(', ')}.`,
        );
      }
    } else {
      const { witness } = grammarFindAmbiguity(grammar, {
        maxLength: AMBIGUITY_LENGTH,
        maxWork: AMBIGUITY_WORK,
      });
      if (witness) {
        failedRequirements.push(
          `The grammar must be unambiguous, and "${witness.sentence.join(' ')}" has two parse trees.`,
        );
      }
    }
  }

  const checks =
    question.accepts.length + question.rejects.length + (question.requires?.length ?? 0);
  const failed = missed.length + wronglyDerived.length + failedRequirements.length;

  // Only the first wrong sentence is named, so the feedback points at a mistake without giving the
  // whole list away.
  const details: string[] = [];
  const firstMissed = missed[0];
  const firstWrong = wronglyDerived[0];
  if (firstMissed !== undefined) {
    details.push(`Your grammar cannot derive ${showString(firstMissed)}, and it should.`);
  }
  if (firstWrong !== undefined) {
    details.push(`Your grammar derives ${showString(firstWrong)}, and it should not.`);
  }
  details.push(...failedRequirements);

  const known = new Set([...question.accepts, ...question.rejects].flatMap(sentenceTokens));
  const unexpected = grammar.terminals.filter((terminal) => !known.has(terminal));
  if (failed > 0 && unexpected.length > 0) {
    details.push(
      `These are terminals in your grammar, but in none of the examples: ${unexpected.join(', ')}. If one was meant to be several symbols, put spaces between them, as in a S b.`,
    );
  }

  if (failed === 0) {
    return byEngine(1, 'Correct. Your grammar passes every check.', { details });
  }
  return byEngine(
    (checks - failed) / checks,
    `Your grammar passes ${checks - failed} of ${checks} checks.`,
    {
      details,
      ...(firstMissed !== undefined
        ? { counterexample: firstMissed }
        : firstWrong !== undefined
          ? { counterexample: firstWrong }
          : {}),
    },
  );
}

function gradeFirstFollow(
  spec: Extract<TableSpec, { kind: 'first-follow' }>,
  answer: Answer<'table'>,
): GradeResult {
  const grammar = parseGrammar(spec.grammar);
  const sets: readonly ('first' | 'follow')[] = spec.sets ?? ['first', 'follow'];
  const answers: GrammarSetAnswer[] = sets.flatMap((kind) =>
    grammar.nonterminals.map((symbol) => ({
      kind,
      symbol,
      text: answer.cells[`${kind}:${symbol}`] ?? '',
    })),
  );
  const asked = grammarCheckSets(grammar, answers).verdicts.filter(({ kind }) =>
    sets.includes(kind),
  );
  const parts: Record<string, boolean> = {};
  const expected: Record<string, string> = {};
  for (const { kind, symbol, correct, expected: items } of asked) {
    parts[`${kind}:${symbol}`] = correct;
    expected[`${kind}:${symbol}`] = items.join(', ') || 'empty';
  }
  const right = asked.filter(({ correct }) => correct).length;
  return byEngine(
    right / asked.length,
    right === asked.length
      ? 'Correct. Every set matches what the engine computes.'
      : `${right} of ${asked.length} sets match what the engine computes.`,
    { parts, expected },
  );
}

/**
 * Marks a table where most cells stay empty. Empty cells a student rightly left alone earn nothing,
 * or an untouched parsing table would score highly, so a cell counts only if it should hold
 * something or the student wrote something in it.
 */
function gradeSparseTable(
  keys: readonly string[],
  expectedOf: (key: string) => readonly string[],
  givenOf: (key: string) => string,
  matches: (given: string, expected: string) => boolean,
): GradeResult {
  const parts: Record<string, boolean> = {};
  const expected: Record<string, string> = {};
  for (const key of keys) {
    const wanted = expectedOf(key);
    const given = givenOf(key).trim();
    if (wanted.length === 0 && given === '') continue;
    parts[key] = wanted.some((value) => matches(given, value));
    expected[key] = wanted.join(' or ') || 'empty';
  }
  const counted = Object.keys(parts).length;
  const right = Object.values(parts).filter(Boolean).length;
  return byEngine(
    counted === 0 ? 1 : right / counted,
    right === counted
      ? 'Correct. Every cell matches.'
      : `${right} of the ${counted} cells that matter are right.`,
    { parts, expected },
  );
}

function gradeLl1(spec: Extract<TableSpec, { kind: 'll1' }>, answer: Answer<'table'>): GradeResult {
  const table = ll1BuildTable(parseGrammar(spec.grammar));
  const labelOf = (id: number) => {
    const production = table.grammar.productions[id];
    return production ? formatGrammarProduction(production) : '';
  };
  const keys = table.nonterminals.flatMap((_, row) =>
    table.terminals.map((_terminal, column) => `${row}:${column}`),
  );
  return gradeSparseTable(
    keys,
    (key) => {
      const [row = 0, column = 0] = key.split(':').map(Number);
      return (table.cells[row]?.[column] ?? []).map(labelOf);
    },
    (key) => answer.cells[key] ?? '',
    (given, expected) => given === expected,
  );
}

/** s5, S 5 and s5 are the same action, and so are acc and accept. */
function normalizeAction(text: string): string {
  const squeezed = text.replace(/\s+/g, '').toLowerCase();
  return squeezed === 'accept' ? 'acc' : squeezed;
}

function gradeLr(spec: Extract<TableSpec, { kind: 'lr' }>, answer: Answer<'table'>): GradeResult {
  const table = lrBuildTable(parseGrammar(spec.grammar), spec.parser);
  const values = lrCellValues(table);
  const keys = values.flatMap((cells, row) =>
    cells.flatMap((_, column) =>
      isLrCellGiven(table, spec, row, column) ? [] : [`${row}:${column}`],
    ),
  );
  return gradeSparseTable(
    keys,
    (key) => {
      const [row = 0, column = 0] = key.split(':').map(Number);
      return values[row]?.[column] ?? [];
    },
    (key) => answer.cells[key] ?? '',
    (given, expected) => normalizeAction(given) === normalizeAction(expected),
  );
}

/** Spaces and case do not matter, and a set is the same set in any order. */
function normalizeCell(text: string, caseSensitive: boolean | undefined): string {
  const squeezed = text.replace(/\s+/g, '');
  const cased = caseSensitive ? squeezed : squeezed.toLowerCase();
  if (cased === '∅') return '{}';
  if (!cased.startsWith('{') || !cased.endsWith('}')) return cased;
  const items = cased
    .slice(1, -1)
    .split(',')
    .filter((item) => item !== '')
    .sort();
  return `{${items.join(',')}}`;
}

function gradeValues(
  spec: Extract<TableSpec, { kind: 'values' }>,
  answer: Answer<'table'>,
): GradeResult {
  const keys = spec.rows.flatMap((_, row) =>
    spec.columns.flatMap((_column, column) =>
      spec.given?.[row]?.[column] ? [] : [`${row}:${column}`],
    ),
  );
  return gradeSparseTable(
    keys,
    (key) => {
      const [row = 0, column = 0] = key.split(':').map(Number);
      const value = spec.answers[row]?.[column] ?? '';
      return value === '' ? [] : [value];
    },
    (key) => answer.cells[key] ?? '',
    (given, expected) =>
      normalizeCell(given, spec.caseSensitive) === normalizeCell(expected, spec.caseSensitive),
  );
}

function gradeTable(question: Question<'table'>, answer: Answer<'table'>): GradeResult {
  const spec = question.table;
  switch (spec.kind) {
    case 'first-follow':
      return gradeFirstFollow(spec, answer);
    case 'll1':
      return gradeLl1(spec, answer);
    case 'lr':
      return gradeLr(spec, answer);
    case 'values':
      return gradeValues(spec, answer);
  }
}

/** The engine's moves, in the same words a student's are given in. */
export function expectedTraceMoves(run: GrammarParserRun): string[] {
  const labelOf = (id: number | null) => {
    const production = id === null ? undefined : run.grammar.productions[id];
    return production ? formatGrammarProduction(production) : '';
  };
  return run.trace.flatMap(({ state }) => {
    switch (state.move) {
      case 'shift':
      case 'match':
      case 'accept':
        return [state.move];
      case 'reduce':
        return [`reduce:${labelOf(state.production)}`];
      case 'expand':
        return [`expand:${labelOf(state.production)}`];
      case 'reject':
      case 'error':
        return ['error'];
      default:
        return [];
    }
  });
}

function gradeTrace(question: Question<'trace'>, answer: Answer<'trace'>): GradeResult {
  const grammar = parseGrammar(question.grammar);
  const tokens = sentenceTokens(question.input);
  const run =
    question.parser === 'll1'
      ? ll1Parse(ll1BuildTable(grammar), tokens)
      : lrParse(lrBuildTable(grammar, question.parser), tokens);
  const moves = expectedTraceMoves(run);
  const expected = Object.fromEntries(
    moves.map((move, index) => [index, traceMoveLabel(move)] as const),
  );

  let agreed = 0;
  while (agreed < moves.length && answer.moves[agreed] === moves[agreed]) agreed++;
  const parts = Object.fromEntries(
    answer.moves.map((move, index) => [index, move === moves[index]] as const),
  );
  if (agreed === moves.length && answer.moves.length === moves.length) {
    return byEngine(1, 'Correct. Those are exactly the moves the parser makes.', {
      parts,
      expected,
    });
  }

  // Credit stops at the first wrong move, because every later stack depends on it.
  const score = agreed / Math.max(moves.length, answer.moves.length);
  const given = answer.moves[agreed];
  const wanted = moves[agreed];
  const where = `Move ${agreed + 1}: `;
  const summary =
    given === undefined
      ? `${where}your trace stops here, and the parser's next move is: ${traceMoveLabel(wanted as string)}.`
      : wanted === undefined
        ? `${where}the parser has already stopped, so your trace is too long.`
        : `${where}you chose "${traceMoveLabel(given)}", and the parser's move is "${traceMoveLabel(wanted)}".`;
  return byEngine(score, summary, { parts, expected });
}

const describeEngineError = ({ message, hint }: EngineErrorInfo) =>
  hint ? [message, hint] : [message];

export function gradeWithEngine(question: EngineQuestion, answer: QuestionAnswer): GradeResult {
  try {
    switch (question.type) {
      case 'regex':
        return gradeRegex(question, answer as Answer<'regex'>);
      case 'automaton':
        return gradeAutomaton(question, answer as Answer<'automaton'>);
      case 'grammar':
        return gradeGrammar(question, answer as Answer<'grammar'>);
      case 'table':
        return gradeTable(question, answer as Answer<'table'>);
      case 'trace':
        return gradeTrace(question, answer as Answer<'trace'>);
    }
  } catch (error) {
    // Text the engine cannot read gets the same readable message a visualizer shows for it.
    if (error instanceof EngineError) {
      return byEngine(0, 'The engine could not read this answer.', {
        details: describeEngineError(error.info),
      });
    }
    throw error;
  }
}
