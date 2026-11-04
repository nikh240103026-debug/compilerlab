import {
  UNANSWERED_GRADE,
  earnedMarks,
  isAnswerEmpty,
  nextAdaptiveLevel,
  pickAdaptiveQuestion,
  distributeMarks,
  scoreAttempt,
  type AttemptConfig,
  type AttemptResult,
  type AttemptStatus,
  type AttemptSummary,
  type AttemptView,
  type FinishAttemptRequest,
  type GradeResult,
  type MarkAnswerRequest,
  type PaperQuestion,
  type QuestionAnswer,
  type QuestionDifficulty,
  type SaveAnswerRequest,
  type SavedAnswer,
} from '@compilerlab/shared';
import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../db/driver';
import { updateProgress } from '../progress-repo';
import type { BuiltPaper } from './paper';

/** A save can arrive just after the clock stops, because the page sends it when the time runs out. */
const DEADLINE_GRACE_MS = 15_000;

interface AttemptRow {
  id: string;
  mode: AttemptView['mode'];
  title: string;
  status: AttemptStatus;
  config: string;
  paper: string;
  current_index: number;
  started_at: number;
  deadline_at: number | null;
  finished_at: number | null;
  result: string | null;
}

interface AnswerRow {
  question_key: string;
  answer: string | null;
  grade: string | null;
  earned: number | null;
  seconds: number;
  flagged: number;
}

interface StoredPaper {
  questions: PaperQuestion[];
  pool: PaperQuestion[];
  notes: string[];
  level: QuestionDifficulty | null;
  /** True when an adaptive test has served all it is going to. */
  done?: boolean;
}

/** Why a request about an attempt was refused. The routes turn this into a readable response. */
export class AttemptError extends Error {
  constructor(
    readonly code: 'not_found' | 'attempt_finished' | 'time_up' | 'unknown_question',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function toAnswer(row: AnswerRow): SavedAnswer {
  return {
    key: row.question_key,
    answer: row.answer === null ? null : (JSON.parse(row.answer) as QuestionAnswer),
    grade: row.grade === null ? null : (JSON.parse(row.grade) as GradeResult),
    seconds: row.seconds,
    flagged: row.flagged === 1,
    earned: row.earned,
  };
}

function readRow(db: SqlDatabase, id: string): AttemptRow {
  const row = db.prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(id);
  if (!row) throw new AttemptError('not_found', 'There is no test with that id.', 404);
  return row as AttemptRow;
}

function readAnswers(db: SqlDatabase, id: string): SavedAnswer[] {
  const rows = db
    .prepare(
      'SELECT question_key, answer, grade, earned, seconds, flagged FROM assessment_answers WHERE attempt_id = ?',
    )
    .all(id);
  return (rows as AnswerRow[]).map(toAnswer);
}

function viewOf(db: SqlDatabase, row: AttemptRow): AttemptView {
  const paper = JSON.parse(row.paper) as StoredPaper;
  return {
    id: row.id,
    mode: row.mode,
    title: row.title,
    status: row.status,
    config: JSON.parse(row.config) as AttemptConfig,
    questions: paper.questions,
    answers: readAnswers(db, row.id),
    currentIndex: row.current_index,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    finishedAt: row.finished_at,
    serverNow: Date.now(),
    adaptiveLevel: paper.level,
    adaptiveDone: paper.done === true,
    notes: paper.notes,
    result: row.result === null ? null : (JSON.parse(row.result) as AttemptResult),
  };
}

export function readAttempt(db: SqlDatabase, id: string): AttemptView {
  return viewOf(db, readRow(db, id));
}

export function createAttempt(
  db: SqlDatabase,
  config: AttemptConfig,
  title: string,
  paper: BuiltPaper,
): AttemptView {
  const id = randomUUID();
  const now = Date.now();
  const deadline = config.durationMinutes === null ? null : now + config.durationMinutes * 60_000;
  db.prepare(
    `INSERT INTO assessment_attempts (id, mode, title, status, config, paper, started_at, deadline_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(id, config.mode, title, JSON.stringify(config), JSON.stringify(paper), now, deadline);
  return readAttempt(db, id);
}

export function deleteAttempt(db: SqlDatabase, id: string): void {
  db.prepare('DELETE FROM assessment_attempts WHERE id = ?').run(id);
}

function upsertAnswer(
  db: SqlDatabase,
  attemptId: string,
  item: PaperQuestion,
  fields: {
    answer: QuestionAnswer | null;
    grade: GradeResult | null;
    earned: number | null;
    seconds: number;
    flagged: boolean;
  },
): void {
  const { answer, grade, earned, seconds, flagged } = fields;
  db.prepare(
    `INSERT INTO assessment_answers
       (attempt_id, question_key, topic_id, marks, answer, grade, score, earned, seconds, flagged, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, question_key) DO UPDATE SET
       answer = excluded.answer,
       grade = excluded.grade,
       score = excluded.score,
       earned = excluded.earned,
       seconds = excluded.seconds,
       flagged = excluded.flagged,
       updated_at = excluded.updated_at`,
  ).run(
    attemptId,
    item.key,
    item.topicId,
    item.marks,
    answer === null ? null : JSON.stringify(answer),
    grade === null ? null : JSON.stringify(grade),
    grade === null || grade.verdict === 'pending' ? null : grade.score,
    earned,
    seconds,
    flagged ? 1 : 0,
    Date.now(),
  );
}

function questionOf(paper: StoredPaper, key: string): PaperQuestion {
  const item = paper.questions.find((question) => question.key === key);
  if (!item) {
    throw new AttemptError('unknown_question', 'That question is not part of this test.', 400);
  }
  return item;
}

/** Every change to a test goes through here, so a finished test and a stopped clock stay final. */
export function saveAnswer(db: SqlDatabase, id: string, save: SaveAnswerRequest): void {
  const row = readRow(db, id);
  if (row.status !== 'active') {
    throw new AttemptError('attempt_finished', 'This test has already finished.', 409);
  }
  if (row.deadline_at !== null && Date.now() > row.deadline_at + DEADLINE_GRACE_MS) {
    throw new AttemptError('time_up', 'The time for this test has run out.', 409);
  }
  const paper = JSON.parse(row.paper) as StoredPaper;
  const config = JSON.parse(row.config) as AttemptConfig;
  const item = questionOf(paper, save.key);
  const existing = readAnswers(db, id).find((answer) => answer.key === save.key);
  // A later save with no grade is only an update of the time spent, so the earlier grade stays.
  const grade = save.grade === undefined ? (existing?.grade ?? null) : save.grade;
  const earned = earnedMarks({ marks: item.marks, type: item.question.type }, grade, config);
  db.transaction(() => {
    upsertAnswer(db, id, item, {
      answer: save.answer,
      grade,
      earned,
      seconds: save.seconds,
      flagged: save.flagged,
    });
    db.prepare('UPDATE assessment_attempts SET current_index = ? WHERE id = ?').run(
      Math.min(save.currentIndex, Math.max(0, paper.questions.length - 1)),
      id,
    );
  });
}

/**
 * Serves an adaptive test's next question, at a difficulty set by the answer just given. Calling it
 * before the current question is answered changes nothing, so a double click is harmless.
 */
export function serveNextQuestion(db: SqlDatabase, id: string): AttemptView {
  const row = readRow(db, id);
  const paper = JSON.parse(row.paper) as StoredPaper;
  const config = JSON.parse(row.config) as AttemptConfig;
  if (row.status !== 'active' || row.mode !== 'adaptive' || paper.done) return viewOf(db, row);

  const last = paper.questions.at(-1);
  const answered = last && readAnswers(db, id).find((answer) => answer.key === last.key);
  if (!last || !answered?.grade) return viewOf(db, row);

  const level = nextAdaptiveLevel(paper.level ?? 'medium', answered.grade.verdict);
  const next =
    paper.questions.length >= config.questionCount ? null : pickAdaptiveQuestion(paper.pool, level);
  const updated: StoredPaper = next
    ? {
        ...paper,
        level,
        questions: [
          ...paper.questions,
          { ...next, marks: distributeMarks([next.question.difficulty], null)[0] as number },
        ],
        pool: paper.pool.filter(({ key }) => key !== next.key),
      }
    : { ...paper, level, done: true };
  db.prepare('UPDATE assessment_attempts SET paper = ?, current_index = ? WHERE id = ?').run(
    JSON.stringify(updated),
    updated.questions.length - 1,
    id,
  );
  return readAttempt(db, id);
}

/** Recomputes the score from what is stored, so a late mark can never leave it out of date. */
function storeResult(db: SqlDatabase, row: AttemptRow): AttemptResult {
  const paper = JSON.parse(row.paper) as StoredPaper;
  const config = JSON.parse(row.config) as AttemptConfig;
  const result = scoreAttempt(paper.questions, readAnswers(db, row.id), config);
  db.prepare('UPDATE assessment_attempts SET result = ? WHERE id = ?').run(
    JSON.stringify(result),
    row.id,
  );
  // A passed topic test is a passed quiz. The best score only ever goes up.
  const onlyTopic = config.topicIds[0];
  if (row.mode === 'topic' && config.topicIds.length === 1 && onlyTopic && result.pending === 0) {
    updateProgress(db, onlyTopic, { quizScore: result.percent });
  }
  return result;
}

/**
 * Ends a test. The page sends a grade for each answer that has none, since the engine runs in the
 * browser. It is fine to call this twice, or after the clock has run out while the page was closed.
 */
export function finishAttempt(
  db: SqlDatabase,
  id: string,
  { grades }: FinishAttemptRequest,
): AttemptView {
  const row = readRow(db, id);
  if (row.status === 'finished') return viewOf(db, row);
  const paper = JSON.parse(row.paper) as StoredPaper;
  const config = JSON.parse(row.config) as AttemptConfig;
  const saved = new Map(readAnswers(db, id).map((answer) => [answer.key, answer]));

  db.transaction(() => {
    for (const item of paper.questions) {
      const existing = saved.get(item.key);
      const answer = existing?.answer ?? null;
      const grade = isAnswerEmpty(answer)
        ? UNANSWERED_GRADE
        : (existing?.grade ?? grades[item.key] ?? null);
      upsertAnswer(db, id, item, {
        answer,
        grade,
        earned: earnedMarks({ marks: item.marks, type: item.question.type }, grade, config),
        seconds: existing?.seconds ?? 0,
        flagged: existing?.flagged ?? false,
      });
    }
    db.prepare(
      `UPDATE assessment_attempts SET status = 'finished', finished_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
    storeResult(db, row);
  });
  return readAttempt(db, id);
}

/** A self-mark or an AI grade for one answer, during a test or long after it. */
export function markAnswer(
  db: SqlDatabase,
  id: string,
  { key, grade }: MarkAnswerRequest,
): AttemptView {
  const row = readRow(db, id);
  const paper = JSON.parse(row.paper) as StoredPaper;
  const config = JSON.parse(row.config) as AttemptConfig;
  const item = questionOf(paper, key);
  const existing = readAnswers(db, id).find((answer) => answer.key === key);
  db.transaction(() => {
    upsertAnswer(db, id, item, {
      answer: existing?.answer ?? null,
      grade,
      earned: earnedMarks({ marks: item.marks, type: item.question.type }, grade, config),
      seconds: existing?.seconds ?? 0,
      flagged: existing?.flagged ?? false,
    });
    if (row.status === 'finished') storeResult(db, row);
  });
  return readAttempt(db, id);
}

export function listAttempts(db: SqlDatabase, limit: number): AttemptSummary[] {
  const rows = db
    .prepare('SELECT * FROM assessment_attempts ORDER BY started_at DESC LIMIT ?')
    .all(limit) as AttemptRow[];
  const serverNow = Date.now();
  return rows.map((row) => {
    const paper = JSON.parse(row.paper) as StoredPaper;
    const result = row.result === null ? null : (JSON.parse(row.result) as AttemptResult);
    const { answered, seconds } = db
      .prepare(
        `SELECT COUNT(answer) AS answered, COALESCE(SUM(seconds), 0) AS seconds
         FROM assessment_answers WHERE attempt_id = ?`,
      )
      .get(row.id) as { answered: number; seconds: number };
    return {
      id: row.id,
      mode: row.mode,
      title: row.title,
      status: row.status,
      questionCount: paper.questions.length,
      answeredCount: answered,
      score: result?.score ?? null,
      maxScore: result?.maxScore ?? null,
      percent: result?.percent ?? null,
      pending: result?.pending ?? 0,
      seconds,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
      finishedAt: row.finished_at,
      serverNow,
    };
  });
}

/** Keys of the questions in a finished test that earned full marks. */
export function correctKeys(attempt: AttemptView): Set<string> {
  return new Set(
    attempt.answers.filter(({ grade }) => grade?.verdict === 'correct').map(({ key }) => key),
  );
}
