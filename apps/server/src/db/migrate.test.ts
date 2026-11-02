import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqlDatabase } from './driver';
import { DatabaseTooNewError, migrate, MIGRATIONS, type Migration } from './migrate';

const one: Migration = { version: 1, name: 'a', sql: 'CREATE TABLE a (id INTEGER) STRICT;' };
const two: Migration = { version: 2, name: 'b', sql: 'CREATE TABLE b (id INTEGER) STRICT;' };

describe('migrate', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
  });

  it('applies every real migration to an empty database', () => {
    expect(migrate(db)).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
  });

  it('does nothing the second time', () => {
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });

  it('applies only what is new, in version order', () => {
    expect(migrate(db, [one])).toEqual([1]);
    const three = { version: 3, name: 'c', sql: 'CREATE TABLE c (id INTEGER) STRICT;' };
    expect(migrate(db, [three, one, two])).toEqual([2, 3]);
  });

  it('rolls back a failing migration and leaves earlier ones in place', () => {
    const bad = { version: 2, name: 'bad', sql: 'CREATE TABLE ok (id INTEGER); NOT SQL;' };
    expect(() => migrate(db, [one, bad])).toThrow();
    expect(db.prepare('SELECT * FROM a').all()).toEqual([]);
    expect(() => db.prepare('SELECT * FROM ok').all()).toThrow();
    expect(migrate(db, [one, two])).toEqual([2]);
  });

  it('refuses a database from a newer version of the app', () => {
    migrate(db, [one, two]);
    expect(() => migrate(db, [one])).toThrow(DatabaseTooNewError);
  });
});
