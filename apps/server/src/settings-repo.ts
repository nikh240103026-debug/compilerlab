import {
  applySettingsPatch,
  parseStoredSettings,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '@compilerlab/shared';
import type { SqlDatabase } from './db/driver';

const UNREADABLE = Symbol('unreadable');

function parseRow(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return UNREADABLE;
  }
}

/** Never throws on bad stored data: each bad value falls back to its default. */
export function readSettings(
  db: SqlDatabase,
  onInvalid?: (keys: readonly string[]) => void,
): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const stored = Object.fromEntries(rows.map((row) => [row.key, parseRow(row.value)]));
  const { settings, invalidKeys } = parseStoredSettings(stored);
  if (invalidKeys.length > 0) onInvalid?.(invalidKeys);
  return settings;
}

export function updateSettings(db: SqlDatabase, patch: SettingsPatch): Settings {
  const next = SettingsSchema.parse(applySettingsPatch(readSettings(db), patch));
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  db.transaction(() => {
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      upsert.run(key, JSON.stringify(next[key]));
    }
  });
  return next;
}

export function resetSettings(db: SqlDatabase): Settings {
  db.exec('DELETE FROM settings');
  return readSettings(db);
}
