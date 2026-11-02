import { describe, expect, it } from 'vitest';
import { modules } from './index';

describe('course modules', () => {
  it('covers modules 0 to 8 in order', () => {
    expect(modules.map((m) => m.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('uses unique ids', () => {
    expect(new Set(modules.map((m) => m.id)).size).toBe(modules.length);
  });

  it('draws the six sequential phases on the pipeline', () => {
    expect(modules.filter((m) => m.pipelineStage).map((m) => m.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('marks only the advanced tracks as optional', () => {
    expect(modules.filter((m) => m.optional).map((m) => m.number)).toEqual([8]);
  });
});
