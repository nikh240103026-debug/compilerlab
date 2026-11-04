// Zod-free so the web app's initial bundle can use it. The Zod schemas, and the types of the data
// files they read, are in learner-schemas.ts.
import type { CourseModule, LessonSummary } from './content';
import type {
  ExamPlan,
  OnboardingState,
  PlacementResult,
  Syllabus,
  SyllabusItem,
} from './learner-schemas';
import { isTopicComplete, QUIZ_PASS_SCORE, topicMastery, type TopicProgress } from './progress';

export const LEARNER_LIMITS = {
  /** A browser reports study time at least this often, so one report cannot be larger. */
  heartbeatSeconds: 300,
  noteChars: 100_000,
  quoteChars: 2000,
  quoteContextChars: 40,
  searchQueryChars: 200,
  searchResults: 40,
} as const;

/** A day counts towards a streak once this much real study time has been recorded on it. */
export const STREAK_MIN_SECONDS = 60;

// ---------------------------------------------------------------------------------------------
// Calendar days. A day is the student's own local date as YYYY-MM-DD, because a streak has to
// follow their clock rather than the server's time zone.
// ---------------------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const utcTime = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function isCalendarDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = utcTime(text);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text);
}

export function localCalendarDay(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addCalendarDays(day: string, count: number): string {
  return new Date(utcTime(day) + count * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Positive when `to` is after `from`. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcTime(to) - utcTime(from)) / MS_PER_DAY);
}

/** "2 h 15 min", "40 min", or "0 min". */
export function formatStudyDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// ---------------------------------------------------------------------------------------------
// Study time and activity
// ---------------------------------------------------------------------------------------------

export const STUDY_AREAS = [
  'dashboard',
  'lesson',
  'visualize',
  'lab',
  'practice',
  'exam',
  'tutor',
  'notes',
  'other',
] as const;
export type StudyArea = (typeof STUDY_AREAS)[number];

export const ACTIVITY_KINDS = [
  'lesson-read',
  'visualizer-used',
  'quiz-finished',
  'test-finished',
  'lab-passed',
  'note-saved',
  'bookmark-added',
  'highlight-added',
  'placement-finished',
  'exam-date-set',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** A sentence for the student, such as `Scored 80% on the quiz in Regular expressions`. */
  text: string;
  /** ISO time, in UTC. */
  at: string;
  /** Where to go to pick this up again. */
  to: string | null;
}

export interface StudyStreak {
  current: number;
  longest: number;
  activeToday: boolean;
}

/** A missed day ends a streak, but today is not missed until it is over. */
export function studyStreak(days: Iterable<string>, today: string): StudyStreak {
  const todayNumber = calendarDaysBetween('1970-01-01', today);
  const numbers = [...new Set(days)]
    .map((day) => calendarDaysBetween('1970-01-01', day))
    .filter((number) => number <= todayNumber)
    .toSorted((a, b) => a - b);

  let longest = 0;
  let run = 0;
  let last = Number.NaN;
  for (const number of numbers) {
    run = number === last + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    last = number;
  }
  // `run` is now the run ending on the most recent day studied.
  const stillGoing = last === todayNumber || last === todayNumber - 1;
  return { current: stillGoing ? run : 0, longest, activeToday: last === todayNumber };
}

export interface StudyTimeSummary {
  totalSeconds: number;
  todaySeconds: number;
  /** Oldest first, ending today. Days with no study are included with 0 seconds. */
  lastSevenDays: { day: string; seconds: number }[];
}

// ---------------------------------------------------------------------------------------------
// Course order and mastery
// ---------------------------------------------------------------------------------------------

/** Module numbers set the order. The content loader only sorts by module id. */
export function lessonsInCourseOrder(
  lessons: readonly LessonSummary[],
  modules: readonly Pick<CourseModule, 'id' | 'number'>[],
): LessonSummary[] {
  const position = new Map(modules.map((module) => [module.id, module.number]));
  const rank = (lesson: LessonSummary) => position.get(lesson.module) ?? Number.MAX_SAFE_INTEGER;
  return lessons.toSorted((a, b) => rank(a) - rank(b) || a.order - b.order);
}

export interface PhaseMastery {
  moduleId: string;
  number: number;
  title: string;
  /** The average mastery of the module's topics, from 0 to 100. */
  mastery: number;
  completed: number;
  /** How many topics the module has so far. */
  total: number;
}

export function phaseMastery(
  modules: readonly CourseModule[],
  lessons: readonly LessonSummary[],
  progress: readonly TopicProgress[],
): PhaseMastery[] {
  const mine = new Map(progress.map((item) => [item.topicId, item]));
  return modules.map((module) => {
    const topics = lessons.filter((lesson) => lesson.module === module.id);
    const scores = topics.map((lesson) =>
      topicMastery(mine.get(lesson.id), lesson.visualizers.length > 0),
    );
    return {
      moduleId: module.id,
      number: module.number,
      title: module.title,
      mastery:
        scores.length === 0
          ? 0
          : Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      completed: topics.filter((lesson) =>
        isTopicComplete(mine.get(lesson.id), lesson.visualizers.length > 0),
      ).length,
      total: topics.length,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Gentle gamification. Everything here is worked out from what the student really did, so it can
// be hidden at any time without changing anything underneath.
// ---------------------------------------------------------------------------------------------

export interface LearnerFacts {
  lessonsRead: number;
  visualizersUsed: number;
  quizzesPassed: number;
  perfectQuizzes: number;
  topicsComplete: number;
  modulesComplete: number;
  topicsWithNotes: number;
  highlights: number;
  bookmarks: number;
  labsPassed: number;
  testsFinished: number;
  longestStreak: number;
  studyDays: number;
  totalSeconds: number;
  placementDone: boolean;
  examPlanned: boolean;
}

const XP_FOR = {
  lessonRead: 10,
  visualizerUsed: 10,
  quizPassed: 30,
  topicComplete: 20,
  labPassed: 25,
  testFinished: 15,
  topicWithNotes: 5,
  studyDay: 5,
} as const;

export function learnerXp(facts: LearnerFacts): number {
  return (
    facts.lessonsRead * XP_FOR.lessonRead +
    facts.visualizersUsed * XP_FOR.visualizerUsed +
    facts.quizzesPassed * XP_FOR.quizPassed +
    facts.topicsComplete * XP_FOR.topicComplete +
    facts.labsPassed * XP_FOR.labPassed +
    facts.testsFinished * XP_FOR.testFinished +
    facts.topicsWithNotes * XP_FOR.topicWithNotes +
    facts.studyDays * XP_FOR.studyDay
  );
}

export interface LearnerLevel {
  level: number;
  xp: number;
  /** The XP where this level began, and where the next one begins. */
  levelStart: number;
  nextLevelAt: number;
  /** Progress through this level, from 0 to 100. */
  percent: number;
}

/** Each level takes 100 XP more than the last: 0, 100, 300, 600, 1000... */
const xpForLevel = (level: number) => 50 * level * (level - 1);

export function learnerLevel(xp: number): LearnerLevel {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  const levelStart = xpForLevel(level);
  const nextLevelAt = xpForLevel(level + 1);
  return {
    level,
    xp,
    levelStart,
    nextLevelAt,
    percent: Math.floor(((xp - levelStart) / (nextLevelAt - levelStart)) * 100),
  };
}

export interface BadgeDefinition {
  id: string;
  title: string;
  description: string;
  earned: (facts: LearnerFacts) => boolean;
}

export const BADGES: readonly BadgeDefinition[] = [
  {
    id: 'first-page',
    title: 'First page',
    description: 'Read a whole lesson.',
    earned: (facts) => facts.lessonsRead >= 1,
  },
  {
    id: 'hands-on',
    title: 'Hands on',
    description: 'Used the visualizers in 3 topics.',
    earned: (facts) => facts.visualizersUsed >= 3,
  },
  {
    id: 'quiz-passed',
    title: 'Passed',
    description: `Scored ${QUIZ_PASS_SCORE}% or more on a quiz.`,
    earned: (facts) => facts.quizzesPassed >= 1,
  },
  {
    id: 'full-marks',
    title: 'Full marks',
    description: 'Scored 100% on a quiz.',
    earned: (facts) => facts.perfectQuizzes >= 1,
  },
  {
    id: 'topic-done',
    title: 'Topic done',
    description: 'Completed a topic: read, explored and passed.',
    earned: (facts) => facts.topicsComplete >= 1,
  },
  {
    id: 'ten-topics',
    title: 'Ten topics',
    description: 'Completed 10 topics.',
    earned: (facts) => facts.topicsComplete >= 10,
  },
  {
    id: 'phase-done',
    title: 'Phase done',
    description: 'Completed every topic in a module.',
    earned: (facts) => facts.modulesComplete >= 1,
  },
  {
    id: 'lab-pass',
    title: 'It compiles',
    description: 'Passed a lab exercise.',
    earned: (facts) => facts.labsPassed >= 1,
  },
  {
    id: 'lab-five',
    title: 'Lab regular',
    description: 'Passed 5 lab exercises.',
    earned: (facts) => facts.labsPassed >= 5,
  },
  {
    id: 'note-taker',
    title: 'Note taker',
    description: 'Wrote notes for 3 topics.',
    earned: (facts) => facts.topicsWithNotes >= 3,
  },
  {
    id: 'streak-three',
    title: 'Three days running',
    description: 'Studied 3 days in a row.',
    earned: (facts) => facts.longestStreak >= 3,
  },
  {
    id: 'streak-week',
    title: 'A full week',
    description: 'Studied 7 days in a row.',
    earned: (facts) => facts.longestStreak >= 7,
  },
  {
    id: 'one-hour',
    title: 'First hour',
    description: 'Spent an hour studying here.',
    earned: (facts) => facts.totalSeconds >= 3600,
  },
  {
    id: 'ten-hours',
    title: 'Ten hours',
    description: 'Spent ten hours studying here.',
    earned: (facts) => facts.totalSeconds >= 36_000,
  },
  {
    id: 'exam-ready',
    title: 'On the calendar',
    description: 'Set an exam date.',
    earned: (facts) => facts.examPlanned,
  },
];

export interface BadgeStatus {
  id: string;
  title: string;
  description: string;
  /** ISO time it was earned, or null if it is still ahead. */
  earnedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Where to go next
// ---------------------------------------------------------------------------------------------

const lessonPath = (lesson: LessonSummary, hash = '') =>
  `/learn/${lesson.module}/${lesson.id}${hash}`;

export interface ContinueLearning {
  topicId: string;
  title: string;
  moduleId: string;
  to: string;
  mastery: number;
  /** False when this is simply the next topic, because nothing is in progress. */
  inProgress: boolean;
}

function isDoneIn(mine: ReadonlyMap<string, TopicProgress>) {
  return (lesson: LessonSummary) =>
    isTopicComplete(mine.get(lesson.id), lesson.visualizers.length > 0);
}

/** The latest topic left unfinished, or else the next one the student has not touched. */
export function continueLearning(
  ordered: readonly LessonSummary[],
  progress: readonly TopicProgress[],
): ContinueLearning | null {
  const mine = new Map(progress.map((item) => [item.topicId, item]));
  const isDone = isDoneIn(mine);
  const unfinished = progress.flatMap((item) => {
    const lesson = ordered.find(({ id }) => id === item.topicId);
    return lesson && !isDone(lesson) ? [lesson] : [];
  })[0];
  const lesson = unfinished ?? ordered.find((candidate) => !mine.has(candidate.id));
  if (!lesson) return null;
  return {
    topicId: lesson.id,
    title: lesson.title,
    moduleId: lesson.module,
    to: lessonPath(lesson),
    mastery: topicMastery(mine.get(lesson.id), lesson.visualizers.length > 0),
    inProgress: unfinished !== undefined,
  };
}

export interface NextStep {
  title: string;
  reason: string;
  to: string;
}

export interface NextStepInput {
  /** In course order. */
  lessons: readonly LessonSummary[];
  /** Most recently touched first. */
  progress: readonly TopicProgress[];
  /** Topics the student scores lowest on in tests, weakest first. */
  weakTopicIds: readonly string[];
  placement: PlacementResult | null;
  examDaysLeft: number | null;
}

const EXAM_IS_CLOSE_DAYS = 14;

function daysPhrase(days: number): string {
  if (days === 0) return 'today';
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** One clear suggestion, in the order a teacher would think of them. */
export function recommendNextStep(input: NextStepInput): NextStep {
  const { lessons, progress, weakTopicIds, placement, examDaysLeft } = input;
  const mine = new Map(progress.map((item) => [item.topicId, item]));
  const isDone = isDoneIn(mine);
  const weak = weakTopicIds.flatMap((id) => lessons.filter((lesson) => lesson.id === id));

  if (examDaysLeft !== null && examDaysLeft >= 0 && examDaysLeft <= EXAM_IS_CLOSE_DAYS) {
    const target = weak[0];
    return target
      ? {
          title: `Revise ${target.title}`,
          reason: `Your exam is ${daysPhrase(examDaysLeft)}, and your test scores are lowest here.`,
          to: lessonPath(target),
        }
      : {
          title: 'Open your exam plan',
          reason: `Your exam is ${daysPhrase(examDaysLeft)}. Check what your syllabus still needs.`,
          to: '/exam',
        };
  }

  for (const item of progress) {
    const lesson = lessons.find(({ id }) => id === item.topicId);
    if (!lesson || isDone(lesson)) continue;
    if (!item.read) {
      return {
        title: `Finish reading ${lesson.title}`,
        reason: 'You started this one. Reading to the end counts towards completing it.',
        to: lessonPath(lesson),
      };
    }
    if (lesson.visualizers.length > 0 && !item.visualizerUsed) {
      return {
        title: `Try the visualizer in ${lesson.title}`,
        reason: 'You have read it. Running an example yourself is what makes it stick.',
        to: lessonPath(lesson),
      };
    }
    return {
      title: `Take the quiz in ${lesson.title}`,
      reason: `A score of ${QUIZ_PASS_SCORE}% or more completes this topic.`,
      to: lessonPath(lesson, '#quiz-heading'),
    };
  }

  const target = weak[0];
  if (target) {
    return {
      title: `Review ${target.title}`,
      reason: 'Your test scores are lowest here, so a second look will help the most.',
      to: lessonPath(target),
    };
  }

  const placed = lessons.find((lesson) => lesson.id === placement?.recommendedTopic);
  if (placed && !mine.has(placed.id)) {
    return {
      title: `Start with ${placed.title}`,
      reason: placement?.reason ?? 'Your placement quiz suggested starting here.',
      to: lessonPath(placed),
    };
  }

  const ready = lessons.find(
    (lesson) =>
      !isDone(lesson) &&
      lesson.prerequisites.every((id) => {
        const prerequisite = lessons.find((candidate) => candidate.id === id);
        return !prerequisite || isDone(prerequisite);
      }),
  );
  const next = ready ?? lessons.find((lesson) => !isDone(lesson));
  if (next) {
    return {
      title: `Start ${next.title}`,
      reason: ready
        ? 'This is the next topic in the course, and you have finished what it builds on.'
        : 'This is the next topic you have not completed.',
      to: lessonPath(next),
    };
  }
  return {
    title: 'Try a full mock exam',
    reason: 'You have completed every topic. A timed paper shows what you still need to review.',
    to: '/practice',
  };
}

/** Topics to revise, for a study plan: the least mastered first, skipping those already solid. */
export function weakestTopics(
  lessons: readonly LessonSummary[],
  progress: readonly TopicProgress[],
  limit = 20,
): { topicId: string; title: string; mastery: number }[] {
  const mine = new Map(progress.map((item) => [item.topicId, item]));
  return lessons
    .map((lesson) => ({
      topicId: lesson.id,
      title: lesson.title,
      mastery: topicMastery(mine.get(lesson.id), lesson.visualizers.length > 0),
    }))
    .filter((topic) => topic.mastery < QUIZ_PASS_SCORE)
    .toSorted((a, b) => a.mastery - b.mastery)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------------------------

export const FIRST_RUN_ONBOARDING: OnboardingState = {
  tour: 'pending',
  placement: 'pending',
  result: null,
};

export function onboardingIsFinished(state: OnboardingState): boolean {
  return state.tour !== 'pending' && state.placement !== 'pending';
}

export interface PlacementAnswer {
  moduleId: string;
  correct: boolean;
}

/**
 * Starts at the first phase the student missed, because the course builds on itself. If that phase
 * has no lessons yet, the nearest later phase that does is next, then the last one that does.
 */
export function recommendPlacement(
  answers: readonly PlacementAnswer[],
  modules: readonly Pick<CourseModule, 'id' | 'number' | 'title'>[],
  lessons: readonly LessonSummary[],
): { moduleId: string | null; topicId: string | null; reason: string } {
  const ordered = modules.toSorted((a, b) => a.number - b.number);
  const courseLessons = lessonsInCourseOrder(lessons, modules);
  const missed = ordered.find((module) =>
    answers.some((answer) => answer.moduleId === module.id && !answer.correct),
  );
  if (!missed) {
    return {
      moduleId: null,
      topicId: null,
      reason:
        'You got everything right, so you can start wherever you like. The exam prep center is a good place to find gaps.',
    };
  }
  const reached = ordered.slice(ordered.indexOf(missed));
  const next = reached
    .map((module) => courseLessons.find((lesson) => lesson.module === module.id))
    .find((lesson) => lesson !== undefined);
  const lesson = next ?? courseLessons.at(-1);
  const sameModule = lesson?.module === missed.id;
  return {
    moduleId: lesson?.module ?? missed.id,
    topicId: lesson?.id ?? null,
    reason: sameModule
      ? `Your answers suggest starting with ${missed.title}, the first phase you were unsure about.`
      : `You were first unsure about ${missed.title}, whose lessons are not in the course yet, so this is the closest topic to start with.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Exam plan and syllabus coverage
// ---------------------------------------------------------------------------------------------

export const EMPTY_EXAM_PLAN: ExamPlan = {
  name: '',
  date: null,
  syllabusId: null,
  customTopics: [],
  hoursPerDay: 2,
};

export const CUSTOM_SYLLABUS_ID = 'custom';

/** A custom syllabus is simply the topics the student ticked. */
export function customSyllabus(
  topicIds: readonly string[],
  lessons: readonly LessonSummary[],
): Syllabus {
  return {
    id: CUSTOM_SYLLABUS_ID,
    name: 'My own syllabus',
    kind: 'university',
    note: 'The topics you chose.',
    items: lessons
      .filter((lesson) => topicIds.includes(lesson.id))
      .map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        module: lesson.module,
        topics: [lesson.id],
      })),
  };
}

export function lessonsForSyllabusItem(
  item: SyllabusItem,
  lessons: readonly LessonSummary[],
): LessonSummary[] {
  if (item.topics) return lessons.filter((lesson) => item.topics?.includes(lesson.id));
  const inModule = lessons.filter((lesson) => lesson.module === item.module);
  if (!item.match) return inModule;
  const needles = item.match.map((word) => word.toLowerCase());
  return inModule.filter((lesson) => {
    const haystack = `${lesson.id} ${lesson.title}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

export type SyllabusItemState = 'not-in-course' | 'not-started' | 'started' | 'covered';

export interface SyllabusItemCoverage {
  item: SyllabusItem;
  state: SyllabusItemState;
  lessons: LessonSummary[];
  completed: number;
  mastery: number;
}

export interface SyllabusCoverage {
  items: SyllabusItemCoverage[];
  /** The average mastery over every lesson this syllabus reaches, from 0 to 100. */
  percent: number;
  coveredItems: number;
  /** Items with no lessons in the course yet. These cannot be studied here, so they do not count. */
  missingItems: number;
}

/** Compares a syllabus with the student's real progress. */
export function syllabusCoverage(
  syllabus: Syllabus,
  lessons: readonly LessonSummary[],
  progress: readonly TopicProgress[],
): SyllabusCoverage {
  const mine = new Map(progress.map((item) => [item.topicId, item]));
  const masteryOf = (lesson: LessonSummary) =>
    topicMastery(mine.get(lesson.id), lesson.visualizers.length > 0);
  const average = (values: readonly number[]) =>
    values.length === 0
      ? 0
      : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

  const items = syllabus.items.map((item): SyllabusItemCoverage => {
    const matched = lessonsForSyllabusItem(item, lessons);
    const completed = matched.filter(isDoneIn(mine)).length;
    const mastery = average(matched.map(masteryOf));
    const state: SyllabusItemState =
      matched.length === 0
        ? 'not-in-course'
        : completed === matched.length
          ? 'covered'
          : mastery > 0
            ? 'started'
            : 'not-started';
    return { item, state, lessons: matched, completed, mastery };
  });

  const unique = [...new Set(items.flatMap((entry) => entry.lessons))];
  return {
    items,
    percent: average(unique.map(masteryOf)),
    coveredItems: items.filter((entry) => entry.state === 'covered').length,
    missingItems: items.filter((entry) => entry.state === 'not-in-course').length,
  };
}

// ---------------------------------------------------------------------------------------------
// Glossary and search
// ---------------------------------------------------------------------------------------------

/** The address of a term, such as "ll-1-grammar". Letters like ε stay, and are URL-encoded later. */
export function glossarySlug(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export const SEARCH_KINDS = ['lesson', 'glossary', 'note', 'question'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABELS: Readonly<Record<SearchKind, string>> = {
  lesson: 'Lesson',
  glossary: 'Glossary',
  note: 'Your note',
  question: 'Question',
};

export interface SearchHit {
  id: string;
  kind: SearchKind;
  title: string;
  /** Plain text around the match. */
  snippet: string;
  /** The module or the lesson it belongs to, for the row's second line. */
  context: string;
  /** The app's path to open. */
  to: string;
  topicId: string | null;
  /** The words that matched, for marking them in the snippet. */
  terms: string[];
  score: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
}

// ---------------------------------------------------------------------------------------------
// The dashboard's one request
// ---------------------------------------------------------------------------------------------

export interface DashboardData {
  streak: StudyStreak;
  time: StudyTimeSummary;
  phases: PhaseMastery[];
  completedTopics: number;
  totalTopics: number;
  startedTopics: number;
  continueLearning: ContinueLearning | null;
  nextStep: NextStep;
  recentActivity: ActivityEntry[];
  examPlan: ExamPlan;
  /** Null when no date is set. Negative after the date has passed. */
  examDaysLeft: number | null;
  onboarding: OnboardingState;
  level: LearnerLevel;
  badges: BadgeStatus[];
}

/** The file a student downloads from Settings. Each table keeps its own column names. */
export interface LearnerDataExport {
  app: 'CompilerLab';
  appVersion: string;
  exportedAt: string;
  schemaVersion: number;
  settings: unknown;
  tables: Record<string, unknown[]>;
}

/** The word the delete request has to carry, so nothing can trigger it by accident. */
export const DELETE_EVERYTHING_WORD = 'DELETE';
