import { alphabetAtoms, atomIndexOf, representativeChar } from '../regex/charset';
import { NO_TRANSITION, type Dfa } from './types';

export type EquivalenceResult =
  | { equivalent: true }
  | {
      equivalent: false;
      /** The shortest string the two automata disagree on. */
      witness: string;
      acceptedBy: 'first' | 'second';
    };

/** Breadth-first search of the product automaton. Gives a shortest counterexample. */
export function dfaEquivalent(first: Dfa, second: Dfa): EquivalenceResult {
  const atoms = alphabetAtoms([...first.alphabet, ...second.alphabet]);
  const symbols = atoms.map(representativeChar);
  const firstAccepts = new Set(first.accepts);
  const secondAccepts = new Set(second.accepts);

  const stepOf = (dfa: Dfa, state: number, codePoint: number): number => {
    if (state === NO_TRANSITION) return NO_TRANSITION;
    const symbol = atomIndexOf(dfa.alphabet, codePoint);
    return symbol === -1 ? NO_TRANSITION : ((dfa.delta[state] as number[])[symbol] as number);
  };

  const queue: { a: number; b: number; path: string }[] = [
    { a: first.start, b: second.start, path: '' },
  ];
  const seen = new Set([`${first.start},${second.start}`]);

  for (let head = 0; head < queue.length; head++) {
    const { a, b, path } = queue[head] as (typeof queue)[number];
    const inFirst = firstAccepts.has(a);
    const inSecond = secondAccepts.has(b);
    if (inFirst !== inSecond) {
      return { equivalent: false, witness: path, acceptedBy: inFirst ? 'first' : 'second' };
    }
    for (const codePoint of symbols) {
      const nextA = stepOf(first, a, codePoint);
      const nextB = stepOf(second, b, codePoint);
      if (nextA === NO_TRANSITION && nextB === NO_TRANSITION) continue;
      const key = `${nextA},${nextB}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ a: nextA, b: nextB, path: path + String.fromCodePoint(codePoint) });
      }
    }
  }
  return { equivalent: true };
}
