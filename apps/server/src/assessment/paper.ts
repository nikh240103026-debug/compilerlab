import { modules } from '@compilerlab/content';
import {
  ASSESSMENT_MODE_INFO,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  distributeMarks,
  pickAdaptiveQuestion,
  type AttemptConfig,
  type GeneratedQuestion,
  type PaperQuestion,
  type PracticeProblem,
  type QuestionDifficulty,
} from '@compilerlab/shared';
import type { CourseTopic } from './catalog';

export interface BuiltPaper {
  questions: PaperQuestion[];
  /** What an adaptive test can still ask. Empty for every other mode. */
  pool: PaperQuestion[];
  notes: string[];
  level: QuestionDifficulty | null;
}

/** Says why a paper could not be built, in words a student can act on. */
export class PaperError extends Error {}

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

function toPaperQuestion(topic: CourseTopic, question: PracticeProblem): PaperQuestion {
  return {
    key: `${topic.lesson.id}/${question.id}`,
    topicId: topic.lesson.id,
    moduleId: topic.lesson.module,
    topicTitle: topic.lesson.title,
    marks: 1,
    question,
    source: 'course',
    generatedId: null,
    reviewed: true,
  };
}

function generatedToPaperQuestion(topic: CourseTopic, item: GeneratedQuestion): PaperQuestion {
  return {
    key: `${topic.lesson.id}/ai-${item.id}`,
    topicId: topic.lesson.id,
    moduleId: topic.lesson.module,
    topicTitle: topic.lesson.title,
    marks: 1,
    question: item.question,
    source: 'ai',
    generatedId: item.id,
    reviewed: item.reviewed,
  };
}

function candidates(
  config: AttemptConfig,
  topics: readonly CourseTopic[],
  generated: readonly GeneratedQuestion[],
): PaperQuestion[] {
  const everything = config.topicIds.length === 0 && config.moduleIds.length === 0;
  const inScope = topics.filter(
    ({ lesson }) =>
      everything || config.topicIds.includes(lesson.id) || config.moduleIds.includes(lesson.module),
  );
  const fits = ({ question }: PaperQuestion) =>
    (config.difficulty === 'any' || question.difficulty === config.difficulty) &&
    (config.exam === 'any' || question.exams.includes(config.exam));

  return inScope.flatMap((topic) => {
    const course = [...topic.bank.practice, ...topic.bank.quiz].map((question) =>
      toPaperQuestion(topic, question),
    );
    const fromAi =
      config.generated === 'none'
        ? []
        : generated
            .filter(
              (item) =>
                item.topicId === topic.lesson.id && (config.generated === 'all' || item.reviewed),
            )
            .map((item) => generatedToPaperQuestion(topic, item));
    return [...course, ...fromAi].filter(fits);
  });
}

/** Takes a turn around the topics, so a test covers each one as evenly as the questions allow. */
function pickBalanced(items: readonly PaperQuestion[], count: number): PaperQuestion[] {
  const byTopic = new Map<string, PaperQuestion[]>();
  for (const item of shuffle(items)) {
    const bucket = byTopic.get(item.topicId);
    if (bucket) bucket.push(item);
    else byTopic.set(item.topicId, [item]);
  }
  const buckets = shuffle([...byTopic.values()]);
  const picked: PaperQuestion[] = [];
  while (picked.length < count && buckets.some((bucket) => bucket.length > 0)) {
    for (const bucket of buckets) {
      const item = bucket.pop();
      if (item && picked.length < count) picked.push(item);
    }
  }
  return picked;
}

function withMarks(
  questions: readonly PaperQuestion[],
  totalMarks: number | null,
): PaperQuestion[] {
  const marks = distributeMarks(
    questions.map(({ question }) => question.difficulty),
    totalMarks,
  );
  return questions.map((item, index) => ({ ...item, marks: marks[index] as number }));
}

/** The mock exam's mix, in the order it was asked for, with shortfalls filled from anything left. */
function pickByMix(
  items: readonly PaperQuestion[],
  config: AttemptConfig,
): { questions: PaperQuestion[]; notes: string[] } {
  const notes: string[] = [];
  const questions: PaperQuestion[] = [];
  let wanted = 0;
  for (const type of QUESTION_TYPES) {
    const count = config.mix?.[type] ?? 0;
    if (count <= 0) continue;
    wanted += count;
    const picked = pickBalanced(
      items.filter(({ question }) => question.type === type),
      count,
    );
    questions.push(...picked);
    if (picked.length < count) {
      notes.push(
        `There are only ${picked.length} ${QUESTION_TYPE_LABELS[type].toLowerCase()} questions in this selection, and you asked for ${count}.`,
      );
    }
  }
  const short = wanted - questions.length;
  if (short > 0) {
    const used = new Set(questions.map(({ key }) => key));
    const extra = pickBalanced(
      items.filter(({ key }) => !used.has(key)),
      short,
    );
    questions.push(...extra);
    if (extra.length > 0) {
      notes.push(`${extra.length} other questions were added to keep the paper to length.`);
    }
  }
  return { questions, notes };
}

export function titleFor(config: AttemptConfig, topics: readonly CourseTopic[]): string {
  if (config.title) return config.title;
  const label = ASSESSMENT_MODE_INFO[config.mode].label;
  const firstTopic = topics.find(({ lesson }) => lesson.id === config.topicIds[0]);
  if (config.topicIds.length === 1 && firstTopic) return `${label}: ${firstTopic.lesson.title}`;
  if (config.topicIds.length > 1) return `${label}: ${config.topicIds.length} topics`;
  const courseModule = modules.find(({ id }) => id === config.moduleIds[0]);
  if (config.moduleIds.length === 1 && courseModule) return `${label}: ${courseModule.title}`;
  return label;
}

export function buildPaper(
  config: AttemptConfig,
  topics: readonly CourseTopic[],
  generated: readonly GeneratedQuestion[],
): BuiltPaper {
  const items = candidates(config, topics, generated);
  if (items.length === 0) {
    throw new PaperError(
      'No questions match these choices. Choose more topics, or allow any difficulty and exam style.',
    );
  }

  if (config.mode === 'adaptive') {
    // A short answer waits for a mark, and the next question cannot wait for that.
    const pool = items.filter(({ question }) => question.type !== 'short');
    const first = pickAdaptiveQuestion(pool, 'medium');
    if (!first) {
      throw new PaperError(
        'An adaptive test needs questions the app can mark at once, and this selection has only short answers.',
      );
    }
    return {
      questions: withMarks([first], null),
      pool: pool.filter(({ key }) => key !== first.key),
      notes: [],
      level: 'medium',
    };
  }

  if (config.mode === 'mock' && config.mix) {
    const { questions, notes } = pickByMix(items, config);
    if (questions.length === 0) {
      throw new PaperError('Choose how many questions of each type this paper should have.');
    }
    return { questions: withMarks(questions, config.totalMarks), pool: [], notes, level: null };
  }

  const questions = shuffle(pickBalanced(items, config.questionCount));
  const notes =
    questions.length < config.questionCount
      ? [`This selection has ${questions.length} questions, so the test is that long.`]
      : [];
  return { questions: withMarks(questions, config.totalMarks), pool: [], notes, level: null };
}

/** Retry-only-mistakes: everything in the earlier paper that did not earn full marks. */
export function buildRetryPaper(
  earlier: readonly PaperQuestion[],
  isCorrect: (key: string) => boolean,
): BuiltPaper {
  const questions = shuffle(earlier.filter(({ key }) => !isCorrect(key)));
  if (questions.length === 0) {
    throw new PaperError('That test has no mistakes to retry. Every answer was right.');
  }
  return { questions, pool: [], notes: [], level: null };
}
