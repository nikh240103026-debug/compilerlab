// gradeAnswer is the one place a question is marked. It runs in the Web Worker through the
// gradeAnswer job, for the lessons and the tests alike, so a question means the same everywhere.
import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { UNANSWERED_GRADE, isAnswerEmpty } from '@compilerlab/shared/assessment';
import { gradeWithEngine, isEngineQuestion } from './grade-engine';

type Question<T extends PracticeProblem['type']> = Extract<PracticeProblem, { type: T }>;
type Answer<T extends QuestionAnswer['type']> = Extract<QuestionAnswer, { type: T }>;

function byKey(score: number, summary: string, rest: Partial<GradeResult> = {}): GradeResult {
  return {
    verdict: score >= 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect',
    score,
    summary,
    details: [],
    gradedBy: 'answer-key',
    ...rest,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function gradeMcq(question: Question<'mcq'>, answer: Answer<'mcq'>): GradeResult {
  return answer.choice === question.answer
    ? byKey(1, 'Correct.')
    : byKey(0, 'That is not the right option.');
}

function gradeMulti(question: Question<'multi'>, answer: Answer<'multi'>): GradeResult {
  const right = new Set(question.answers);
  const chosen = new Set(answer.choices);
  const hits = [...chosen].filter((choice) => right.has(choice)).length;
  const wrong = chosen.size - hits;
  const parts: Record<string, boolean> = {};
  question.options.forEach((_, index) => {
    parts[index] = chosen.has(index) === right.has(index);
  });
  if (hits === right.size && wrong === 0)
    return byKey(1, 'Correct. Those are exactly the right ones.', { parts });
  // A wrong tick cancels a right one, so ticking every box earns nothing.
  return byKey(
    Math.max(0, (hits - wrong) / right.size),
    `You found ${hits} of the ${plural(right.size, 'right answer')}, and ticked ${plural(wrong, 'wrong one')}.`,
    { parts },
  );
}

function normalizeBlank(text: string, caseSensitive: boolean | undefined): string {
  const squeezed = text.trim().replace(/\s+/g, ' ');
  return caseSensitive ? squeezed : squeezed.toLowerCase();
}

function gradeFill(question: Question<'fill'>, answer: Answer<'fill'>): GradeResult {
  const parts: Record<string, boolean> = {};
  const expected: Record<string, string> = {};
  question.blanks.forEach((accepted, index) => {
    const given = normalizeBlank(answer.blanks[index] ?? '', question.caseSensitive);
    parts[index] = accepted.some(
      (option) => normalizeBlank(option, question.caseSensitive) === given,
    );
    expected[index] = accepted[0] as string;
  });
  const right = Object.values(parts).filter(Boolean).length;
  const total = question.blanks.length;
  return byKey(
    right / total,
    right === total ? 'Correct.' : `${right} of ${plural(total, 'blank')} are right.`,
    { parts, expected },
  );
}

function gradeMatch(question: Question<'match'>, answer: Answer<'match'>): GradeResult {
  const parts: Record<string, boolean> = {};
  const expected: Record<string, string> = {};
  question.pairs.forEach((pair, index) => {
    parts[index] = answer.choices[index] === pair;
    expected[index] = question.right[pair] as string;
  });
  const right = Object.values(parts).filter(Boolean).length;
  const total = question.pairs.length;
  return byKey(
    right / total,
    right === total ? 'Correct.' : `${right} of ${plural(total, 'pair')} are right.`,
    { parts, expected },
  );
}

/** `items` is written in the right order, so item i belongs at position i. */
function gradeOrder(question: Question<'order'>, answer: Answer<'order'>): GradeResult {
  const parts: Record<string, boolean> = {};
  const expected: Record<string, string> = {};
  question.items.forEach((item, position) => {
    parts[position] = answer.order[position] === position;
    expected[position] = item;
  });
  const right = Object.values(parts).filter(Boolean).length;
  const total = question.items.length;
  return byKey(
    right / total,
    right === total
      ? 'Correct. That is the right order.'
      : `${right} of ${plural(total, 'step')} are in the right place.`,
    { parts, expected },
  );
}

/** Line endings and spaces at the ends of lines never decide whether an output is right. */
function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function gradeOutput(question: Question<'output'>, answer: Answer<'output'>): GradeResult {
  return normalizeOutput(answer.text) === normalizeOutput(question.expected)
    ? byKey(1, 'Correct. That is exactly what it prints.')
    : byKey(0, 'That is not what this program prints.', { expected: { 0: question.expected } });
}

/** A short answer waits for the student's own mark, or for AI if there is a key. */
const SHORT_PENDING: GradeResult = {
  verdict: 'pending',
  score: 0,
  summary: 'Compare your answer with the solution, then mark it.',
  details: [],
  gradedBy: 'self',
};

/**
 * Marks one answer. Nothing here depends on who is asking, and bad input comes back as a readable
 * verdict, not an error. See grade-engine.ts for the question types the engine proves.
 */
export function gradeAnswer(question: PracticeProblem, answer: QuestionAnswer | null): GradeResult {
  if (!answer || isAnswerEmpty(answer) || answer.type !== question.type) return UNANSWERED_GRADE;
  if (isEngineQuestion(question)) return gradeWithEngine(question, answer);
  switch (question.type) {
    case 'mcq':
      return gradeMcq(question, answer as Answer<'mcq'>);
    case 'multi':
      return gradeMulti(question, answer as Answer<'multi'>);
    case 'fill':
      return gradeFill(question, answer as Answer<'fill'>);
    case 'match':
      return gradeMatch(question, answer as Answer<'match'>);
    case 'order':
      return gradeOrder(question, answer as Answer<'order'>);
    case 'output':
      return gradeOutput(question, answer as Answer<'output'>);
    case 'short':
      return SHORT_PENDING;
  }
}
