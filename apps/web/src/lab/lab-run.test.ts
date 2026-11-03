import type { LabEvent } from '@compilerlab/shared';
import { describe, expect, it } from 'vitest';
import { INITIAL_RUN, labRunReducer, type LabRunState } from './lab-run';

function play(...events: LabEvent[]): LabRunState {
  return events.reduce<LabRunState>(
    (state, event) => labRunReducer(state, { type: 'event', event }),
    labRunReducer(INITIAL_RUN, { type: 'reset' }),
  );
}

const step = (id: string): LabEvent => ({ type: 'step', id, label: id, command: `${id} x` });

describe('labRunReducer', () => {
  it('starts each run clean', () => {
    const before = play({ type: 'done', outcome: 'ok', message: 'Finished.' });
    expect(before.status).toBe('finished');
    const after = labRunReducer(before, { type: 'reset' });
    expect(after).toEqual({ ...INITIAL_RUN, status: 'running' });
  });

  it('records which engine ran and why', () => {
    const state = play({ type: 'started', engine: 'simulated', pipeline: 'lex', note: 'no flex' });
    expect(state.engine).toBe('simulated');
    expect(state.note).toBe('no flex');
  });

  it('follows each step from start to finish', () => {
    const state = play(
      step('gcc'),
      { type: 'output', step: 'gcc', stream: 'stderr', data: 'warn' },
      { type: 'output', step: 'gcc', stream: 'stderr', data: 'ing' },
      {
        type: 'step-end',
        step: 'gcc',
        outcome: 'ok',
        exitCode: 0,
        durationMs: 12,
        message: null,
      },
    );
    expect(state.steps).toEqual([
      {
        id: 'gcc',
        label: 'gcc',
        command: 'gcc x',
        outcome: 'ok',
        exitCode: 0,
        durationMs: 12,
        message: null,
        output: 'warning',
      },
    ]);
    expect(state.programOutput).toEqual([]);
  });

  it('keeps program output in order, joining runs from the same stream', () => {
    const state = play(
      step('run'),
      { type: 'output', step: 'run', stream: 'stdout', data: 'a' },
      { type: 'output', step: 'run', stream: 'stdout', data: 'b' },
      { type: 'output', step: 'run', stream: 'stderr', data: 'c' },
      { type: 'output', step: 'run', stream: 'stdout', data: 'd' },
    );
    expect(state.programOutput).toEqual([
      { stream: 'stdout', text: 'ab' },
      { stream: 'stderr', text: 'c' },
      { stream: 'stdout', text: 'd' },
    ]);
  });

  it('holds on to diagnostics, generated files, tokens, the visual and the check', () => {
    const item = {
      file: 'a.c',
      line: 1,
      column: 2,
      severity: 'error' as const,
      tool: 'gcc',
      message: 'm',
      explanation: null,
    };
    const state = play(
      { type: 'diagnostics', items: [item] },
      { type: 'generated', files: [{ name: 'lex.yy.c', content: 'x', truncated: false }] },
      { type: 'tokens', matches: [{ ruleLine: 1, text: 'a' }], truncated: false, rules: [] },
      { type: 'visual', rules: 'A a', source: 'a', omitted: [] },
      { type: 'check', results: [], passed: true },
    );
    expect(state.diagnostics).toEqual([item]);
    expect(state.generated[0]?.name).toBe('lex.yy.c');
    expect(state.tokens?.matches).toHaveLength(1);
    expect(state.visual?.rules).toBe('A a');
    expect(state.check?.passed).toBe(true);
    expect(state.status).toBe('running');
  });

  it('finishes on done and on error', () => {
    expect(play({ type: 'done', outcome: 'timeout', message: 'Too slow.' })).toMatchObject({
      status: 'finished',
      done: { outcome: 'timeout', message: 'Too slow.' },
    });
    expect(
      play({ type: 'error', code: 'busy', message: 'No.', hint: 'Wait.', fix: ['x'] }),
    ).toMatchObject({
      status: 'finished',
      error: { code: 'busy', message: 'No.', hint: 'Wait.', fix: ['x'] },
    });
  });

  it('turns a lost connection during a run into an error', () => {
    const state = labRunReducer(play(step('run')), { type: 'disconnected' });
    expect(state.status).toBe('finished');
    expect(state.error?.code).toBe('disconnected');
    expect(state.error?.message).toContain('closed before this job finished');
  });

  it('ignores a closed connection after the run is over', () => {
    const finished = play({ type: 'done', outcome: 'ok', message: 'Finished.' });
    expect(labRunReducer(finished, { type: 'disconnected' })).toBe(finished);
    expect(labRunReducer(INITIAL_RUN, { type: 'disconnected' })).toBe(INITIAL_RUN);
  });
});
