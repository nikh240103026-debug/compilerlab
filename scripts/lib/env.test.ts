import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureEnvFile, parseEnv, readEnv } from './env.mjs';

describe('parseEnv', () => {
  it('handles comments, blanks, quotes and CRLF', () => {
    const text = [
      '# comment',
      '',
      'PLAIN=value',
      'EMPTY=',
      'QUOTED="has # hash"',
      "SINGLE='x y'",
      'TRAILING=abc # note',
      'export EXPORTED=1',
      'not a pair',
    ].join('\r\n');
    expect(parseEnv(text)).toEqual({
      PLAIN: 'value',
      EMPTY: '',
      QUOTED: 'has # hash',
      SINGLE: 'x y',
      TRAILING: 'abc',
      EXPORTED: '1',
    });
  });
});

describe('.env bootstrap', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'compilerlab-env-'));
    writeFileSync(join(root, '.env.example'), 'GEMINI_API_KEY=\nPORT=4317\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .env from the example', () => {
    expect(ensureEnvFile(root).created).toBe(true);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('PORT=4317');
  });

  it('never overwrites an existing .env', () => {
    writeFileSync(join(root, '.env'), 'GEMINI_API_KEY=mine\n');
    expect(ensureEnvFile(root).created).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('GEMINI_API_KEY=mine\n');
  });

  it('lets the real environment win over the file', () => {
    writeFileSync(join(root, '.env'), 'PORT=1\nLOG_LEVEL=warn\n');
    expect(readEnv(root, { PORT: '2' })).toEqual({ PORT: '2', LOG_LEVEL: 'warn' });
  });

  it('works when there is no .env yet', () => {
    expect(readEnv(root, { PORT: '2' })).toEqual({ PORT: '2' });
  });
});
