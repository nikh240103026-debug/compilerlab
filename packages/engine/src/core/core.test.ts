import { describe, expect, it } from 'vitest';
import { attempt, EngineError } from './result';
import { deepFreeze, TraceRecorder } from './trace';

describe('TraceRecorder', () => {
  it('keeps steps in order', () => {
    const recorder = new TraceRecorder<number>();
    recorder.add('one', 'first', 1);
    recorder.add('two', 'second', 2);
    expect(recorder.finish().map((step) => step.state)).toEqual([1, 2]);
  });

  it('freezes snapshots so they cannot change later', () => {
    const recorder = new TraceRecorder<{ list: number[] }>();
    recorder.add('t', 'e', { list: [1] });
    const [step] = recorder.finish();
    expect(() => step?.state.list.push(2)).toThrow(TypeError);
    expect(Object.isFrozen(step)).toBe(true);
  });

  it('refuses to grow without limit', () => {
    const recorder = new TraceRecorder<number>(1);
    recorder.add('one', 'first', 1);
    expect(() => recorder.add('two', 'second', 2)).toThrow(EngineError);
  });
});

describe('deepFreeze', () => {
  it('freezes nested values and leaves primitives alone', () => {
    const value = deepFreeze({ a: { b: [1] } });
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});

describe('attempt', () => {
  it('passes values through', () => {
    expect(attempt(() => 1)).toEqual({ ok: true, value: 1 });
  });

  it('turns engine errors into a failed result', () => {
    const result = attempt(() => {
      throw new EngineError({ code: 'x', message: 'Readable' });
    });
    expect(result).toEqual({ ok: false, error: { code: 'x', message: 'Readable' } });
  });

  it('does not hide bugs', () => {
    expect(() =>
      attempt(() => {
        throw new TypeError('bug');
      }),
    ).toThrow('bug');
  });
});
