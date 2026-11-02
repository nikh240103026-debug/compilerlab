import { TraceRecorder, type Trace } from '../core/trace';
import { atomIndexOf, formatChar } from '../regex/charset';
import { epsilonClosure, indexNfa, moveOn } from './subset';
import { formatStateSet, NO_TRANSITION, type Dfa, type Nfa } from './types';

export type SimulationStatus = 'running' | 'accepted' | 'rejected';

export interface SimulationState {
  /** The input, one code point per entry, so a tape can be drawn. */
  input: string[];
  /** How many characters have been read. */
  position: number;
  /** Current state or states. For a DFA that has fallen off, this is empty. */
  active: number[];
  status: SimulationStatus;
}

export interface SimulationResult {
  accepted: boolean;
  trace: Trace<SimulationState>;
}

function codePoints(input: string): string[] {
  return [...input];
}

const pointOf = (char: string) => char.codePointAt(0) as number;

const quoted = (input: readonly string[]) =>
  input.length === 0 ? 'the empty string' : `"${input.join('')}"`;

/** One current state at a time. A missing transition means immediate rejection. */
export function simulateDfa(dfa: Dfa, inputText: string): SimulationResult {
  const input = codePoints(inputText);
  const recorder = new TraceRecorder<SimulationState>();
  const accepts = new Set(dfa.accepts);
  const name = (state: number) => dfa.names[state] as string;

  let state = dfa.start;
  recorder.add('Start', `Begin in the start state ${name(state)}.`, {
    input,
    position: 0,
    active: [state],
    status: 'running',
  });

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    const symbol = atomIndexOf(dfa.alphabet, pointOf(char));
    const target = symbol === -1 ? NO_TRANSITION : (dfa.delta[state] as number[])[symbol];
    const shown = formatChar(pointOf(char));
    if (target === undefined || target === NO_TRANSITION) {
      recorder.add(
        `Stuck on ${shown}`,
        `State ${name(state)} has no move on ${shown}, so the DFA stops. ${quoted(input)} is rejected.`,
        { input, position: i, active: [], status: 'rejected' },
      );
      return { accepted: false, trace: recorder.finish() };
    }
    recorder.add(
      `Read ${shown}`,
      `From ${name(state)}, reading ${shown} leads to exactly one state: ${name(target)}.`,
      { input, position: i + 1, active: [target], status: 'running' },
    );
    state = target;
  }

  const accepted = accepts.has(state);
  recorder.add(
    accepted ? 'Accepted' : 'Rejected',
    `The input is used up in state ${name(state)}, which ${accepted ? 'is accepting, so' : 'is not accepting, so'} ${quoted(input)} is ${accepted ? 'accepted' : 'rejected'}.`,
    { input, position: input.length, active: [state], status: accepted ? 'accepted' : 'rejected' },
  );
  return { accepted, trace: recorder.finish() };
}

/** A set of current states at a time, following every possibility at once. */
export function simulateNfa(nfa: Nfa, inputText: string): SimulationResult {
  const input = codePoints(inputText);
  const recorder = new TraceRecorder<SimulationState>();
  const accepts = new Set(nfa.accepts);
  const index = indexNfa(nfa);

  let active = epsilonClosure(index, [nfa.start]);
  recorder.add(
    'Start',
    `Begin in the start state, plus every state reachable by ε-edges: ${formatStateSet(active)}.`,
    { input, position: 0, active, status: 'running' },
  );

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    const moved = moveOn(index, active, pointOf(char));
    const shown = formatChar(pointOf(char));
    if (moved.length === 0) {
      recorder.add(
        `Stuck on ${shown}`,
        `None of the states in ${formatStateSet(active)} has a move on ${shown}, so every possibility has died. ${quoted(input)} is rejected.`,
        { input, position: i, active: [], status: 'rejected' },
      );
      return { accepted: false, trace: recorder.finish() };
    }
    const next = epsilonClosure(index, moved);
    recorder.add(
      `Read ${shown}`,
      `Reading ${shown} moves ${formatStateSet(active)} to ${formatStateSet(moved)}. Following ε-edges from there gives ${formatStateSet(next)}.`,
      { input, position: i + 1, active: next, status: 'running' },
    );
    active = next;
  }

  const accepted = active.some((state) => accepts.has(state));
  recorder.add(
    accepted ? 'Accepted' : 'Rejected',
    `The input is used up in ${formatStateSet(active)}. ${accepted ? 'That set contains an accepting state' : 'That set has no accepting state'}, so ${quoted(input)} is ${accepted ? 'accepted' : 'rejected'}.`,
    { input, position: input.length, active, status: accepted ? 'accepted' : 'rejected' },
  );
  return { accepted, trace: recorder.finish() };
}

/** The same answer as simulateDfa, without building a trace. */
export function dfaAccepts(dfa: Dfa, input: string): boolean {
  let state = dfa.start;
  for (const char of input) {
    const symbol = atomIndexOf(dfa.alphabet, pointOf(char));
    if (symbol === -1) return false;
    const target = (dfa.delta[state] as number[])[symbol] as number;
    if (target === NO_TRANSITION) return false;
    state = target;
  }
  return dfa.accepts.includes(state);
}

/** The same answer as simulateNfa, without building a trace. */
export function nfaAccepts(nfa: Nfa, input: string): boolean {
  const index = indexNfa(nfa);
  let active = epsilonClosure(index, [nfa.start]);
  for (const char of input) {
    active = epsilonClosure(index, moveOn(index, active, pointOf(char)));
    if (active.length === 0) return false;
  }
  return active.some((state) => nfa.accepts.includes(state));
}
