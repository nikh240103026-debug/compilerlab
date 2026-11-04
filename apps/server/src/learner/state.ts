import {
  EMPTY_EXAM_PLAN,
  ExamPlanSchema,
  FIRST_RUN_ONBOARDING,
  OnboardingStateSchema,
  type ExamPlan,
  type OnboardingState,
} from '@compilerlab/shared';
import type { SqlDatabase } from '../db/driver';
import { logActivity } from './activity';

const ONBOARDING = 'onboarding';
const EXAM_PLAN = 'exam-plan';

/** Stored as one JSON value per key. A value that no longer parses falls back to the default. */
function readState<T>(
  db: SqlDatabase,
  key: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  fallback: T,
): T {
  const row = db.prepare('SELECT value FROM learner_state WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return fallback;
  try {
    const parsed = parse(JSON.parse(row.value));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function writeState(db: SqlDatabase, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO learner_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value));
}

export function readOnboarding(db: SqlDatabase): OnboardingState {
  return readState(
    db,
    ONBOARDING,
    (value) => OnboardingStateSchema.safeParse(value),
    FIRST_RUN_ONBOARDING,
  );
}

export function saveOnboarding(db: SqlDatabase, next: OnboardingState): OnboardingState {
  const before = readOnboarding(db);
  writeState(db, ONBOARDING, next);
  if (next.result && next.result.takenAt !== before.result?.takenAt) {
    logActivity(
      db,
      'placement-finished',
      null,
      `${next.result.correct} of ${next.result.total} correct`,
    );
  }
  return next;
}

export function readExamPlan(db: SqlDatabase): ExamPlan {
  return readState(db, EXAM_PLAN, (value) => ExamPlanSchema.safeParse(value), EMPTY_EXAM_PLAN);
}

export function saveExamPlan(db: SqlDatabase, next: ExamPlan): ExamPlan {
  const before = readExamPlan(db);
  writeState(db, EXAM_PLAN, next);
  if (next.date && next.date !== before.date) {
    logActivity(db, 'exam-date-set', null, next.date);
  }
  return next;
}
