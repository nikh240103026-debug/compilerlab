import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSettings, updateSettings } from '../settings-repo';
import { DB_FILE_NAME, openAppDatabase } from './app-database';
import { openDatabase } from './driver';
import { backupDatabase, resetData } from './maintenance';

describe('data maintenance', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'compilerlab-data-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates and migrates the database on first open', async () => {
    const nested = join(dataDir, 'a', 'b');
    const db = await openAppDatabase(nested);
    expect(readSettings(db).theme).toBe('system');
    db.close();
    expect(existsSync(join(nested, DB_FILE_NAME))).toBe(true);
  });

  it('keeps data across reopen', async () => {
    const first = await openAppDatabase(dataDir);
    updateSettings(first, { theme: 'dark' });
    first.close();
    const second = await openAppDatabase(dataDir);
    expect(readSettings(second).theme).toBe('dark');
    second.close();
  });

  it('reports nothing to back up before the first run', async () => {
    expect(await backupDatabase(dataDir)).toBeNull();
  });

  it('writes a backup that can be read, even while the app has the database open', async () => {
    const db = await openAppDatabase(dataDir);
    updateSettings(db, { fontSize: 20 });

    const target = await backupDatabase(dataDir, undefined, new Date('2026-01-02T03:04:05Z'));
    db.close();

    expect(target).toContain('compilerlab-2026-01-02T03-04-05-000Z.db');
    const copy = await openDatabase(target!);
    expect(readSettings(copy).fontSize).toBe(20);
    copy.close();
  });

  it('resets the database and runs but keeps backups', async () => {
    const db = await openAppDatabase(dataDir);
    db.close();
    await backupDatabase(dataDir);
    mkdirSync(join(dataDir, 'runs', 'job1'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', 'job1', 'a.c'), 'int main(void) { return 0; }');

    resetData(dataDir);

    expect(existsSync(join(dataDir, DB_FILE_NAME))).toBe(false);
    expect(existsSync(join(dataDir, 'runs'))).toBe(false);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1);
  });

  it('survives a reset when there is nothing to delete', () => {
    expect(() => resetData(dataDir)).not.toThrow();
  });
});
