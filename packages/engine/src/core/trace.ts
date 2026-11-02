import { EngineError } from './result';

/** One frame of an algorithm's run. Every visualizer is driven by an array of these. */
export interface TraceStep<S> {
  readonly title: string;
  /** Says in plain language what happened in this step and why. */
  readonly explanation: string;
  readonly state: S;
}

export type Trace<S> = readonly TraceStep<S>[];

/** Skips objects that are already frozen, so shared, unchanged parts of snapshots stay cheap. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Collects immutable snapshots. Freezing also means an algorithm that mutates something it
 * already recorded throws in a test, instead of quietly changing an earlier frame.
 */
export class TraceRecorder<S> {
  private readonly steps: TraceStep<S>[] = [];

  constructor(private readonly maxSteps = 20_000) {}

  add(title: string, explanation: string, state: S): void {
    if (this.steps.length >= this.maxSteps) {
      throw new EngineError({
        code: 'trace_too_long',
        message: 'This input needs too many steps to animate.',
        hint: 'Try a shorter input.',
      });
    }
    this.steps.push(deepFreeze({ title, explanation, state }));
  }

  finish(): Trace<S> {
    return Object.freeze(this.steps.slice());
  }
}
