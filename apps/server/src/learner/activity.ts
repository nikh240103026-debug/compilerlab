import {
  addCalendarDays,
  STREAK_MIN_SECONDS,
  type ActivityEntry,
  type ActivityKind,
  type LessonSummary,
  type StudyTimeReport,
  type StudyTimeSummary,
  type TopicProgress,
  type TopicProgressPatch,
} from '@compilerlab/shared';
import type { SqlDatabase } from '../db/driver';

/** SQLite's datetime('now') is UTC without a zone, which a browser would read as local time. */
export function sqlTimeToIso(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

const KEEP_ACTIVITY_ROWS = 5000;
const SECONDS_IN_A_DAY = 86_400;

export function logActivity(
  db: SqlDatabase,
  kind: ActivityKind,
  topicId: string | null = null,
  detail: string | null = null,
): void {
  db.prepare('INSERT INTO activity_log (kind, topic_id, detail) VALUES (?, ?, ?)').run(
    kind,
    topicId,
    detail,
  );
  // Only the latest entries are ever shown, so the table has no reason to grow forever.
  db.prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?').run(
    KEEP_ACTIVITY_ROWS,
  );
}

/** Logs what is new. Marking a lesson read a second time is not something that happened. */
export function logProgressActivity(
  db: SqlDatabase,
  topicId: string,
  before: TopicProgress | undefined,
  patch: TopicProgressPatch,
): void {
  if (patch.read && !before?.read) logActivity(db, 'lesson-read', topicId);
  if (patch.visualizerUsed && !before?.visualizerUsed) {
    logActivity(db, 'visualizer-used', topicId);
  }
  if (patch.quizScore !== undefined) {
    logActivity(db, 'quiz-finished', topicId, String(patch.quizScore));
  }
}

export function addStudyTime(db: SqlDatabase, report: StudyTimeReport): void {
  db.prepare(
    `INSERT INTO study_time (day, area, topic_id, seconds) VALUES (?, ?, ?, ?)
     ON CONFLICT (day, area, topic_id) DO UPDATE SET
       seconds = MIN(?, seconds + excluded.seconds)`,
  ).run(report.day, report.area, report.topicId ?? '', report.seconds, SECONDS_IN_A_DAY);
}

export function readStudyTime(db: SqlDatabase, today: string): StudyTimeSummary {
  const rows = db
    .prepare('SELECT day, SUM(seconds) AS seconds FROM study_time GROUP BY day')
    .all() as { day: string; seconds: number }[];
  const byDay = new Map(rows.map((row) => [row.day, row.seconds]));
  return {
    totalSeconds: rows.reduce((sum, row) => sum + row.seconds, 0),
    todaySeconds: byDay.get(today) ?? 0,
    lastSevenDays: [6, 5, 4, 3, 2, 1, 0].map((back) => {
      const day = addCalendarDays(today, -back);
      return { day, seconds: byDay.get(day) ?? 0 };
    }),
  };
}

export function readStudyDays(db: SqlDatabase): string[] {
  const rows = db
    .prepare('SELECT day FROM study_time GROUP BY day HAVING SUM(seconds) >= ?')
    .all(STREAK_MIN_SECONDS) as { day: string }[];
  return rows.map((row) => row.day);
}

interface ActivityRow {
  id: number;
  kind: ActivityKind;
  topic_id: string | null;
  detail: string | null;
  created_at: string;
}

function describeActivity(row: ActivityRow, lesson: LessonSummary | undefined): string {
  const title = lesson?.title ?? row.detail ?? 'a topic';
  switch (row.kind) {
    case 'lesson-read':
      return `Read ${title}`;
    case 'visualizer-used':
      return `Used a visualizer in ${title}`;
    case 'quiz-finished':
      return `Scored ${row.detail}% on the quiz in ${title}`;
    case 'note-saved':
      return `Wrote notes on ${title}`;
    case 'bookmark-added':
      return `Bookmarked ${title}`;
    case 'highlight-added':
      return `Highlighted a passage in ${title}`;
    case 'placement-finished':
      return `Finished the placement quiz: ${row.detail}`;
    case 'exam-date-set':
      return `Set an exam date: ${row.detail}`;
    case 'test-finished':
      return `Finished a test: ${row.detail}`;
    case 'lab-passed':
      return `Passed the lab exercise ${row.detail}`;
  }
}

const NOT_TOPIC_LINKS: Readonly<Partial<Record<ActivityKind, string>>> = {
  'exam-date-set': '/exam',
  'placement-finished': '/',
};

/** The latest things the student did, with what the lab has recorded on its own. */
export function readRecentActivity(
  db: SqlDatabase,
  lessons: readonly LessonSummary[],
  labTitle: (exerciseId: string) => string,
  limit = 12,
): ActivityEntry[] {
  const logged = db
    .prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?')
    .all(limit) as ActivityRow[];
  const entries = logged.map((row): ActivityEntry => {
    const lesson = lessons.find((candidate) => candidate.id === row.topic_id);
    return {
      id: `activity-${row.id}`,
      kind: row.kind,
      text: describeActivity(row, lesson),
      at: sqlTimeToIso(row.created_at),
      to: lesson ? `/learn/${lesson.module}/${lesson.id}` : (NOT_TOPIC_LINKS[row.kind] ?? null),
    };
  });

  // The lab already keeps a dated record of each pass, so it is read rather than written twice.
  const passes = db
    .prepare('SELECT exercise_id, passed_at FROM lab_progress ORDER BY passed_at DESC LIMIT ?')
    .all(limit) as { exercise_id: string; passed_at: string }[];
  for (const pass of passes) {
    entries.push({
      id: `lab-${pass.exercise_id}`,
      kind: 'lab-passed',
      text: `Passed the lab exercise ${labTitle(pass.exercise_id)}`,
      at: sqlTimeToIso(pass.passed_at),
      to: `/lab/${pass.exercise_id}`,
    });
  }

  return entries.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
