// Fixtures from Aho, Lam, Sethi and Ullman, "Compilers: Principles, Techniques, and Tools",
// 2nd edition. The running example is (a|b)*abb, in sections 3.7 and 3.9.
import { describe, expect, it } from 'vitest';
import { formatCharSet } from '../regex/charset';
import { parseRegex } from '../regex/parser';
import { regexToDfaDirect } from './direct';
import { dfaEquivalent } from './equivalence';
import { DEAD_STATE_NAME, minimizeDfa } from './minimize';
import { dfaAccepts, nfaAccepts, simulateDfa, simulateNfa } from './simulate';
import { epsilonClosure, indexNfa, moveOn, subsetConstruct } from './subset';
import {
  isPrimedState,
  PRIMED_STATE_OFFSET,
  stateKeyLabel,
  thompson,
  type ThompsonState,
} from './thompson';
import { dfaStateName, formatStateSet, NO_TRANSITION, type Dfa, type Nfa } from './types';

const SOURCE = '(a|b)*abb';
const buildNfa = (source: string) => thompson(parseRegex(source), source);
const nfa = buildNfa(SOURCE).nfa;

function edge({ from, to, on }: Nfa['transitions'][number]): string {
  return `${from}-${on ? formatCharSet(on) : 'ε'}->${to}`;
}

/** The table as { A: { a: 'B', b: 'C' } }, which reads like the book's figures. */
function tableOf(dfa: Dfa): Record<string, Record<string, string | null>> {
  const labels = dfa.alphabet.map(formatCharSet);
  return Object.fromEntries(
    dfa.names.map((name, state) => [
      name,
      Object.fromEntries(
        labels.map((label, symbol) => {
          const target = (dfa.delta[state] as number[])[symbol] as number;
          return [label, target === NO_TRANSITION ? null : (dfa.names[target] as string)];
        }),
      ),
    ]),
  );
}

describe('Thompson construction (Fig. 3.34)', () => {
  it('builds the 11-state NFA for (a|b)*abb, numbered as in the book', () => {
    expect(nfa.stateCount).toBe(11);
    expect(nfa.start).toBe(0);
    expect(nfa.accepts).toEqual([10]);
    expect(nfa.transitions.map(edge).toSorted()).toEqual(
      [
        '0-ε->1',
        '0-ε->7',
        '1-ε->2',
        '1-ε->4',
        '2-a->3',
        '4-b->5',
        '3-ε->6',
        '5-ε->6',
        '6-ε->1',
        '6-ε->7',
        '7-a->8',
        '8-b->9',
        '9-b->10',
      ].toSorted(),
    );
  });

  it.each([
    ['a', 2],
    ['ab', 3],
    ['a|b', 6],
    ['a*', 4],
    ['(a|b)*', 8],
    ['a+', 4],
    ['a?', 4],
    ['ε', 2],
  ])('builds %s with %i states', (source, count) => {
    expect(buildNfa(source).nfa.stateCount).toBe(count);
  });

  it.each(['a', 'ab', 'a|b', 'a*', '(a|b)*abb', 'a+b?', '((a|b)c)*|d', '(a?b+)*c'])(
    'keeps the construction guarantees for %s',
    (source) => {
      const { nfa: built } = buildNfa(source);
      const incoming = built.transitions.filter(({ to }) => to === built.start);
      const outgoing = built.transitions.filter(({ from }) => from === built.accepts[0]);
      expect(built.accepts).toHaveLength(1);
      expect(incoming).toEqual([]);
      expect(outgoing).toEqual([]);
      for (let state = 0; state < built.stateCount; state++) {
        const out = built.transitions.filter(({ from }) => from === state);
        // Each state has one labeled edge out, or at most two ε-edges (p. 161).
        expect(out.length).toBeLessThanOrEqual(2);
        if (out.some(({ on }) => on)) expect(out).toHaveLength(1);
      }
    },
  );

  it('has at most twice as many states as operators and operands', () => {
    // Five operands and five operators (|, *, and three concatenations).
    expect(nfa.stateCount).toBeLessThanOrEqual(2 * (5 + 5));
  });

  describe('trace', () => {
    const { trace } = buildNfa(SOURCE);

    it('builds subexpressions before the operators that use them', () => {
      const rules = trace.map((step) => step.state.rule);
      expect(rules.slice(0, 5)).toEqual(['symbol', 'symbol', 'union', 'star', 'symbol']);
      expect(rules.at(-1)).toBe('done');
    });

    it('explains every step in words and points at the source', () => {
      for (const step of trace) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.explanation.length).toBeGreaterThan(20);
        expect(step.state.span.end).toBeGreaterThan(step.state.span.start);
      }
    });

    it('ends with exactly the finished NFA', () => {
      const last = trace.at(-1)?.state as ThompsonState;
      expect(last.states.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 11 }, (_, i) => i),
      );
      expect(last.transitions.map(edge).toSorted()).toEqual(nfa.transitions.map(edge).toSorted());
    });

    it('shows a waiting copy of a state until the concatenation merges it', () => {
      const beforeMerge = trace.find(
        (step) => step.state.rule === 'symbol' && step.state.states.some(isPrimedState),
      );
      expect(beforeMerge?.state.states).toContain(7 + PRIMED_STATE_OFFSET);
      expect(stateKeyLabel(7 + PRIMED_STATE_OFFSET)).toBe('7′');
      expect(stateKeyLabel(7)).toBe('7');
      const merged = trace.at(-1)?.state as ThompsonState;
      expect(merged.states.some(isPrimedState)).toBe(false);
    });

    it('marks what each step added', () => {
      const union = trace.find((step) => step.state.rule === 'union')?.state as ThompsonState;
      expect(union.newStates).toHaveLength(2);
      expect(union.newTransitions).toHaveLength(4);
      for (const i of union.newTransitions) expect(union.transitions[i]?.on).toBeNull();
    });
  });
});

describe('epsilon closure and move (section 3.7.1)', () => {
  const index = indexNfa(nfa);

  it('computes ε-closure(0) as in Example 3.21', () => {
    expect(epsilonClosure(index, [0])).toEqual([0, 1, 2, 4, 7]);
  });

  it('computes move(A, a) as in Example 3.21', () => {
    expect(moveOn(index, [0, 1, 2, 4, 7], 0x61)).toEqual([3, 8]);
  });
});

describe('subset construction (Fig. 3.35)', () => {
  const { dfa, trace } = subsetConstruct(nfa);

  it('finds the five DFA states and their NFA sets', () => {
    expect(dfa.names).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(dfa.sources).toEqual([
      [0, 1, 2, 4, 7],
      [1, 2, 3, 4, 6, 7, 8],
      [1, 2, 4, 5, 6, 7],
      [1, 2, 4, 5, 6, 7, 9],
      [1, 2, 4, 5, 6, 7, 10],
    ]);
  });

  it('fills in the transition table', () => {
    expect(tableOf(dfa)).toEqual({
      A: { a: 'B', b: 'C' },
      B: { a: 'B', b: 'D' },
      C: { a: 'B', b: 'C' },
      D: { a: 'B', b: 'E' },
      E: { a: 'B', b: 'C' },
    });
  });

  it('accepts only in E, the state holding NFA state 10', () => {
    expect(dfa.accepts).toEqual([4]);
  });

  it('records one step per table cell, plus start and finish', () => {
    expect(trace).toHaveLength(5 * 2 + 2);
    const last = trace.at(-1)?.state;
    expect(last?.rows.every((row) => row.marked)).toBe(true);
    expect(last?.rows.flatMap((row) => row.cells)).not.toContain(null);
  });

  it('shows the table growing one cell at a time', () => {
    const second = trace[1]?.state;
    expect(second?.currentRow).toBe(0);
    expect(second?.moveSet).toEqual([3, 8]);
    expect(second?.closureSet).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(second?.rows[0]?.cells).toEqual([1, null]);
    expect(trace[0]?.state.rows).toHaveLength(1);
  });

  it('leaves a cell empty when there is no move', () => {
    const { dfa: partial } = subsetConstruct(buildNfa('ab').nfa);
    expect(tableOf(partial).A).toEqual({ a: 'B', b: null });
  });

  it('refuses to grow past the limit, with a readable error', () => {
    // The textbook's exponential case: "the 4th symbol from the end is a". The minimal DFA needs
    // 2^4 states. Subset construction gives one more, because its start set includes state 0.
    const { nfa: big } = buildNfa('(a|b)*a(a|b)(a|b)(a|b)');
    const { dfa: built } = subsetConstruct(big);
    expect(built.stateCount).toBe(17);
    expect(minimizeDfa(built).dfa.stateCount).toBe(16);
    expect(() => subsetConstruct(big, 8)).toThrow(/more than 8 states/);
  });

  it('names states past Z like a spreadsheet', () => {
    expect([0, 25, 26, 27, 52].map(dfaStateName)).toEqual(['A', 'Z', 'AA', 'AB', 'BA']);
  });

  it('formats a set of states', () => {
    expect(formatStateSet([1, 2])).toBe('{1, 2}');
  });
});

describe('Hopcroft minimization (Example 3.40, Fig. 3.36)', () => {
  const { dfa } = subsetConstruct(nfa);
  const { dfa: minimal, trace } = minimizeDfa(dfa);

  it('merges A and C, leaving four states', () => {
    expect(minimal.stateCount).toBe(4);
    expect(minimal.names).toEqual(['A,C', 'B', 'D', 'E']);
  });

  it('builds the minimal transition table', () => {
    expect(tableOf(minimal)).toEqual({
      'A,C': { a: 'B', b: 'A,C' },
      B: { a: 'B', b: 'D' },
      D: { a: 'B', b: 'E' },
      E: { a: 'B', b: 'A,C' },
    });
    expect(minimal.accepts).toEqual([3]);
  });

  it('accepts the same language', () => {
    expect(dfaEquivalent(dfa, minimal)).toEqual({ equivalent: true });
  });

  it('starts from accepting vs non-accepting, and ends with the final partition', () => {
    const blocks = (i: number) => trace.at(i)?.state.blocks.map(({ states }) => states.join(','));
    expect(blocks(0)).toEqual(['0,1,2,3', '4']);
    expect(blocks(-1)).toEqual(['0,2', '1', '3', '4']);
    expect(trace.at(-1)?.state.done).toBe(true);
  });

  it('keeps block ids stable, so a block keeps its color when it splits', () => {
    const firstIds = trace[0]?.state.blocks.map((block) => block.id);
    const lastIds = trace.at(-1)?.state.blocks.map((block) => block.id);
    for (const id of firstIds ?? []) expect(lastIds).toContain(id);
  });

  it('reports each split it makes', () => {
    const splits = trace.flatMap((step) => step.state.splits);
    expect(splits).toHaveLength(2);
  });

  it('leaves an already minimal DFA alone', () => {
    const again = minimizeDfa(minimal);
    expect(again.dfa.stateCount).toBe(4);
    expect(again.trace.at(-1)?.explanation).toContain('already minimal');
  });

  it('adds a dead state for missing moves, and removes it afterward', () => {
    const { dfa: partial } = subsetConstruct(buildNfa('ab').nfa);
    const result = minimizeDfa(partial);
    expect(result.trace[0]?.state.names).toContain(DEAD_STATE_NAME);
    expect(result.trace[0]?.explanation).toContain('dead state');
    expect(result.dfa.names).not.toContain(DEAD_STATE_NAME);
    expect(result.dfa.stateCount).toBe(3);
  });

  it('drops unreachable states', () => {
    const withExtra: Dfa = {
      stateCount: 3,
      names: ['A', 'B', 'X'],
      start: 0,
      accepts: [1],
      alphabet: dfa.alphabet.slice(0, 1),
      delta: [[1], [1], [0]],
      sources: [[], [], []],
    };
    const result = minimizeDfa(withExtra);
    expect(result.dfa.names).not.toContain('X');
    expect(result.trace[0]?.explanation).toContain('Drop X');
  });

  it('drops an explicit trap state, which can never accept', () => {
    const withTrap: Dfa = {
      stateCount: 3,
      names: ['A', 'B', 'T'],
      start: 0,
      accepts: [1],
      alphabet: dfa.alphabet,
      delta: [
        [1, 2],
        [2, 2],
        [2, 2],
      ],
      sources: [[], [], []],
    };
    const result = minimizeDfa(withTrap);
    expect(result.dfa.names).toEqual(['A', 'B']);
    expect(tableOf(result.dfa).B).toEqual({ a: null, b: null });
  });

  it('handles an automaton that accepts nothing', () => {
    const empty: Dfa = {
      stateCount: 2,
      names: ['A', 'B'],
      start: 0,
      accepts: [],
      alphabet: dfa.alphabet.slice(0, 1),
      delta: [[1], [0]],
      sources: [[], []],
    };
    const result = minimizeDfa(empty);
    expect(result.dfa.stateCount).toBe(1);
    expect(result.dfa.accepts).toEqual([]);
    expect(result.dfa.delta).toEqual([[NO_TRANSITION]]);
  });

  it('handles an automaton where every state accepts', () => {
    const all: Dfa = {
      stateCount: 2,
      names: ['A', 'B'],
      start: 0,
      accepts: [0, 1],
      alphabet: dfa.alphabet.slice(0, 1),
      delta: [[1], [0]],
      sources: [[], []],
    };
    expect(minimizeDfa(all).dfa.stateCount).toBe(1);
  });
});

describe('direct method with followpos (Example 3.34, Figs. 3.59 to 3.63)', () => {
  const { dfa, trace } = regexToDfaDirect(parseRegex(SOURCE));
  const last = trace.at(-1)?.state;

  it('numbers the positions, with # last', () => {
    expect(last?.positionLabels.slice(1)).toEqual(['a', 'b', 'a', 'b', 'b', '#']);
  });

  it('computes firstpos and lastpos of the root (Fig. 3.60)', () => {
    const root = last?.nodes[last.root];
    expect(root?.firstpos).toEqual([1, 2, 3]);
    expect(root?.lastpos).toEqual([6]);
    expect(root?.nullable).toBe(false);
  });

  it('computes the followpos table (Fig. 3.61)', () => {
    expect(last?.followpos.slice(1)).toEqual([[1, 2, 3], [1, 2, 3], [4], [5], [6], []]);
  });

  it('builds the four-state DFA (Fig. 3.63)', () => {
    expect(dfa.sources).toEqual([
      [1, 2, 3],
      [1, 2, 3, 4],
      [1, 2, 3, 5],
      [1, 2, 3, 6],
    ]);
    expect(tableOf(dfa)).toEqual({
      A: { a: 'B', b: 'A' },
      B: { a: 'B', b: 'C' },
      C: { a: 'B', b: 'D' },
      D: { a: 'B', b: 'A' },
    });
    expect(dfa.accepts).toEqual([3]);
  });

  it('matches the minimal DFA from the other route', () => {
    const viaNfa = minimizeDfa(subsetConstruct(nfa).dfa).dfa;
    expect(dfaEquivalent(dfa, viaNfa)).toEqual({ equivalent: true });
    expect(dfa.stateCount).toBe(viaNfa.stateCount);
  });

  it('moves through its phases in order', () => {
    const phases = trace.map((step) => step.state.phase);
    expect(phases[0]).toBe('annotate');
    expect(phases.indexOf('followpos')).toBeGreaterThan(phases.lastIndexOf('annotate'));
    expect(phases.indexOf('dstates')).toBeGreaterThan(phases.lastIndexOf('followpos'));
    expect(phases.at(-1)).toBe('done');
  });

  it.each([
    ['a|ε', '', true],
    ['a|ε', 'a', true],
    ['a|ε', 'b', false],
    ['a+', '', false],
    ['a+', 'aaa', true],
    ['a?b', 'b', true],
    ['a?b', 'aab', false],
    ['ε', '', true],
    ['\\ε', 'ε', true],
    ['\\ε', '', false],
    ['(a*|b)c', 'aac', true],
    ['a*b*', 'ba', false],
  ])('handles every operator: %s on %j is %s', (source, input, expected) => {
    expect(dfaAccepts(regexToDfaDirect(parseRegex(source)).dfa, input)).toBe(expected);
  });

  it('computes a nullable right child of a cat node', () => {
    const state = regexToDfaDirect(parseRegex('ab*')).trace.at(-1)?.state;
    const cat = state?.nodes.find((node) => node.label === 'cat' && node.children.length === 2);
    expect(cat?.lastpos).toEqual([1, 2]);
  });
});

describe('simulation (Algorithm 3.18 and Algorithm 3.22)', () => {
  const { dfa } = subsetConstruct(nfa);

  it.each([
    ['abb', true],
    ['aabb', true],
    ['babb', true],
    ['abababb', true],
    ['', false],
    ['ab', false],
    ['abba', false],
    ['abc', false],
  ])('classifies %j as %s with both machines', (input, accepted) => {
    expect(simulateNfa(nfa, input).accepted).toBe(accepted);
    expect(simulateDfa(dfa, input).accepted).toBe(accepted);
    expect(nfaAccepts(nfa, input)).toBe(accepted);
    expect(dfaAccepts(dfa, input)).toBe(accepted);
  });

  it('follows the path A, B, D, E on abb (Example 3.19)', () => {
    const { trace } = simulateDfa(dfa, 'abb');
    expect(trace.map((step) => step.state.active[0])).toEqual([0, 1, 3, 4, 4]);
    expect(trace.at(-1)?.state.status).toBe('accepted');
  });

  it('tracks a set of states in the NFA', () => {
    const { trace } = simulateNfa(nfa, 'a');
    expect(trace[0]?.state.active).toEqual([0, 1, 2, 4, 7]);
    expect(trace[1]?.state.active).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });

  it('stops at the first character with no move', () => {
    const dfaRun = simulateDfa(dfa, 'axb');
    expect(dfaRun.accepted).toBe(false);
    expect(dfaRun.trace.at(-1)?.state.position).toBe(1);
    expect(dfaRun.trace.at(-1)?.title).toContain('Stuck');
    const nfaRun = simulateNfa(nfa, 'axb');
    expect(nfaRun.trace.at(-1)?.state.status).toBe('rejected');
    expect(nfaRun.trace.at(-1)?.state.active).toEqual([]);
  });

  it('explains accepting and rejecting differently', () => {
    expect(simulateDfa(dfa, 'abb').trace.at(-1)?.explanation).toContain('accepted');
    expect(simulateDfa(dfa, '').trace.at(-1)?.explanation).toContain('empty string');
    expect(simulateNfa(nfa, 'ab').trace.at(-1)?.title).toBe('Rejected');
  });

  it('stops on a state with no edge for a known character', () => {
    const { dfa: small } = subsetConstruct(buildNfa('ab').nfa);
    expect(dfaAccepts(small, 'aa')).toBe(false);
    expect(simulateDfa(small, 'aa').accepted).toBe(false);
    expect(dfaAccepts(small, 'x')).toBe(false);
    expect(nfaAccepts(buildNfa('ab').nfa, 'x')).toBe(false);
  });
});

describe('dfaEquivalent', () => {
  const dfaFor = (source: string) => subsetConstruct(buildNfa(source).nfa).dfa;

  it.each([
    ['(a|b)*', '(a*b*)*'],
    ['a(ba)*', '(ab)*a'],
    ['a|a', 'a'],
    ['a+', 'aa*'],
    ['a?', 'a|ε'],
    ['[ab]', 'a|b'],
  ])('recognizes that %s and %s are the same language', (first, second) => {
    expect(dfaEquivalent(dfaFor(first), dfaFor(second))).toEqual({ equivalent: true });
  });

  it('gives the shortest counterexample', () => {
    expect(dfaEquivalent(dfaFor('a*'), dfaFor('a+'))).toEqual({
      equivalent: false,
      witness: '',
      acceptedBy: 'first',
    });
    expect(dfaEquivalent(dfaFor('a'), dfaFor('aa|a'))).toEqual({
      equivalent: false,
      witness: 'aa',
      acceptedBy: 'second',
    });
  });

  it('gives a readable counterexample for large classes', () => {
    const result = dfaEquivalent(dfaFor('[^x]'), dfaFor('[a-z]'));
    expect(result).toMatchObject({ equivalent: false, witness: '0', acceptedBy: 'first' });
  });

  it('notices when one automaton can run on and the other cannot', () => {
    expect(dfaEquivalent(dfaFor('ab'), dfaFor('a(b|c)'))).toMatchObject({
      equivalent: false,
      witness: 'ac',
      acceptedBy: 'second',
    });
  });
});
