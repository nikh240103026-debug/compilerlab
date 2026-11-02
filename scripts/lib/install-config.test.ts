import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './env.mjs';

describe('install configuration', () => {
  it('keeps install scripts off, or a fresh clone tries to compile better-sqlite3', () => {
    const npmrc = readFileSync(join(ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
  });

  it('pins Node 22', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('22');
    expect(pkg.engines.node).toMatch(/22/);
  });
});
