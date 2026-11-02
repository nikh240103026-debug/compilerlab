import { nfaAccepts } from '@compilerlab/engine';
import { describe, expect, it } from 'vitest';
import {
  A_OR_B,
  buildAutomaton,
  EMPTY_AUTOMATON,
  ENDS_IN_ABB,
  parseSymbol,
  splitLabel,
  type BuilderAutomaton,
} from './builder-model';

const state = (id: string, accepting = false) => ({ id, label: id, accepting, x: 0, y: 0 });

function build(automaton: BuilderAutomaton) {
  const result = buildAutomaton(automaton);
  if (!result.ok) throw new Error(result.problems.join(' '));
  return result;
}

describe('splitLabel', () => {
  it.each([
    ['a', ['a']],
    ['a, b', ['a', 'b']],
    ['a,b,ε', ['a', 'b', 'ε']],
    ['[a,b], c', ['[a,b]', 'c']],
    ['\\,, a', ['\\,', 'a']],
    ['', ['']],
  ])('splits %j', (label, parts) => {
    expect(splitLabel(label)).toEqual(parts);
  });
});

describe('parseSymbol', () => {
  it('reads epsilon in its forms', () => {
    expect(parseSymbol('ε')).toBeNull();
    expect(parseSymbol('eps')).toBeNull();
    expect(parseSymbol('')).toBeNull();
  });

  it('reads symbols and classes', () => {
    expect(parseSymbol('a')).toEqual([[0x61, 0x61]]);
    expect(parseSymbol('[0-9]')).toEqual([[0x30, 0x39]]);
  });

  it('rejects more than one symbol, with a hint', () => {
    expect(() => parseSymbol('ab')).toThrow(/more than one symbol/);
  });
});

describe('buildAutomaton', () => {
  it('asks for a state first', () => {
    expect(buildAutomaton(EMPTY_AUTOMATON)).toEqual({
      ok: false,
      problems: ['Add a state to get started.'],
    });
  });

  it('asks for a start state and an accepting state', () => {
    const result = buildAutomaton({ states: [state('a')], transitions: [], startId: null });
    expect(result).toEqual({
      ok: false,
      problems: ['Choose a start state.', 'Mark at least one state as accepting.'],
    });
  });

  it('names the edge with a bad label', () => {
    const result = buildAutomaton({
      startId: 'a',
      states: [state('a', true), state('b')],
      transitions: [{ id: '1', from: 'a', to: 'b', label: 'xy' }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems[0]).toContain('Edge from a to b');
  });

  it('recognizes a complete DFA', () => {
    const result = build(ENDS_IN_ABB);
    expect(result).toMatchObject({ kind: 'DFA', complete: true });
    expect(nfaAccepts(result.nfa, 'aabb')).toBe(true);
    expect(nfaAccepts(result.nfa, 'ab')).toBe(false);
  });

  it('recognizes a partial DFA', () => {
    const result = build({
      startId: 'a',
      states: [state('a'), state('b', true)],
      transitions: [{ id: '1', from: 'a', to: 'b', label: 'x' }],
    });
    expect(result).toMatchObject({ kind: 'DFA', complete: false });
  });

  it('recognizes an ε-NFA', () => {
    const result = build(A_OR_B);
    expect(result.kind).toBe('ε-NFA');
    expect(nfaAccepts(result.nfa, 'b')).toBe(true);
    expect(nfaAccepts(result.nfa, 'ab')).toBe(false);
  });

  it('recognizes an NFA by two edges on the same symbol', () => {
    const result = build({
      startId: 'a',
      states: [state('a'), state('b', true), state('c')],
      transitions: [
        { id: '1', from: 'a', to: 'b', label: 'x' },
        { id: '2', from: 'a', to: 'c', label: 'x' },
      ],
    });
    expect(result.kind).toBe('NFA');
  });

  it('counts overlapping classes as nondeterminism', () => {
    const result = build({
      startId: 'a',
      states: [state('a'), state('b', true)],
      transitions: [
        { id: '1', from: 'a', to: 'a', label: '[a-m]' },
        { id: '2', from: 'a', to: 'b', label: 'k' },
      ],
    });
    expect(result.kind).toBe('NFA');
  });

  it('accepts several symbols on one edge', () => {
    const result = build({
      startId: 'a',
      states: [state('a'), state('b', true)],
      transitions: [{ id: '1', from: 'a', to: 'b', label: 'x, y' }],
    });
    expect(nfaAccepts(result.nfa, 'y')).toBe(true);
    expect(result.nfa.transitions).toHaveLength(2);
  });

  it('ignores an edge whose state was deleted', () => {
    const result = build({
      startId: 'a',
      states: [state('a', true)],
      transitions: [{ id: '1', from: 'a', to: 'gone', label: 'x' }],
    });
    expect(result.nfa.transitions).toEqual([]);
  });
});
