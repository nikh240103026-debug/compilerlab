import type { LearnerDataExport } from '@compilerlab/shared';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';
import { readSettings } from '../settings-repo';

/**
 * Both operations list the tables from the database itself, so a table added by a later migration
 * is exported and deleted without anyone having to remember to add it here.
 */
function allTables(db: SqlDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name).toSorted();
}

/** Bookkeeping, or copies of AI replies. None of it is the student's own data. */
const NOT_EXPORTED = new Set(['schema_migrations', 'settings', 'ai_cache', 'ai_usage']);

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function jsonSafeRow(row: unknown): unknown {
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([column, value]) => [
      column,
      jsonSafe(value),
    ]),
  );
}

export function exportAllData(db: SqlDatabase, config: AppConfig): LearnerDataExport {
  const { version } = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number;
  };
  const tables: Record<string, unknown[]> = {};
  for (const table of allTables(db)) {
    if (NOT_EXPORTED.has(table)) continue;
    // The name comes from sqlite_master, not from a request.
    tables[table] = db.prepare(`SELECT * FROM "${table}"`).all().map(jsonSafeRow);
  }
  return {
    app: 'CompilerLab',
    appVersion: config.version,
    exportedAt: new Date().toISOString(),
    schemaVersion: version,
    settings: readSettings(db),
    tables,
  };
}

/**
 * Empties every table except the record of which migrations have run, and removes the lab's run
 * folders. Backups are the student's own copies, so they stay, and the page says so.
 */
export function deleteAllData(db: SqlDatabase, config: AppConfig): void {
  const tables = allTables(db).filter((table) => table !== 'schema_migrations');
  db.transaction(() => {
    // The order of the deletes does not matter, because foreign keys are checked at the end.
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
    const hasSequence = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .get();
    if (hasSequence) db.prepare('DELETE FROM sqlite_sequence').run();
  });

  // Deleted rows stay in the file until it is rebuilt, and a student who deletes wants them gone.
  // Neither step is essential, because the rows are already unreachable.
  try {
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Another request was using the database. The space is reused later.
  }
  try {
    rmSync(join(config.dataDir, 'runs'), { recursive: true, force: true });
  } catch {
    // A job may still be running there. Old runs are swept when the next job starts.
  }
}
