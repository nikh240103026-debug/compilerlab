import type { CharSet } from '../regex/charset';

export interface NfaTransition {
  from: number;
  to: number;
  /** null is an epsilon move. */
  on: CharSet | null;
}

/** States are numbered 0 to stateCount - 1. */
export interface Nfa {
  stateCount: number;
  start: number;
  accepts: number[];
  transitions: NfaTransition[];
  /** For a lexer: which rule each accepting state belongs to. Lower index wins. */
  acceptRule?: Record<number, number>;
}

/** The target is NO_TRANSITION when the automaton has nowhere to go, meaning it rejects. */
export const NO_TRANSITION = -1;

export interface Dfa {
  stateCount: number;
  /** A, B, C... as in the textbook. */
  names: string[];
  start: number;
  accepts: number[];
  /** Groups of characters the automaton treats alike. Columns of the transition table. */
  alphabet: CharSet[];
  /** delta[state][atom index] is the target state or NO_TRANSITION. */
  delta: number[][];
  /** The NFA states, positions, or original DFA states each state stands for. */
  sources: number[][];
  /** For a lexer: the rule each state accepts, or null. */
  acceptRule?: (number | null)[];
}

/** Excel-style names: A to Z, then AA, AB... */
export function dfaStateName(index: number): string {
  let name = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    name = String.fromCharCode(65 + (n % 26)) + name;
  }
  return name;
}

export function formatStateSet(states: readonly (number | string)[]): string {
  return `{${states.join(', ')}}`;
}
