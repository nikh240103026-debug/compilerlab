import { describe, expect, it } from 'vitest';
import { inlineCssVariables, sampleFrameIndexes } from './export';

describe('inlineCssVariables', () => {
  const style = {
    getPropertyValue: (name: string) =>
      ({ '--accent': ' #f2b544 ', '--font': '"Geist Mono", monospace' })[name] ?? '',
  } as CSSStyleDeclaration;

  it('writes theme colors into the markup', () => {
    expect(inlineCssVariables('<circle stroke="var(--accent)"/>', style)).toBe(
      '<circle stroke="#f2b544"/>',
    );
  });

  it('keeps attributes valid when a value contains quotation marks', () => {
    expect(inlineCssVariables('<text font-family="var(--font)"/>', style)).toBe(
      `<text font-family="'Geist Mono', monospace"/>`,
    );
  });

  it('leaves unknown variables alone', () => {
    expect(inlineCssVariables('fill="var(--nope)"', style)).toBe('fill="var(--nope)"');
  });
});

describe('sampleFrameIndexes', () => {
  it('keeps every frame of a short trace', () => {
    expect(sampleFrameIndexes(3)).toEqual([0, 1, 2]);
  });

  it('thins a long trace, keeping the first and last', () => {
    const frames = sampleFrameIndexes(1000, 5);
    expect(frames).toEqual([0, 250, 500, 749, 999]);
  });

  it('handles an empty trace', () => {
    expect(sampleFrameIndexes(0)).toEqual([]);
  });
});
