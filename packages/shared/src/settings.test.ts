import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './constants';
import { parseStoredSettings, SettingsPatchSchema, SettingsSchema } from './settings';
import { applySettingsPatch } from './settings-patch';

describe('settings schema', () => {
  it('accepts the defaults', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    [{ theme: 'neon' }],
    [{ fontSize: 8 }],
    [{ fontSize: 16.5 }],
    [{ animationSpeed: 0 }],
    [{ editorKeymap: 'nano' }],
    [{ geminiModel: 'gemini; rm -rf /' }],
    [{ unknownSetting: true }],
    [{ toolPaths: { cc: '/usr/bin/cc' } }],
  ])('rejects the bad patch %j', (patch) => {
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(false);
  });

  it('accepts a partial tool path patch', () => {
    expect(SettingsPatchSchema.parse({ toolPaths: { gcc: 'C:\\msys64\\bin\\gcc.exe' } })).toEqual({
      toolPaths: { gcc: 'C:\\msys64\\bin\\gcc.exe' },
    });
  });
});

describe('applySettingsPatch', () => {
  it('merges tool paths without losing the others', () => {
    const start = applySettingsPatch(DEFAULT_SETTINGS, { toolPaths: { flex: '/a/flex' } });
    const next = applySettingsPatch(start, { toolPaths: { gcc: '/a/gcc' }, theme: 'dark' });
    expect(next.toolPaths).toMatchObject({ flex: '/a/flex', gcc: '/a/gcc', bison: '' });
    expect(next.theme).toBe('dark');
  });

  it('does not change the input', () => {
    applySettingsPatch(DEFAULT_SETTINGS, { theme: 'dark' });
    expect(DEFAULT_SETTINGS.theme).toBe('system');
  });
});

describe('parseStoredSettings', () => {
  it('falls back per field and reports what was invalid', () => {
    const { settings, invalidKeys } = parseStoredSettings({
      theme: 'dark',
      fontSize: 'huge',
      removedLongAgo: 1,
    });
    expect(settings.theme).toBe('dark');
    expect(settings.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(invalidKeys).toEqual(['fontSize', 'removedLongAgo']);
  });
});
