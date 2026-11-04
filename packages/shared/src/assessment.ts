// Zod-free, so the browser can use these values. The request schemas are in assessment-schemas.ts.
import type { PracticeProblem } from './content';

export const QUESTION_TYPES = [
  'mcq',
  'multi',
  'short',
  'regex',
  'fill',
  'match',
  'order',
  'table',
  'automaton',
  'grammar',
  'trace',
  'output',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  mcq: 'Multiple choice',
  multi: 'Multiple select',
  short: 'Short answer',
  regex: 'Regular expression',
  fill: 'Fill in the blank',
  match: 'Match the following',
  order: 'Put in order',
  table: 'Complete the table',
  automaton: 'Draw an automaton',
  grammar: 'Write a grammar',
  trace: 'Trace the parser',
  output: 'Predict the output',
};

export const QUESTION_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

/** What a drawn automaton looks like when it is saved. The canvas's own format. */
export interface DrawnAutomaton {
  states: { id: string; label: string; accepting: boolean; x: number; y: number }[];
  transitions: { id: string; from: string; to: string; label: string }[];
  startId: string | null;
}

/** What a student gave. Each question type has its own shape, with the same `type`. */
export type QuestionAnswer =
  | { type: 'mcq'; choice: number | null }
  | { type: 'multi'; choices: number[] }
  | { type: 'short'; text: string }
  | { type: 'regex'; text: string }
  | { type: 'fill'; blanks: string[] }
  /** For each item on the left, the index chosen on the right. */
  | { type: 'match'; choices: (number | null)[] }
  /** Indexes into the question's items, in the order the student put them. */
  | { type: 'order'; order: number[] }
  /** Keyed by cell. See the table question's model for what the keys are. */
  | { type: 'table'; cells: Record<string, string> }
  | { type: 'automaton'; drawing: DrawnAutomaton }
  | { type: 'grammar'; text: string }
  /** Each move as `shift`, `match`, `accept`, `error`, `reduce:E → T` or `expand:E → T`. */
  | { type: 'trace'; moves: string[] }
  | { type: 'output'; text: string };

/** True if nothing has been given yet, so the question counts as skipped. */
export function isAnswerEmpty(answer: QuestionAnswer | null | undefined): boolean {
  if (!answer) return true;
  switch (answer.type) {
    case 'mcq':
      return answer.choice === null;
    case 'multi':
      return answer.choices.length === 0;
    case 'short':
    case 'regex':
    case 'grammar':
    case 'output':
      return answer.text.trim() === '';
    case 'fill':
      return answer.blanks.every((blank) => blank.trim() === '');
    case 'match':
      return answer.choices.every((choice) => choice === null);
    case 'order':
      return answer.order.length === 0;
    case 'table':
      return Object.values(answer.cells).every((cell) => cell.trim() === '');
    case 'automaton':
      return answer.drawing.states.length === 0;
    case 'trace':
      return answer.moves.length === 0;
  }
}

export type GradeVerdict = 'correct' | 'partial' | 'incorrect' | 'pending' | 'unanswered';

/**
 * Who decided: the question's own key, the engine, the student marking themselves, or AI. Only the
 * last two can change a mark after a test ends.
 */
export type GradedBy = 'answer-key' | 'engine' | 'self' | 'ai';

export interface GradeResult {
  /** `pending` is waiting for a person or AI to mark it, and it counts for nothing yet. */
  verdict: GradeVerdict;
  /** The fraction of the marks earned, from 0 to 1. */
  score: number;
  /** One sentence the student reads first. */
  summary: string;
  details: string[];
  gradedBy: GradedBy;
  /** A string that proves a language is wrong. The empty string counts. */
  counterexample?: string | undefined;
  /** Which parts were right: a blank, a table cell or a position in an order. */
  parts?: Record<string, boolean> | undefined;
  /** What each part should have been, shown once the answer has been graded. */
  expected?: Record<string, string> | undefined;
}

/** A whole question graded without any answer. */
export const UNANSWERED_GRADE: GradeResult = {
  verdict: 'unanswered',
  score: 0,
  summary: 'This question was not answered.',
  details: [],
  gradedBy: 'answer-key',
};

export const ASSESSMENT_MODES = [
  'practice',
  'timed',
  'topic',
  'phase',
  'mock',
  'adaptive',
  'retry',
] as const;
export type AssessmentMode = (typeof ASSESSMENT_MODES)[number];

export interface AssessmentModeInfo {
  label: string;
  description: string;
  /** Marks each answer as soon as it is given, and shows the solution and hints. */
  instantFeedback: boolean;
  /** Whether the setup form offers a clock. */
  allowsClock: boolean;
  questionCount: number;
  durationMinutes: number | null;
}

export const ASSESSMENT_MODE_INFO: Readonly<Record<AssessmentMode, AssessmentModeInfo>> = {
  practice: {
    label: 'Practice',
    description: 'No clock. Each answer is marked straight away, with hints and solutions.',
    instantFeedback: true,
    allowsClock: false,
    questionCount: 10,
    durationMinutes: null,
  },
  timed: {
    label: 'Timed test',
    description: 'Any topics, against the clock. Results come at the end.',
    instantFeedback: false,
    allowsClock: true,
    questionCount: 15,
    durationMinutes: 20,
  },
  topic: {
    label: 'Topic test',
    description: 'One topic in depth. A pass counts toward completing that topic.',
    instantFeedback: false,
    allowsClock: true,
    questionCount: 10,
    durationMinutes: 15,
  },
  phase: {
    label: 'Phase test',
    description: 'A whole phase of the compiler, across all of its topics.',
    instantFeedback: false,
    allowsClock: true,
    questionCount: 20,
    durationMinutes: 30,
  },
  mock: {
    label: 'Mock exam',
    description: 'Set the duration, marks, question mix and negative marking yourself.',
    instantFeedback: false,
    allowsClock: true,
    questionCount: 30,
    durationMinutes: 90,
  },
  adaptive: {
    label: 'Adaptive',
    description: 'Questions get harder when you are right and easier when you are not.',
    instantFeedback: true,
    allowsClock: false,
    questionCount: 10,
    durationMinutes: null,
  },
  retry: {
    label: 'Retry mistakes',
    description: 'Only the questions you got wrong in an earlier test.',
    instantFeedback: true,
    allowsClock: false,
    questionCount: 10,
    durationMinutes: null,
  },
};

export type QuestionMix = Partial<Record<QuestionType, number>>;

/** Everything a student chooses when starting a test. */
export interface AttemptConfig {
  mode: AssessmentMode;
  title?: string | undefined;
  topicIds: string[];
  moduleIds: string[];
  questionCount: number;
  /** Null means no clock. */
  durationMinutes: number | null;
  /** Shared out by difficulty. Null gives 1, 2 and 3 marks for easy, medium and hard. */
  totalMarks: number | null;
  /** The fraction of a question's marks lost for a wrong answer, such as 1/3. */
  negativeFraction: number;
  /** As in GATE: only single-answer multiple choice loses marks. */
  negativeMcqOnly: boolean;
  /** How many questions of each type. Null takes any type, up to `questionCount`. */
  mix: QuestionMix | null;
  difficulty: 'any' | QuestionDifficulty;
  exam: 'any' | 'GATE' | 'university';
  /** Which AI-generated questions to include. */
  generated: 'none' | 'reviewed' | 'all';
  /** For retry mode: the attempt whose mistakes to use. */
  retryOf: string | null;
}

/** One question as it stands in a test. The paper is frozen when the test starts. */
export interface PaperQuestion {
  /** The topic and question id together, such as regex-to-dfa/subset-upper-bound. */
  key: string;
  topicId: string;
  moduleId: string;
  topicTitle: string;
  marks: number;
  question: PracticeProblem;
  source: 'course' | 'ai';
  /** The row in generated questions, for an AI-generated question. */
  generatedId: string | null;
  /** False for AI output that nobody has checked. Such a question stays labeled. */
  reviewed: boolean;
}

export interface SavedAnswer {
  key: string;
  answer: QuestionAnswer | null;
  grade: GradeResult | null;
  /** How long this question has been on screen. */
  seconds: number;
  flagged: boolean;
  /** Null until it has been graded. Negative marking can make this negative. */
  earned: number | null;
}

export interface TopicBreakdown {
  topicId: string;
  moduleId: string;
  title: string;
  questions: number;
  correct: number;
  earned: number;
  possible: number;
  /** From 0 to 100, without negative marks, because this measures understanding and not the exam. */
  percent: number;
  seconds: number;
  weak: boolean;
}

export interface AttemptResult {
  score: number;
  maxScore: number;
  /** Of the marks graded so far, from 0 to 100. Marks still waiting to be graded do not count. */
  percent: number;
  correct: number;
  partial: number;
  incorrect: number;
  unanswered: number;
  /** Short answers waiting for the student or AI to mark them. */
  pending: number;
  seconds: number;
  byTopic: TopicBreakdown[];
  /** Weakest first. */
  weakTopics: string[];
}

export type AttemptStatus = 'active' | 'finished';

export interface AttemptView {
  id: string;
  mode: AssessmentMode;
  title: string;
  status: AttemptStatus;
  config: AttemptConfig;
  /** In order. An adaptive test grows this as it goes. */
  questions: PaperQuestion[];
  answers: SavedAnswer[];
  /** Where to resume. */
  currentIndex: number;
  /** All times are in milliseconds since the epoch. */
  startedAt: number;
  /** When the clock runs out, set once on the server, so reloading the page cannot change it. */
  deadlineAt: number | null;
  finishedAt: number | null;
  /** The server's clock when this was sent, so a wrong clock on the page does not matter. */
  serverNow: number;
  /** The difficulty an adaptive test is at now. */
  adaptiveLevel: QuestionDifficulty | null;
  /** True once an adaptive test has served all it is going to. */
  adaptiveDone: boolean;
  /** Anything worth saying about how the paper was built, such as too few questions of a type. */
  notes: string[];
  result: AttemptResult | null;
}

export interface SaveAnswerRequest {
  key: string;
  answer: QuestionAnswer | null;
  /** Set when the answer was marked as it was given. A test grades the rest when it finishes. */
  grade?: GradeResult | null | undefined;
  seconds: number;
  flagged: boolean;
  currentIndex: number;
}

export interface FinishAttemptRequest {
  /** Grades for answers that do not have one yet, by question key. */
  grades: Record<string, GradeResult>;
}

export interface MarkAnswerRequest {
  key: string;
  grade: GradeResult;
}

/** One line in a list of attempts, without the paper. */
export interface AttemptSummary {
  id: string;
  mode: AssessmentMode;
  title: string;
  status: AttemptStatus;
  questionCount: number;
  answeredCount: number;
  /** All null until the attempt finishes. */
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  pending: number;
  seconds: number;
  startedAt: number;
  deadlineAt: number | null;
  finishedAt: number | null;
  serverNow: number;
}

/** A topic's score across all finished tests, from its most recent answers. */
export interface AssessmentTopicScore {
  topicId: string;
  moduleId: string | null;
  title: string;
  questions: number;
  /** From 0 to 100. */
  percent: number;
  lastAnsweredAt: number;
  weak: boolean;
}

/**
 * `GET /api/assessment/summary`, for the dashboard and anything else that reads results.
 * Call it in the browser with `api.assessmentSummary()`.
 */
export interface AssessmentSummary {
  /** Every topic with at least one graded answer, weakest first. */
  topics: AssessmentTopicScore[];
  /** The ones from `topics` that need work, weakest first. */
  weakTopics: AssessmentTopicScore[];
  /** The latest attempts, newest first, including any still in progress. */
  recentAttempts: AttemptSummary[];
  totals: {
    attemptsFinished: number;
    questionsAnswered: number;
    /** The mean of finished attempts' percentages, or null before the first one. */
    averagePercent: number | null;
  };
  flashcards: { total: number; due: number; fresh: number };
}

/** A topic and what can be asked about it, for the setup form. */
export interface CatalogTopic {
  topicId: string;
  moduleId: string;
  title: string;
  order: number;
  total: number;
  byType: Partial<Record<QuestionType, number>>;
  byDifficulty: Record<QuestionDifficulty, number>;
  generated: number;
  generatedReviewed: number;
}

export interface AssessmentCatalog {
  topics: CatalogTopic[];
}

/** What SM-2 remembers about one card. */
export interface Sm2State {
  /** The E-Factor. Never below 1.3. */
  ease: number;
  intervalDays: number;
  /** Successful reviews in a row. A lapse resets this. */
  repetitions: number;
}

export const SM2_NEW_CARD: Sm2State = { ease: 2.5, intervalDays: 0, repetitions: 0 };

/** The grades SM-2 asks for, in its own wording. Anything below 3 counts as forgotten. */
export const SM2_GRADES: readonly { quality: number; label: string; meaning: string }[] = [
  { quality: 0, label: 'Blank', meaning: 'I could not recall it at all.' },
  { quality: 1, label: 'Wrong', meaning: 'Wrong, but I knew it once I saw the answer.' },
  { quality: 2, label: 'Almost', meaning: 'Wrong, but the answer felt easy to recall.' },
  { quality: 3, label: 'Hard', meaning: 'Right, with serious difficulty.' },
  { quality: 4, label: 'Good', meaning: 'Right, after some hesitation.' },
  { quality: 5, label: 'Easy', meaning: 'Right, straight away.' },
];

/**
 * Wozniak's SM-2. Intervals go 1 day, 6 days, then the last interval times the E-Factor, rounded up.
 * A grade below 3 starts the intervals again, and it leaves the E-Factor alone, as SM-2 says to.
 */
export function sm2Next(state: Sm2State, quality: number): Sm2State {
  if (quality < 3) return { ease: state.ease, intervalDays: 1, repetitions: 0 };
  const intervalDays =
    state.repetitions === 0
      ? 1
      : state.repetitions === 1
        ? 6
        : Math.ceil(state.intervalDays * state.ease);
  const gap = 5 - quality;
  const ease = Math.max(1.3, state.ease + (0.1 - gap * (0.08 + gap * 0.02)));
  return {
    ease: Math.round(ease * 1000) / 1000,
    intervalDays,
    repetitions: state.repetitions + 1,
  };
}

/** Today on this computer, as YYYY-MM-DD, so a card comes due at local midnight. */
export function localDateString(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDaysToDate(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return localDateString(new Date(year as number, (month as number) - 1, (date as number) + days));
}

export interface FlashcardView {
  /** The topic and a hash of the front, so editing a card's text starts it again. */
  key: string;
  topicId: string;
  moduleId: string;
  topicTitle: string;
  front: string;
  back: string;
  tags: string[];
  /** Null for a card never reviewed. */
  state: Sm2State | null;
  dueOn: string | null;
}

export interface FlashcardTopicCount {
  topicId: string;
  moduleId: string;
  title: string;
  total: number;
  due: number;
  /** Never reviewed. */
  fresh: number;
}

export interface FlashcardCounts {
  today: string;
  total: number;
  due: number;
  fresh: number;
  topics: FlashcardTopicCount[];
}

export interface FlashcardSession {
  today: string;
  /** Overdue cards first, then cards due today, then new ones. */
  cards: FlashcardView[];
  /** How many more are due than this session holds. */
  remaining: number;
}

export interface FlashcardReviewRequest {
  key: string;
  quality: number;
}

export interface FlashcardReviewResult {
  key: string;
  state: Sm2State;
  dueOn: string;
}

/** A question the AI wrote, stored on this computer. */
export interface GeneratedQuestion {
  id: string;
  topicId: string;
  difficulty: QuestionDifficulty;
  question: PracticeProblem;
  model: string | null;
  /** Until this is true, the question is labeled AI-generated wherever it appears. */
  reviewed: boolean;
  createdAt: number;
}

const DIFFICULTY_MARKS: Readonly<Record<QuestionDifficulty, number>> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

/**
 * Marks for each question. With a total, it is shared out by difficulty in steps of half a mark,
 * and what rounding leaves over goes to the hardest questions first, so the marks add up exactly.
 */
export function distributeMarks(
  levels: readonly QuestionDifficulty[],
  totalMarks: number | null,
): number[] {
  const weights = levels.map((level) => DIFFICULTY_MARKS[level]);
  if (totalMarks === null || levels.length === 0) return weights;
  if (totalMarks < levels.length * 0.5) return levels.map(() => totalMarks / levels.length);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const marks = weights.map((weight) =>
    Math.max(0.5, Math.round(((weight * totalMarks) / weightSum) * 2) / 2),
  );
  const hardestFirst = weights
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ index }) => index);
  let left = totalMarks - marks.reduce((sum, mark) => sum + mark, 0);
  // Removing marks can hit the half-mark floor, so this may take more than one trip round.
  for (let turn = 0; Math.abs(left) >= 0.25 && turn < levels.length * 400; turn++) {
    const index = hardestFirst[turn % levels.length] as number;
    const step = left > 0 ? 0.5 : -0.5;
    if ((marks[index] as number) + step >= 0.5) {
      marks[index] = (marks[index] as number) + step;
      left -= step;
    }
  }
  return marks;
}

const roundMarks = (marks: number) => Math.round(marks * 100) / 100;

/** What an answer earns. Only a clearly wrong answer loses marks, and a skipped one never does. */
export function earnedMarks(
  item: { marks: number; type: QuestionType },
  grade: GradeResult | null,
  config: Pick<AttemptConfig, 'negativeFraction' | 'negativeMcqOnly'>,
): number | null {
  if (!grade || grade.verdict === 'pending') return null;
  if (grade.verdict === 'unanswered') return 0;
  if (grade.score > 0) return roundMarks(item.marks * grade.score);
  const isSelfMarked = item.type === 'short';
  const applies = !isSelfMarked && (item.type === 'mcq' || !config.negativeMcqOnly);
  return applies && config.negativeFraction > 0
    ? -roundMarks(item.marks * config.negativeFraction)
    : 0;
}

/** Below this, a topic needs more work. */
export const WEAK_TOPIC_PERCENT = 60;
/** A single wrong answer says too little to call a whole topic weak. */
export const WEAK_TOPIC_MIN_QUESTIONS = 2;

export function isWeakTopic(percent: number, questions: number): boolean {
  return questions >= WEAK_TOPIC_MIN_QUESTIONS && percent < WEAK_TOPIC_PERCENT;
}

/** Adds up a finished paper. The server stores this, and the page just shows it. */
export function scoreAttempt(
  questions: readonly PaperQuestion[],
  answers: readonly SavedAnswer[],
  config: Pick<AttemptConfig, 'negativeFraction' | 'negativeMcqOnly'>,
): AttemptResult {
  const answerOf = new Map(answers.map((answer) => [answer.key, answer]));
  const topics = new Map<string, TopicBreakdown & { understood: number; graded: number }>();
  const result: AttemptResult = {
    score: 0,
    maxScore: 0,
    percent: 0,
    correct: 0,
    partial: 0,
    incorrect: 0,
    unanswered: 0,
    pending: 0,
    seconds: 0,
    byTopic: [],
    weakTopics: [],
  };
  let pendingMarks = 0;

  for (const item of questions) {
    const saved = answerOf.get(item.key);
    const grade = saved?.grade ?? null;
    const verdict = grade?.verdict ?? 'unanswered';
    const earned = earnedMarks({ marks: item.marks, type: item.question.type }, grade, config) ?? 0;
    const seconds = saved?.seconds ?? 0;
    result.maxScore += item.marks;
    result.score += earned;
    result.seconds += seconds;
    result[verdict] += 1;
    if (verdict === 'pending') pendingMarks += item.marks;

    let topic = topics.get(item.topicId);
    if (!topic) {
      topic = {
        topicId: item.topicId,
        moduleId: item.moduleId,
        title: item.topicTitle,
        questions: 0,
        correct: 0,
        earned: 0,
        possible: 0,
        percent: 0,
        seconds: 0,
        weak: false,
        understood: 0,
        graded: 0,
      };
      topics.set(item.topicId, topic);
    }
    topic.questions += 1;
    topic.correct += verdict === 'correct' ? 1 : 0;
    topic.earned += earned;
    topic.possible += item.marks;
    topic.seconds += seconds;
    if (verdict !== 'pending') {
      topic.understood += item.marks * (grade?.score ?? 0);
      topic.graded += item.marks;
    }
  }

  const gradedMarks = result.maxScore - pendingMarks;
  result.score = roundMarks(result.score);
  result.maxScore = roundMarks(result.maxScore);
  result.percent =
    gradedMarks > 0 ? Math.max(0, Math.round((result.score / gradedMarks) * 100)) : 0;
  result.byTopic = [...topics.values()]
    .map(({ understood, graded, ...topic }) => {
      const percent = graded > 0 ? Math.round((understood / graded) * 100) : 0;
      return {
        ...topic,
        earned: roundMarks(topic.earned),
        possible: roundMarks(topic.possible),
        percent,
        weak: graded > 0 && isWeakTopic(percent, topic.questions),
      };
    })
    .sort((a, b) => a.percent - b.percent);
  result.weakTopics = result.byTopic.filter((topic) => topic.weak).map((topic) => topic.topicId);
  return result;
}

/** Up after a right answer, down after a wrong one, and stays put after a partly right one. */
export function nextAdaptiveLevel(
  level: QuestionDifficulty,
  verdict: GradeVerdict,
): QuestionDifficulty {
  const at = QUESTION_DIFFICULTIES.indexOf(level);
  if (verdict === 'correct')
    return QUESTION_DIFFICULTIES[Math.min(at + 1, 2)] as QuestionDifficulty;
  if (verdict === 'incorrect' || verdict === 'unanswered') {
    return QUESTION_DIFFICULTIES[Math.max(at - 1, 0)] as QuestionDifficulty;
  }
  return level;
}

/** The nearest difficulty to `level` that has a question left, and at random within it. */
export function pickAdaptiveQuestion<T extends { question: { difficulty: QuestionDifficulty } }>(
  pool: readonly T[],
  level: QuestionDifficulty,
  random: () => number = Math.random,
): T | null {
  const nearest: Readonly<Record<QuestionDifficulty, readonly QuestionDifficulty[]>> = {
    easy: ['easy', 'medium', 'hard'],
    medium: ['medium', 'hard', 'easy'],
    hard: ['hard', 'medium', 'easy'],
  };
  for (const candidate of nearest[level]) {
    const matching = pool.filter((item) => item.question.difficulty === candidate);
    if (matching.length > 0) {
      return matching[Math.floor(random() * matching.length)] as T;
    }
  }
  return null;
}

/** An order that is the same each time for one question, so a reload shows the same shuffle. */
export function shuffledIndexes(seedText: string, count: number): number[] {
  let state = 2166136261;
  for (let index = 0; index < seedText.length; index++) {
    state = Math.imul(state ^ seedText.charCodeAt(index), 16777619) >>> 0;
  }
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [order[index], order[other]] = [order[other] as number, order[index] as number];
  }
  // A shuffle that came out in the right order would give the answer away.
  if (count > 1 && order.every((value, index) => value === index)) {
    [order[0], order[1]] = [order[1] as number, order[0] as number];
  }
  return order;
}

/** Splits a fill-in-the-blank sentence around its blanks, so there is one more piece than blanks. */
export function splitAtBlanks(sentence: string): string[] {
  return sentence.split(/_{3,}/);
}

/** "45 s", "3 min 05 s" or "1 h 02 min", for a time a student spent. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
