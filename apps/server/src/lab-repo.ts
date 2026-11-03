import { LabWorkspaceSchema, type LabProgress, type LabWorkspace } from '@compilerlab/shared';
import type { SqlDatabase } from './db/driver';

export function readWorkspace(db: SqlDatabase, id: string): LabWorkspace | null {
  const row = db.prepare('SELECT data FROM lab_workspaces WHERE id = ?').get(id) as
    { data: string } | undefined;
  if (!row) return null;
  try {
    const parsed = LabWorkspaceSchema.safeParse(JSON.parse(row.data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveWorkspace(db: SqlDatabase, id: string, workspace: LabWorkspace): void {
  db.prepare(
    `INSERT INTO lab_workspaces (id, data) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
  ).run(id, JSON.stringify(workspace));
}

export function deleteWorkspace(db: SqlDatabase, id: string): void {
  db.prepare('DELETE FROM lab_workspaces WHERE id = ?').run(id);
}

export function readLabProgress(db: SqlDatabase): LabProgress[] {
  const rows = db
    .prepare('SELECT exercise_id, passed_at FROM lab_progress ORDER BY passed_at')
    .all() as { exercise_id: string; passed_at: string }[];
  return rows.map((row) => ({ exerciseId: row.exercise_id, passedAt: row.passed_at }));
}

export function markExercisePassed(db: SqlDatabase, exerciseId: string): void {
  db.prepare('INSERT OR IGNORE INTO lab_progress (exercise_id) VALUES (?)').run(exerciseId);
}
