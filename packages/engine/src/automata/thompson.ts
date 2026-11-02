import { TraceRecorder, type Trace } from '../core/trace';
import { formatCharSet } from '../regex/charset';
import type { RegexNode, Span } from '../regex/parser';
import type { Nfa, NfaTransition } from './types';

/**
 * A fragment's start state waits under a separate key until the concatenation that merges it
 * has happened. Add this to a state number to get that key.
 */
export const PRIMED_STATE_OFFSET = 1_000_000;

export function isPrimedState(key: number): boolean {
  return key >= PRIMED_STATE_OFFSET;
}

export function stateKeyLabel(key: number): string {
  return isPrimedState(key) ? `${key - PRIMED_STATE_OFFSET}′` : String(key);
}

export type ThompsonRule = 'symbol' | 'epsilon' | 'union' | 'concat' | 'star' | 'plus' | 'optional';

export interface ThompsonState {
  rule: ThompsonRule | 'done';
  /** The part of the expression this step handles. */
  span: Span;
  states: number[];
  transitions: NfaTransition[];
  /** Indexes into transitions added by this step. */
  newTransitions: number[];
  newStates: number[];
  /** The fragment this step produced. */
  start: number;
  accept: number;
}

export interface ThompsonResult {
  nfa: Nfa;
  trace: Trace<ThompsonState>;
}

interface Fragment {
  start: number;
  accept: number;
}

/**
 * Picks every state's number before building anything, so numbers never change during the
 * animation. A node's start is numbered before its children and its accept after them, which
 * reproduces the Dragon Book's numbering of (a|b)*abb exactly: 0 to 10.
 */
function assignStateNumbers(root: RegexNode): Map<RegexNode, Fragment> {
  const fragments = new Map<RegexNode, Fragment>();
  let next = 0;
  const visit = (node: RegexNode, inheritedStart: number | null): Fragment => {
    const start = (): number => inheritedStart ?? next++;
    let fragment: Fragment;
    switch (node.type) {
      case 'empty':
      case 'charset': {
        const first = start();
        fragment = { start: first, accept: next++ };
        break;
      }
      case 'concat': {
        const left = visit(node.left, inheritedStart);
        const right = visit(node.right, left.accept);
        fragment = { start: left.start, accept: right.accept };
        break;
      }
      case 'union': {
        const first = start();
        visit(node.left, null);
        visit(node.right, null);
        fragment = { start: first, accept: next++ };
        break;
      }
      case 'star':
      case 'plus':
      case 'optional': {
        const first = start();
        visit(node.child, null);
        fragment = { start: first, accept: next++ };
        break;
      }
    }
    fragments.set(node, fragment);
    return fragment;
  };
  visit(root, null);
  return fragments;
}

/** Thompson's construction, with one trace step for each rule applied. */
export function thompson(root: RegexNode, source = ''): ThompsonResult {
  const numbers = assignStateNumbers(root);
  const recorder = new TraceRecorder<ThompsonState>();
  let states: number[] = [];
  let transitions: NfaTransition[] = [];

  const quote = (span: Span) => (source ? `"${source.slice(span.start, span.end)}"` : 'this part');

  const record = (
    rule: ThompsonRule,
    span: Span,
    fragment: Fragment,
    newStates: number[],
    newTransitionCount: number,
    title: string,
    explanation: string,
  ) => {
    recorder.add(title, explanation, {
      rule,
      span,
      states: states.slice(),
      transitions: transitions.slice(),
      newStates,
      newTransitions: Array.from(
        { length: newTransitionCount },
        (_, i) => transitions.length - newTransitionCount + i,
      ),
      start: fragment.start,
      accept: fragment.accept,
    });
  };

  const addEdge = (from: number, to: number, on: NfaTransition['on']) => {
    transitions.push(Object.freeze({ from, to, on }));
  };

  const wrap = (node: RegexNode, startKey: number): Fragment => {
    const { accept } = numbers.get(node) as Fragment;
    return { start: startKey, accept };
  };

  const build = (node: RegexNode, startKey: number): Fragment => {
    const fragment = wrap(node, startKey);
    const { start, accept } = fragment;
    const startLabel = stateKeyLabel(start);
    switch (node.type) {
      case 'empty': {
        states = [...states, start, accept];
        addEdge(start, accept, null);
        record(
          'epsilon',
          node.span,
          fragment,
          [start, accept],
          1,
          'Empty string',
          `ε matches the empty string, so make a start state ${startLabel}, an accepting state ${accept}, and an ε-edge between them. The machine can cross it without reading anything.`,
        );
        break;
      }
      case 'charset': {
        states = [...states, start, accept];
        addEdge(start, accept, node.set);
        record(
          'symbol',
          node.span,
          fragment,
          [start, accept],
          1,
          `Symbol ${formatCharSet(node.set)}`,
          `The base case. To match ${formatCharSet(node.set)}, make a start state ${startLabel}, an accepting state ${accept}, and one edge labeled ${formatCharSet(node.set)} between them.`,
        );
        break;
      }
      case 'concat': {
        const left = build(node.left, startKey);
        const primed = left.accept + PRIMED_STATE_OFFSET;
        build(node.right, primed);
        // Glue the fragments: edges of the waiting copy of the state move to the real one.
        states = states.filter((state) => state !== primed);
        transitions = transitions.map((transition) =>
          transition.from === primed || transition.to === primed
            ? Object.freeze({
                ...transition,
                from: transition.from === primed ? left.accept : transition.from,
                to: transition.to === primed ? left.accept : transition.to,
              })
            : transition,
        );
        record(
          'concat',
          node.span,
          fragment,
          [left.accept],
          0,
          'Concatenation',
          `To match ${quote(node.left.span)} followed by ${quote(node.right.span)}, merge the end of the first machine with the start of the second. State ${left.accept} is now both, so finishing the first machine puts you exactly where the second begins.`,
        );
        break;
      }
      case 'union': {
        const { start: leftStart, accept: leftAccept } = numbers.get(node.left) as Fragment;
        const { start: rightStart, accept: rightAccept } = numbers.get(node.right) as Fragment;
        build(node.left, leftStart);
        build(node.right, rightStart);
        states = [...states, start, accept];
        addEdge(start, leftStart, null);
        addEdge(start, rightStart, null);
        addEdge(leftAccept, accept, null);
        addEdge(rightAccept, accept, null);
        record(
          'union',
          node.span,
          fragment,
          [start, accept],
          4,
          'Union',
          `To match either side, add a new start state ${startLabel} with ε-edges into both machines, and a new accepting state ${accept} with ε-edges out of both. The machine may take whichever branch works.`,
        );
        break;
      }
      case 'star': {
        const inner = numbers.get(node.child) as Fragment;
        build(node.child, inner.start);
        states = [...states, start, accept];
        addEdge(start, inner.start, null);
        addEdge(start, accept, null);
        addEdge(inner.accept, inner.start, null);
        addEdge(inner.accept, accept, null);
        record(
          'star',
          node.span,
          fragment,
          [start, accept],
          4,
          'Kleene star',
          `To match zero or more repeats, add a new start state ${startLabel} and accepting state ${accept}. One ε-edge skips the machine entirely (zero repeats), one enters it, one loops from its end back to its start (another repeat), and one leaves it.`,
        );
        break;
      }
      case 'plus': {
        const inner = numbers.get(node.child) as Fragment;
        build(node.child, inner.start);
        states = [...states, start, accept];
        addEdge(start, inner.start, null);
        addEdge(inner.accept, inner.start, null);
        addEdge(inner.accept, accept, null);
        record(
          'plus',
          node.span,
          fragment,
          [start, accept],
          3,
          'One or more',
          `r+ is like r* without the edge that skips the machine, so at least one repeat is required. Add a new start state ${startLabel} and accepting state ${accept}, plus a loop from the machine's end back to its start.`,
        );
        break;
      }
      case 'optional': {
        const inner = numbers.get(node.child) as Fragment;
        build(node.child, inner.start);
        states = [...states, start, accept];
        addEdge(start, inner.start, null);
        addEdge(start, accept, null);
        addEdge(inner.accept, accept, null);
        record(
          'optional',
          node.span,
          fragment,
          [start, accept],
          3,
          'Optional',
          `r? means r or nothing. Add a new start state ${startLabel} and accepting state ${accept}, with an ε-edge that skips the machine. There is no loop, so it can run at most once.`,
        );
        break;
      }
    }
    return fragment;
  };

  const whole = numbers.get(root) as Fragment;
  build(root, whole.start);

  const stateCount = states.length;
  recorder.add(
    'Finished',
    `The NFA is complete, with ${stateCount} states. It has one start state (${whole.start}) that nothing enters and one accepting state (${whole.accept}) that nothing leaves, which are the properties Thompson's construction guarantees.`,
    {
      rule: 'done',
      span: root.span,
      states: states.slice(),
      transitions: transitions.slice(),
      newStates: [],
      newTransitions: [],
      start: whole.start,
      accept: whole.accept,
    },
  );

  return {
    nfa: { stateCount, start: whole.start, accepts: [whole.accept], transitions },
    trace: recorder.finish(),
  };
}
