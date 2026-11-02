import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, loadConfig } from './config';

const root = findRepoRoot(import.meta.dirname);

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({}, root);
    expect(config).toMatchObject({ port: 4317, isProduction: false, logLevel: 'warn' });
    expect(config.dataDir).toBe(resolve(root, 'data'));
    expect(config.geminiApiKey).toBe('');
  });

  it('treats blank values as unset', () => {
    expect(loadConfig({ PORT: '', LOG_LEVEL: '' }, root).port).toBe(4317);
  });

  it('reads overrides', () => {
    const config = loadConfig(
      { PORT: '5000', NODE_ENV: 'production', GEMINI_API_KEY: ' k ' },
      root,
    );
    expect(config).toMatchObject({ port: 5000, isProduction: true, geminiApiKey: 'k' });
  });

  it('names the bad value in a readable error', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' }, root)).toThrow(/fix these values.*\n.*PORT/s);
  });

  it('does not include secret values in the error', () => {
    expect(() => loadConfig({ PORT: '99999', GEMINI_API_KEY: 'top-secret' }, root)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('top-secret') }),
    );
  });
});

describe('findRepoRoot', () => {
  it('throws outside the project', () => {
    expect(() => findRepoRoot(resolve('/'))).toThrow(/project root/);
  });
});
