import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEED, MIN_SPEED, usePlayer } from './use-player';

describe('usePlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (length = 4, options = {}) => renderHook(() => usePlayer(length, options));

  it('starts at the first step, paused', () => {
    const { result } = setup();
    expect(result.current).toMatchObject({ index: 0, playing: false, atStart: true, atEnd: false });
  });

  it('steps forward and back, and stops at both ends', () => {
    const { result } = setup(2);
    act(() => result.current.stepBack());
    expect(result.current.index).toBe(0);
    act(() => result.current.stepForward());
    expect(result.current).toMatchObject({ index: 1, atEnd: true });
    act(() => result.current.stepForward());
    expect(result.current.index).toBe(1);
    act(() => result.current.stepBack());
    expect(result.current.index).toBe(0);
  });

  it('seeks to any step, and clamps out-of-range values', () => {
    const { result } = setup();
    act(() => result.current.seek(2));
    expect(result.current.index).toBe(2);
    act(() => result.current.seek(99));
    expect(result.current.index).toBe(3);
    act(() => result.current.seek(-5));
    expect(result.current.index).toBe(0);
  });

  it('plays through the trace and stops at the end', () => {
    const { result } = setup(3);
    act(() => result.current.togglePlay());
    expect(result.current.playing).toBe(true);
    act(() => void vi.advanceTimersByTime(1400));
    expect(result.current.index).toBe(1);
    act(() => void vi.advanceTimersByTime(1400));
    expect(result.current.index).toBe(2);
    act(() => void vi.advanceTimersByTime(0));
    expect(result.current.playing).toBe(false);
  });

  it('pauses', () => {
    const { result } = setup();
    act(() => result.current.togglePlay());
    act(() => result.current.togglePlay());
    act(() => void vi.advanceTimersByTime(10000));
    expect(result.current).toMatchObject({ index: 0, playing: false });
  });

  it('starts over when play is pressed at the end', () => {
    const { result } = setup(2);
    act(() => result.current.seek(1));
    act(() => result.current.togglePlay());
    expect(result.current).toMatchObject({ index: 0, playing: true });
  });

  it('stops playing when the student steps or seeks', () => {
    const { result } = setup();
    act(() => result.current.togglePlay());
    act(() => result.current.stepForward());
    expect(result.current.playing).toBe(false);
    act(() => result.current.togglePlay());
    act(() => result.current.seek(0));
    expect(result.current.playing).toBe(false);
  });

  it('runs faster at a higher speed', () => {
    const { result } = setup();
    act(() => result.current.setSpeed(2));
    act(() => result.current.togglePlay());
    act(() => void vi.advanceTimersByTime(700));
    expect(result.current.index).toBe(1);
  });

  it('multiplies by the animation speed from Settings', () => {
    const { result } = setup(4, { speedFactor: 2 });
    act(() => result.current.togglePlay());
    act(() => void vi.advanceTimersByTime(700));
    expect(result.current.index).toBe(1);
  });

  it('keeps speed within limits', () => {
    const { result } = setup();
    act(() => result.current.setSpeed(100));
    expect(result.current.speed).toBe(MAX_SPEED);
    act(() => result.current.setSpeed(0));
    expect(result.current.speed).toBe(MIN_SPEED);
  });

  it('reports use of the controls', () => {
    const onInteract = vi.fn();
    const { result } = setup(4, { onInteract });
    act(() => result.current.stepForward());
    act(() => result.current.stepBack());
    act(() => result.current.seek(1));
    act(() => result.current.togglePlay());
    expect(onInteract).toHaveBeenCalledTimes(4);
  });

  it('copes with an empty trace', () => {
    const { result } = setup(0);
    expect(result.current).toMatchObject({ index: 0, atEnd: true });
    act(() => result.current.stepForward());
    expect(result.current.index).toBe(0);
  });
});
