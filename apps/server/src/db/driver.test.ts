import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from './driver';

describe.each(['better-sqlite3', 'node:sqlite'] as const)('%s driver', (driver) => {
  const open = async () => {
    const db = await openDatabase(':memory:', { driver });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    return db;
  };

  it('identifies itself', async () => {
    const db = await open();
    expect(db.driver).toBe(driver);
    db.close();
  });

  it('runs statements with parameters', async () => {
    const db = await open();
    db.prepare('INSERT INTO t (name) VALUES (?)').run('lexer');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('parser');
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(2)).toMatchObject({ name: 'parser' });
    expect(db.prepare('SELECT name FROM t ORDER BY id').all()).toHaveLength(2);
    db.close();
  });

  it('returns undefined when a row is missing', async () => {
    const db = await open();
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(99)).toBeUndefined();
    db.close();
  });

  it('commits a transaction and returns its value', async () => {
    const db = await open();
    const value = db.transaction(() => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
      return 7;
    });
    expect(value).toBe(7);
    expect(db.prepare('SELECT * FROM t').all()).toHaveLength(1);
    db.close();
  });

  it('rolls back when a transaction throws', async () => {
    const db = await open();
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(db.prepare('SELECT * FROM t').all()).toHaveLength(0);
    db.close();
  });
});

describe('driver fallback', () => {
  const broken = () => Promise.reject(new Error('Could not locate the bindings file'));

  it('falls back to node:sqlite when better-sqlite3 cannot load', async () => {
    const onFallback = vi.fn();
    const db = await openDatabase(':memory:', { loadPrimary: broken, onFallback });
    expect(db.driver).toBe('node:sqlite');
    expect(onFallback).toHaveBeenCalledOnce();
    db.close();
  });

  it('does not fall back when better-sqlite3 was asked for by name', async () => {
    await expect(
      openDatabase(':memory:', { driver: 'better-sqlite3', loadPrimary: broken }),
    ).rejects.toThrow('bindings');
  });
});
