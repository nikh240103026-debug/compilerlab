import { describe, expect, it, vi } from 'vitest';
import { runEngineJob } from './client';
import { runJob } from './jobs';

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Expected the job to succeed');
  return result.value;
}

describe('runJob', () => {
  it('builds the pipeline for a regex', () => {
    expect(value(runJob('thompson', { regex: '(a|b)*abb' })).nfa.stateCount).toBe(11);
    expect(value(runJob('subset', { regex: '(a|b)*abb' })).dfa.stateCount).toBe(5);
    expect(value(runJob('minimize', { regex: '(a|b)*abb' })).minimal.stateCount).toBe(4);
    expect(value(runJob('direct', { regex: '(a|b)*abb' })).dfa.stateCount).toBe(4);
  });

  it.each(['nfa', 'dfa', 'minimal'] as const)('runs input on the %s', (machine) => {
    const run = (text: string) => value(runJob('run', { regex: 'ab*', text, machine }));
    expect(run('abb').simulation.accepted).toBe(true);
    expect(run('ba').simulation.accepted).toBe(false);
  });

  it.each(['nfa', 'dfa', 'minimal'] as const)('builds a figure of the %s', (show) => {
    const figure = value(runJob('figure', { regex: 'ab', show }));
    expect(figure.nfa !== null || figure.dfa !== null).toBe(true);
  });

  it('runs a lexer from text', () => {
    const result = value(runJob('lexer', { spec: 'NUM [0-9]+\nWS \\s+ %skip', source: '1 22' }));
    expect(result.tokens.filter((token) => !token.skipped).map((t) => t.lexeme)).toEqual([
      '1',
      '22',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('runs the input buffer demo', () => {
    expect(value(runJob('inputBuffer', { text: 'if x', size: 4 })).lexemes).toEqual(['if', 'x']);
  });

  it('checks a student regex against a reference', () => {
    const check = (answer: string) => value(runJob('checkRegex', { answer, reference: 'a+' }));
    expect(check('aa*')).toEqual({ equivalent: true });
    expect(check('a*')).toMatchObject({ equivalent: false, witness: '', acceptedBy: 'first' });
  });

  it('simulates and compares an NFA built by hand', () => {
    const { nfa } = value(runJob('thompson', { regex: 'ab' }));
    expect(value(runJob('simulateBuilt', { nfa, text: 'ab' })).accepted).toBe(true);
    expect(value(runJob('compareBuilt', { nfa, regex: 'ab' }))).toEqual({ equivalent: true });
    expect(value(runJob('compareBuilt', { nfa, regex: 'a' })).equivalent).toBe(false);
  });

  it('returns a readable failure for bad input', () => {
    const result = runJob('thompson', { regex: '(' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unclosed_paren', position: 0 } });
  });

  it('returns a readable failure for a bug too', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = runJob('thompson', { regex: null as unknown as string });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    quiet.mockRestore();
  });
});

describe('runEngineJob', () => {
  it('runs in the page when Web Workers are not available', async () => {
    const result = await runEngineJob('thompson', { regex: 'a' });
    expect(value(result).nfa.stateCount).toBe(2);
  });
});
