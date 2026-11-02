import type { DbDriver } from '@compilerlab/shared';

type SqlValue = string | number | bigint | null;

export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface SqlDatabase {
  readonly driver: DbDriver;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs fn in a transaction and rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** The API that better-sqlite3 and node:sqlite have in common. */
interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close(): unknown;
}

function wrap(driver: DbDriver, raw: RawDatabase): SqlDatabase {
  return {
    driver,
    exec: (sql) => void raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => void raw.close(),
  };
}

async function loadBetterSqlite(file: string): Promise<RawDatabase> {
  const { default: Database } = await import('better-sqlite3');
  return new Database(file) as unknown as RawDatabase;
}

function openNodeSqlite(file: string): SqlDatabase {
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('This version of Node does not include node:sqlite.');
  return wrap('node:sqlite', new sqlite.DatabaseSync(file) as unknown as RawDatabase);
}

export interface OpenOptions {
  /** Forces a driver. When unset, node:sqlite is the fallback for better-sqlite3. */
  driver?: DbDriver | undefined;
  onFallback?: (error: unknown) => void;
  loadPrimary?: (file: string) => Promise<RawDatabase>;
}

export async function openDatabase(file: string, options: OpenOptions = {}): Promise<SqlDatabase> {
  const { driver, onFallback, loadPrimary = loadBetterSqlite } = options;
  if (driver === 'node:sqlite') return openNodeSqlite(file);
  try {
    return wrap('better-sqlite3', await loadPrimary(file));
  } catch (error) {
    if (driver === 'better-sqlite3') throw error;
    onFallback?.(error);
    return openNodeSqlite(file);
  }
}
