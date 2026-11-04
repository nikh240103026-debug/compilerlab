import { loadLessonIndex, modules } from '@compilerlab/content';
import {
  BADGES,
  calendarDaysBetween,
  continueLearning,
  isTopicComplete,
  learnerLevel,
  learnerXp,
  lessonsInCourseOrder,
  phaseMastery,
  QUIZ_PASS_SCORE,
  recommendNextStep,
  studyStreak,
  type ActivityEntry,
  type AssessmentSummary,
  type BadgeStatus,
  type DashboardData,
  type LearnerFacts,
} from '@compilerlab/shared';
import type { SqlDatabase } from '../db/driver';
import { readLabProgress } from '../lab-repo';
import { readAllProgress } from '../progress-repo';
import { readRecentActivity, readStudyDays, readStudyTime, sqlTimeToIso } from './activity';
import { readExamPlan, readOnboarding } from './state';

const RECENT_ACTIVITY = 12;

const countRows = (db: SqlDatabase, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

/**
 * A badge is written down the first time its rule holds, which gives it a real date and means
 * deleting a note later cannot take it away.
 */
function syncBadges(db: SqlDatabase, facts: LearnerFacts): BadgeStatus[] {
  const insert = db.prepare('INSERT OR IGNORE INTO earned_badges (badge_id) VALUES (?)');
  for (const badge of BADGES) {
    if (badge.earned(facts)) insert.run(badge.id);
  }
  const rows = db.prepare('SELECT badge_id, earned_at FROM earned_badges').all() as {
    badge_id: string;
    earned_at: string;
  }[];
  const earned = new Map(rows.map((row) => [row.badge_id, row.earned_at]));
  return BADGES.map(({ id, title, description }) => {
    const at = earned.get(id);
    return { id, title, description, earnedAt: at ? sqlTimeToIso(at) : null };
  });
}

const titleFromSlug = (slug: string) => {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Attempts are kept by Assessment, with their own dates, so they are read and never copied. */
function finishedTests(assessment: AssessmentSummary): ActivityEntry[] {
  return assessment.recentAttempts.flatMap((attempt) =>
    attempt.status === 'finished' && attempt.finishedAt !== null
      ? [
          {
            id: `test-${attempt.id}`,
            kind: 'test-finished' as const,
            text:
              attempt.percent === null
                ? `Finished ${attempt.title}`
                : `Scored ${attempt.percent}% on ${attempt.title}`,
            at: new Date(attempt.finishedAt).toISOString(),
            to: `/practice/results/${attempt.id}`,
          },
        ]
      : [],
  );
}

/** The dashboard's one request, so the page never has to add things up in the browser. */
export function buildDashboard(
  db: SqlDatabase,
  contentDir: string,
  today: string,
  assessment: AssessmentSummary,
): DashboardData {
  const lessons = lessonsInCourseOrder(loadLessonIndex(contentDir).lessons, modules);
  const progress = readAllProgress(db);
  const examPlan = readExamPlan(db);
  const onboarding = readOnboarding(db);
  const phases = phaseMastery(modules, lessons, progress);
  const time = readStudyTime(db, today);
  const studyDays = readStudyDays(db);
  const streak = studyStreak(studyDays, today);
  const labsPassed = readLabProgress(db).length;

  const mine = new Map(progress.map((item) => [item.topicId, item]));
  const completedTopics = lessons.filter((lesson) =>
    isTopicComplete(mine.get(lesson.id), lesson.visualizers.length > 0),
  ).length;

  const facts: LearnerFacts = {
    lessonsRead: progress.filter((item) => item.read).length,
    visualizersUsed: progress.filter((item) => item.visualizerUsed).length,
    quizzesPassed: progress.filter((item) => (item.bestQuizScore ?? 0) >= QUIZ_PASS_SCORE).length,
    perfectQuizzes: progress.filter((item) => item.bestQuizScore === 100).length,
    topicsComplete: completedTopics,
    modulesComplete: phases.filter((phase) => phase.total > 0 && phase.completed === phase.total)
      .length,
    topicsWithNotes: countRows(db, 'notes'),
    highlights: countRows(db, 'highlights'),
    bookmarks: countRows(db, 'bookmarks'),
    labsPassed,
    testsFinished: assessment.totals.attemptsFinished,
    longestStreak: streak.longest,
    studyDays: studyDays.length,
    totalSeconds: time.totalSeconds,
    placementDone: onboarding.result !== null,
    examPlanned: examPlan.date !== null,
  };

  const examDaysLeft = examPlan.date ? calendarDaysBetween(today, examPlan.date) : null;
  const recentActivity = [
    ...readRecentActivity(db, lessons, titleFromSlug, RECENT_ACTIVITY),
    ...finishedTests(assessment),
  ]
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .slice(0, RECENT_ACTIVITY);

  return {
    streak,
    time,
    phases,
    completedTopics,
    totalTopics: lessons.length,
    startedTopics: progress.length,
    continueLearning: continueLearning(lessons, progress),
    nextStep: recommendNextStep({
      lessons,
      progress,
      weakTopicIds: assessment.weakTopics.map((topic) => topic.topicId),
      placement: onboarding.result,
      examDaysLeft,
    }),
    recentActivity,
    examPlan,
    examDaysLeft,
    onboarding,
    level: learnerLevel(learnerXp(facts)),
    badges: syncBadges(db, facts),
  };
}
