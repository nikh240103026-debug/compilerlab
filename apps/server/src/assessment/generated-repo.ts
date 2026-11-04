import type {
  AiGeneratedQuestion,
  GeneratedQuestion,
  PracticeProblem,
  QuestionDifficulty,
} from '@compilerlab/shared';
import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../db/driver';

interface GeneratedRow {
  id: string;
  topic_id: string;
  difficulty: QuestionDifficulty;
  question: string;
  model: string | null;
  reviewed_at: number | null;
  created_at: number;
}

const toGenerated = (row: GeneratedRow): GeneratedQuestion => ({
  id: row.id,
  topicId: row.topic_id,
  difficulty: row.difficulty,
  question: JSON.parse(row.question) as PracticeProblem,
  model: row.model,
  reviewed: row.reviewed_at !== null,
  createdAt: row.created_at,
});

export function readGenerated(db: SqlDatabase, topicId?: string): GeneratedQuestion[] {
  const rows = topicId
    ? db
        .prepare('SELECT * FROM generated_questions WHERE topic_id = ? ORDER BY created_at DESC')
        .all(topicId)
    : db.prepare('SELECT * FROM generated_questions ORDER BY created_at DESC').all();
  return (rows as GeneratedRow[]).map(toGenerated);
}

/**
 * The model chooses its own ids, and a second batch could repeat one. The question's id is what a
 * test's key is made from, so each stored question gets one of its own.
 */
export function saveGenerated(
  db: SqlDatabase,
  topicId: string,
  difficulty: QuestionDifficulty,
  model: string | null,
  questions: readonly AiGeneratedQuestion[],
): GeneratedQuestion[] {
  const now = Date.now();
  const saved = questions.map((question): GeneratedQuestion => {
    const id = randomUUID();
    return {
      id,
      topicId,
      difficulty,
      question: { ...question, id: `ai-${id}` },
      model,
      reviewed: false,
      createdAt: now,
    };
  });
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO generated_questions (id, topic_id, difficulty, question, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of saved) {
      insert.run(item.id, topicId, difficulty, JSON.stringify(item.question), model, now);
    }
  });
  return saved;
}

export function setGeneratedReviewed(
  db: SqlDatabase,
  id: string,
  reviewed: boolean,
): GeneratedQuestion | null {
  db.prepare('UPDATE generated_questions SET reviewed_at = ? WHERE id = ?').run(
    reviewed ? Date.now() : null,
    id,
  );
  const row = db.prepare('SELECT * FROM generated_questions WHERE id = ?').get(id);
  return row ? toGenerated(row as GeneratedRow) : null;
}

export function deleteGenerated(db: SqlDatabase, id: string): void {
  db.prepare('DELETE FROM generated_questions WHERE id = ?').run(id);
}
