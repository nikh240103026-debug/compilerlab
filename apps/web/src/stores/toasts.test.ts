import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToasts } from './toasts';

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });

  afterEach(() => vi.useRealTimers());

  it('adds a toast with the info tone by default', () => {
    toast({ title: 'Saved' });
    expect(useToasts.getState().toasts).toMatchObject([{ title: 'Saved', tone: 'info' }]);
  });

  it('dismisses normal toasts automatically', () => {
    toast({ title: 'Saved', tone: 'success' });
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('keeps errors until they are dismissed', () => {
    const id = toast({ title: 'Failed', tone: 'danger' });
    vi.advanceTimersByTime(60000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().toasts).toEqual([]);
  });
});
