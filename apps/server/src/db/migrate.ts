import type { SqlDatabase } from './driver';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Append only. Never edit a migration that has shipped.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'settings',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'topic_progress',
    sql: `
      CREATE TABLE topic_progress (
        topic_id TEXT PRIMARY KEY,
        read_at TEXT,
        visualizer_at TEXT,
        best_quiz_score INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'lab',
    sql: `
      CREATE TABLE lab_workspaces (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE lab_progress (
        exercise_id TEXT PRIMARY KEY,
        passed_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
    `,
  },
];

export class DatabaseTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `This database was created by a newer CompilerLab (schema ${found}, this version supports ${supported}). Update the app, or restore an older backup from data/backups.`,
    );
    this.name = 'DatabaseTooNewError';
  }
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;
  `);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  const current = row.version ?? 0;
  const latest = Math.max(0, ...migrations.map((migration) => migration.version));
  if (current > latest) throw new DatabaseTooNewError(current, latest);

  const pending = migrations
    .filter((migration) => migration.version > current)
    .toSorted((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      );
    });
  }
  return pending.map((migration) => migration.version);
}
