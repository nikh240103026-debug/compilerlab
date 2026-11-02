// Every route from a regex to an automaton must agree with the others, and with JavaScript's
// own regex engine, which shares no code with this one.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRegex } from '../regex/parser';
import { regexToDfaDirect } from './direct';
import { dfaEquivalent } from './equivalence';
import { minimizeDfa } from './minimize';
import { dfaAccepts, nfaAccepts, simulateDfa, simulateNfa } from './simulate';
import { subsetConstruct } from './subset';
import { thompson } from './thompson';
import { NO_TRANSITION, type Dfa } from './types';

/** Regexes over a small alphabet, written in syntax both this engine and JavaScript accept. */
const regexArbitrary: fc.Arbitrary<string> = fc.letrec<{ regex: string }>((tie) => ({
  regex: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.constantFrom('a', 'b', 'c', '[ab]', '[^a]'),
    fc.tuple(tie('regex'), tie('regex')).map(([x, y]) => `(${x}|${y})`),
    fc.tuple(tie('regex'), tie('regex')).map(([x, y]) => `(${x}${y})`),
    tie('regex').map((x) => `(${x})*`),
    tie('regex').map((x) => `(${x})+`),
    tie('regex').map((x) => `(${x})?`),
  ),
})).regex;

const inputArbitrary = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 8 })
  .map((chars) => chars.join(''));

const casesArbitrary = fc.tuple(
  regexArbitrary,
  fc.array(inputArbitrary, { minLength: 5, maxLength: 10 }),
);

const buildAll = (source: string) => {
  const ast = parseRegex(source);
  const nfa = thompson(ast, source).nfa;
  const subset = subsetConstruct(nfa, 4096).dfa;
  const minimal = minimizeDfa(subset).dfa;
  const direct = regexToDfaDirect(ast).dfa;
  return { nfa, subset, minimal, direct };
};

/** Moore's table-filling check: in a truly minimal DFA, no two states are equivalent. */
function countEquivalentPairs(dfa: Dfa): number {
  const asStart = (state: number): Dfa => ({ ...dfa, start: state });
  let pairs = 0;
  for (let a = 0; a < dfa.stateCount; a++) {
    for (let b = a + 1; b < dfa.stateCount; b++) {
      if (dfaEquivalent(asStart(a), asStart(b)).equivalent) pairs++;
    }
  }
  return pairs;
}

describe('property: every construction accepts the same language', () => {
  it('agrees with an independent regex engine on random inputs', () => {
    fc.assert(
      fc.property(casesArbitrary, ([source, inputs]) => {
        const oracle = new RegExp(`^(?:${source})$`, 'u');
        const { nfa, subset, minimal, direct } = buildAll(source);
        for (const input of inputs) {
          const expected = oracle.test(input);
          expect(nfaAccepts(nfa, input)).toBe(expected);
          expect(dfaAccepts(subset, input)).toBe(expected);
          expect(dfaAccepts(minimal, input)).toBe(expected);
          expect(dfaAccepts(direct, input)).toBe(expected);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('proves all routes equivalent, not just on sampled inputs', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        const { subset, minimal, direct } = buildAll(source);
        expect(dfaEquivalent(subset, minimal)).toEqual({ equivalent: true });
        expect(dfaEquivalent(subset, direct)).toEqual({ equivalent: true });
      }),
      { numRuns: 300 },
    );
  });

  it('gives the traced and untraced simulators the same answer', () => {
    fc.assert(
      fc.property(casesArbitrary, ([source, inputs]) => {
        const { nfa, subset } = buildAll(source);
        for (const input of inputs) {
          expect(simulateNfa(nfa, input).accepted).toBe(nfaAccepts(nfa, input));
          expect(simulateDfa(subset, input).accepted).toBe(dfaAccepts(subset, input));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: minimization', () => {
  it('leaves no two equivalent states', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        expect(countEquivalentPairs(buildAll(source).minimal)).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it('never adds states, and is idempotent', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        const { subset, minimal } = buildAll(source);
        expect(minimal.stateCount).toBeLessThanOrEqual(subset.stateCount);
        expect(minimizeDfa(minimal).dfa.stateCount).toBe(minimal.stateCount);
      }),
      { numRuns: 200 },
    );
  });

  it('reaches the same size from different starting automata, because minimal DFAs are unique', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        const { minimal, direct } = buildAll(source);
        expect(minimizeDfa(direct).dfa.stateCount).toBe(minimal.stateCount);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps no state that cannot reach acceptance, or be reached', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        const { minimal } = buildAll(source);
        const reached = new Set([minimal.start]);
        const pending = [minimal.start];
        for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
          for (const target of minimal.delta[state] as number[]) {
            if (target !== NO_TRANSITION && !reached.has(target)) {
              reached.add(target);
              pending.push(target);
            }
          }
        }
        expect(reached.size).toBe(minimal.stateCount);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: traces are valid', () => {
  it('never mutates a recorded step and always finishes', () => {
    fc.assert(
      fc.property(regexArbitrary, (source) => {
        const ast = parseRegex(source);
        const traces = [
          thompson(ast, source).trace,
          subsetConstruct(thompson(ast, source).nfa, 4096).trace,
          minimizeDfa(subsetConstruct(thompson(ast, source).nfa, 4096).dfa).trace,
          regexToDfaDirect(ast).trace,
        ];
        for (const trace of traces) {
          expect(trace.length).toBeGreaterThan(0);
          expect(trace.at(-1)?.title).toBe('Finished');
          for (const step of trace) {
            expect(Object.isFrozen(step)).toBe(true);
            expect(step.explanation).not.toMatch(/undefined|NaN|\[object/);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: the parser never crashes', () => {
  it('throws only readable errors on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (source) => {
        try {
          parseRegex(source);
        } catch (error) {
          expect((error as Error).name).toBe('EngineError');
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('handles strings made only of operators', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.constantFrom('(', ')', '[', ']', '|', '*', '+', '?', '\\', '"', '-', '^', 'a', '{'),
            {
              maxLength: 12,
            },
          )
          .map((chars) => chars.join('')),
        (source) => {
          try {
            const ast = parseRegex(source);
            // If it parses, every later stage must cope too.
            const nfa = thompson(ast, source).nfa;
            minimizeDfa(subsetConstruct(nfa).dfa);
            regexToDfaDirect(ast);
          } catch (error) {
            expect((error as Error).name).toBe('EngineError');
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});
