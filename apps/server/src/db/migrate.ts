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
  {
    version: 4,
    name: 'ai',
    sql: `
      CREATE TABLE ai_cache (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE INDEX ai_cache_last_used ON ai_cache (last_used_at);
      CREATE TABLE ai_usage (
        day TEXT PRIMARY KEY,
        requests INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE ai_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        note TEXT,
        topic_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: 'assessment',
    sql: `
      CREATE TABLE assessment_attempts (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        config TEXT NOT NULL,
        paper TEXT NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER,
        finished_at INTEGER,
        result TEXT
      ) STRICT;
      CREATE INDEX assessment_attempts_started ON assessment_attempts (started_at);
      CREATE TABLE assessment_answers (
        attempt_id TEXT NOT NULL REFERENCES assessment_attempts (id) ON DELETE CASCADE,
        question_key TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        marks REAL NOT NULL,
        answer TEXT,
        grade TEXT,
        score REAL,
        earned REAL,
        seconds INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (attempt_id, question_key)
      ) STRICT;
      CREATE INDEX assessment_answers_topic ON assessment_answers (topic_id, updated_at);
      CREATE TABLE flashcard_reviews (
        card_key TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        ease REAL NOT NULL,
        interval_days INTEGER NOT NULL,
        repetitions INTEGER NOT NULL,
        due_on TEXT NOT NULL,
        last_quality INTEGER NOT NULL,
        reviewed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX flashcard_reviews_due ON flashcard_reviews (due_on);
      CREATE TABLE generated_questions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        question TEXT NOT NULL,
        model TEXT,
        reviewed_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX generated_questions_topic ON generated_questions (topic_id, created_at);
    `,
  },
  {
    version: 6,
    name: 'learner',
    sql: `
      CREATE TABLE learner_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE study_time (
        day TEXT NOT NULL,
        area TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, area, topic_id)
      ) STRICT;
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        topic_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE notes (
        topic_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE bookmarks (
        topic_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        prefix TEXT NOT NULL,
        suffix TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
      CREATE INDEX highlights_topic ON highlights (topic_id);
      CREATE TABLE earned_badges (
        badge_id TEXT PRIMARY KEY,
        earned_at TEXT NOT NULL DEFAULT (datetime('now'))
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
