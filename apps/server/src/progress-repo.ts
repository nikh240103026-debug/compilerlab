import type { TopicProgress, TopicProgressPatch } from '@compilerlab/shared';
import type { SqlDatabase } from './db/driver';

interface ProgressRow {
  topic_id: string;
  read_at: string | null;
  visualizer_at: string | null;
  best_quiz_score: number | null;
  updated_at: string;
}

function toProgress(row: ProgressRow): TopicProgress {
  return {
    topicId: row.topic_id,
    read: row.read_at !== null,
    visualizerUsed: row.visualizer_at !== null,
    bestQuizScore: row.best_quiz_score,
    updatedAt: row.updated_at,
  };
}

export function readAllProgress(db: SqlDatabase): TopicProgress[] {
  const rows = db.prepare('SELECT * FROM topic_progress ORDER BY updated_at DESC').all();
  return (rows as ProgressRow[]).map(toProgress);
}

/** Records new facts. Old ones are kept, and only a better quiz score replaces the best. */
export function updateProgress(
  db: SqlDatabase,
  topicId: string,
  patch: TopicProgressPatch,
): TopicProgress {
  db.prepare(
    `INSERT INTO topic_progress (topic_id, read_at, visualizer_at, best_quiz_score)
     VALUES (
       ?,
       CASE WHEN ? = 1 THEN datetime('now') END,
       CASE WHEN ? = 1 THEN datetime('now') END,
       ?
     )
     ON CONFLICT (topic_id) DO UPDATE SET
       read_at = COALESCE(read_at, excluded.read_at),
       visualizer_at = COALESCE(visualizer_at, excluded.visualizer_at),
       best_quiz_score = CASE
         WHEN excluded.best_quiz_score IS NULL THEN best_quiz_score
         WHEN best_quiz_score IS NULL THEN excluded.best_quiz_score
         ELSE MAX(best_quiz_score, excluded.best_quiz_score)
       END,
       updated_at = datetime('now')`,
  ).run(topicId, patch.read ? 1 : 0, patch.visualizerUsed ? 1 : 0, patch.quizScore ?? null);
  const row = db.prepare('SELECT * FROM topic_progress WHERE topic_id = ?').get(topicId);
  return toProgress(row as ProgressRow);
}
