import type { DbDriver } from '@compilerlab/shared';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type SqlDatabase } from './driver';
import { migrate } from './migrate';

export const DB_FILE_NAME = 'compilerlab.db';

/** Opens ./data/compilerlab.db, creating and migrating it as needed. */
export async function openAppDatabase(
  dataDir: string,
  options: { driver?: DbDriver | undefined; onFallback?: (error: unknown) => void } = {},
): Promise<SqlDatabase> {
  mkdirSync(dataDir, { recursive: true });
  const db = await openDatabase(join(dataDir, DB_FILE_NAME), options);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
