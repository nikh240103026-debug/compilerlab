import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, 'tokens.css'), 'utf8');

function readTheme(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [match[1], match[2]]),
  ) as Record<string, string>;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['canvas', 'surface', 'surface-2', 'surface-3'];
const MODULES = Array.from({ length: 9 }, (_, i) => `module-${i}`);
const STATUS = ['success', 'warning', 'danger', 'info'];
const TOKENS = ['keyword', 'identifier', 'literal', 'operator', 'punctuation', 'comment'];

describe.each([
  ['light', "[data-theme='light']"],
  ['dark', "[data-theme='dark']"],
])('%s theme', (_name, selector) => {
  // The light block is declared as ":root,\n[data-theme='light']", so its selector still matches.
  const theme = readTheme(selector);
  const color = (name: string) => {
    const value = theme[name];
    if (!value) throw new Error(`Missing token --${name}`);
    return value;
  };

  it.each(
    [
      'ink',
      'ink-muted',
      'accent',
      ...STATUS,
      ...MODULES,
      ...TOKENS.map((t) => `token-${t}`),
    ].flatMap((text) => SURFACES.map((surface) => [text, surface] as const)),
  )('%s on %s meets AA for text', (text, surface) => {
    expect(contrast(color(text), color(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['on-accent', 'accent'],
    ['on-accent', 'accent-hover'],
    ['accent', 'accent-soft'],
    ['ink', 'accent-soft'],
    ['diff-add-ink', 'diff-add'],
    ['diff-remove-ink', 'diff-remove'],
  ])('%s on %s meets AA for text', (text, background) => {
    expect(contrast(color(text), color(background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)('control borders and focus rings stand out on %s', (surface) => {
    expect(contrast(color('line-strong'), color(surface))).toBeGreaterThanOrEqual(3);
    expect(contrast(color('focus'), color(surface))).toBeGreaterThanOrEqual(3);
  });
});
