import type { AiFeedbackRequest } from '@compilerlab/shared';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from '../db/driver';

const MAX_CACHE_ENTRIES = 2000;
const CACHE_DAYS = 30;

/** Identical requests have identical keys. The context is part of the request, so it counts. */
export function cacheKeyOf(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

/** The saved reply to an identical earlier request, or null. */
export function readCache<T>(db: SqlDatabase, key: string): T | null {
  const row = db
    .prepare(
      `SELECT response FROM ai_cache WHERE key = ? AND created_at >= datetime('now', '-${CACHE_DAYS} days')`,
    )
    .get(key) as { response: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE ai_cache SET last_used_at = datetime('now') WHERE key = ?").run(key);
  try {
    return JSON.parse(row.response) as T;
  } catch {
    return null;
  }
}

export function writeCache(
  db: SqlDatabase,
  entry: { key: string; kind: string; model: string; response: unknown },
): void {
  db.prepare(
    `INSERT INTO ai_cache (key, kind, model, response) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       response = excluded.response,
       created_at = datetime('now'),
       last_used_at = datetime('now')`,
  ).run(entry.key, entry.kind, entry.model, JSON.stringify(entry.response));
  db.prepare(
    `DELETE FROM ai_cache WHERE key IN (
       SELECT key FROM ai_cache ORDER BY last_used_at DESC LIMIT -1 OFFSET ${MAX_CACHE_ENTRIES}
     )`,
  ).run();
}

export function countAiRequest(db: SqlDatabase): void {
  db.prepare(
    `INSERT INTO ai_usage (day, requests) VALUES (date('now', 'localtime'), 1)
     ON CONFLICT (day) DO UPDATE SET requests = requests + 1`,
  ).run();
}

export function aiRequestsToday(db: SqlDatabase): number {
  const row = db
    .prepare("SELECT requests FROM ai_usage WHERE day = date('now', 'localtime')")
    .get() as { requests: number } | undefined;
  return Number(row?.requests ?? 0);
}

/** Part 8's Report wrong answer button. Stays on this computer. */
export function saveFeedback(db: SqlDatabase, feedback: AiFeedbackRequest): number {
  const result = db
    .prepare(
      `INSERT INTO ai_feedback (source, question, answer, note, topic_id, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      feedback.source,
      feedback.question,
      feedback.answer,
      feedback.note ?? null,
      feedback.topicId ?? null,
      feedback.model ?? null,
    ) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}
