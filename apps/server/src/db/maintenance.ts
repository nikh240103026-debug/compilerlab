import type { DbDriver } from '@compilerlab/shared';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE_NAME } from './app-database';
import { openDatabase } from './driver';

/** Writes a consistent copy to data/backups and returns its path, or null if there is no data. */
export async function backupDatabase(
  dataDir: string,
  driver?: DbDriver,
  now: Date = new Date(),
): Promise<string | null> {
  const source = join(dataDir, DB_FILE_NAME);
  if (!existsSync(source)) return null;

  const backups = join(dataDir, 'backups');
  mkdirSync(backups, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = join(backups, `compilerlab-${stamp}.db`);

  const db = await openDatabase(source, { driver });
  try {
    // VACUUM INTO is safe while the app is running and works on both drivers.
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  return target;
}

/** Deletes the database and lab runs. Backups are deliberately kept. */
export function resetData(dataDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dataDir, `${DB_FILE_NAME}${suffix}`), { force: true });
  }
  rmSync(join(dataDir, 'runs'), { recursive: true, force: true });
}
