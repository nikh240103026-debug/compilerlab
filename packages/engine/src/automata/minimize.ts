import { TraceRecorder, type Trace } from '../core/trace';
import { formatCharSet } from '../regex/charset';
import { NO_TRANSITION, type Dfa } from './types';

export const DEAD_STATE_NAME = '∅';

export interface PartitionBlock {
  /** Stable across steps, so a block keeps its color when it splits. */
  id: number;
  states: number[];
}

export interface MinimizeState {
  /** State names. The last may be the dead state, ∅. */
  names: string[];
  accepting: number[];
  alphabet: string[];
  blocks: PartitionBlock[];
  /** Block ids still waiting to be used as splitters. */
  worklist: number[];
  splitter: number[] | null;
  symbol: number | null;
  /** States that reach the splitter on this symbol. */
  preimage: number[];
  /** Blocks this step split, as the id kept and the new id created. */
  splits: { kept: number; created: number }[];
  done: boolean;
}

export interface MinimizeResult {
  dfa: Dfa;
  trace: Trace<MinimizeState>;
}

function reachableStates(dfa: Dfa): number[] {
  const seen = new Set([dfa.start]);
  const pending = [dfa.start];
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    for (const target of dfa.delta[state] as number[]) {
      if (target !== NO_TRANSITION && !seen.has(target)) {
        seen.add(target);
        pending.push(target);
      }
    }
  }
  return [...seen].toSorted((a, b) => a - b);
}

/** Hopcroft's algorithm, with one trace step for each (splitter, symbol) pair tried. */
export function minimizeDfa(input: Dfa): MinimizeResult {
  const recorder = new TraceRecorder<MinimizeState>();
  const labels = input.alphabet.map(formatCharSet);

  // Work on a complete automaton over reachable states. Missing moves go to a dead state.
  const reachable = reachableStates(input);
  const reachableSet = new Set(reachable);
  const accepts = new Set(input.accepts.filter((state) => reachableSet.has(state)));
  const needsDead = reachable.some((state) =>
    (input.delta[state] as number[]).includes(NO_TRANSITION),
  );
  const dead = needsDead ? input.stateCount : -1;
  const allStates = needsDead ? [...reachable, dead] : reachable;
  const step = (state: number, symbol: number): number => {
    if (state === dead) return dead;
    const target = (input.delta[state] as number[])[symbol] as number;
    return target === NO_TRANSITION ? dead : target;
  };
  const names = needsDead ? [...input.names, DEAD_STATE_NAME] : input.names;
  const nameOf = (state: number) => names[state] as string;
  const namesOf = (states: readonly number[]) => states.map(nameOf).join(', ');

  const blocks = new Map<number, number[]>();
  let nextBlockId = 0;
  const addBlock = (states: number[]): number => {
    blocks.set(nextBlockId, states);
    return nextBlockId++;
  };

  const acceptingStates = allStates.filter((state) => accepts.has(state));
  const otherStates = allStates.filter((state) => !accepts.has(state));
  const worklist: number[] = [];
  if (otherStates.length > 0) addBlock(otherStates);
  if (acceptingStates.length > 0) addBlock(acceptingStates);
  if (acceptingStates.length > 0 && otherStates.length > 0) {
    worklist.push(acceptingStates.length <= otherStates.length ? 1 : 0);
  }

  const blockViews = (): PartitionBlock[] =>
    [...blocks.entries()]
      .map(([id, states]) => ({ id, states: states.slice() }))
      .toSorted((a, b) => (a.states[0] as number) - (b.states[0] as number));

  const snapshot = (fields: Partial<MinimizeState>): MinimizeState => ({
    names: names.slice(),
    accepting: [...accepts],
    alphabet: labels,
    blocks: blockViews(),
    worklist: worklist.slice(),
    splitter: null,
    symbol: null,
    preimage: [],
    splits: [],
    done: false,
    ...fields,
  });

  const unreachable = input.names.filter((_, state) => !reachableSet.has(state));
  const preamble = [
    unreachable.length > 0 ? `Drop ${unreachable.join(', ')}, which cannot be reached.` : '',
    needsDead
      ? `Missing transitions go to an imaginary dead state ${DEAD_STATE_NAME}, so every state has a move on every symbol.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  recorder.add(
    'First split',
    `${preamble ? `${preamble} ` : ''}Start with the one split we know is right: accepting states ${acceptingStates.length > 0 ? namesOf(acceptingStates) : '(none)'} can never behave like non-accepting states ${otherStates.length > 0 ? namesOf(otherStates) : '(none)'}, because the empty string already tells them apart.`,
    snapshot({}),
  );

  for (let current = worklist.shift(); current !== undefined; current = worklist.shift()) {
    // Copied because this block may itself split during the loop. The set stays the splitter.
    const splitter = (blocks.get(current) as number[]).slice();
    const splitterSet = new Set(splitter);
    for (let symbol = 0; symbol < input.alphabet.length; symbol++) {
      const label = labels[symbol] as string;
      const preimage = allStates.filter((state) => splitterSet.has(step(state, symbol)));
      const preimageSet = new Set(preimage);
      const splits: MinimizeState['splits'] = [];
      for (const [id, states] of [...blocks.entries()]) {
        const inside = states.filter((state) => preimageSet.has(state));
        const outside = states.filter((state) => !preimageSet.has(state));
        if (inside.length === 0 || outside.length === 0) continue;
        blocks.set(id, inside);
        const created = addBlock(outside);
        splits.push({ kept: id, created });
        if (worklist.includes(id)) worklist.push(created);
        else worklist.push(inside.length <= outside.length ? id : created);
      }
      const explanation =
        splits.length > 0
          ? `On ${label}, only ${preimage.length > 0 ? namesOf(preimage) : 'no states'} go into {${namesOf(splitter)}}. ${splits
              .map(
                ({ kept, created }) =>
                  `{${namesOf(blocks.get(kept) as number[])}} and {${namesOf(blocks.get(created) as number[])}} behave differently, so they are split.`,
              )
              .join(' ')}`
          : `On ${label}, ${preimage.length > 0 ? `${namesOf(preimage)} go` : 'no states go'} into {${namesOf(splitter)}}. Every block is entirely in or entirely out of that group, so nothing splits.`;
      recorder.add(
        `{${namesOf(splitter)}} on ${label}`,
        explanation,
        snapshot({ splitter: splitter.slice(), symbol, preimage, splits }),
      );
    }
  }

  // Build the result: drop the dead block, and any block that can never reach acceptance.
  const blockOf = new Map<number, number>();
  for (const [id, states] of blocks) for (const state of states) blockOf.set(state, id);
  const blockIds = [...blocks.keys()];
  const blockStep = (id: number, symbol: number): number =>
    blockOf.get(step((blocks.get(id) as number[])[0] as number, symbol)) as number;

  const live = new Set(
    blockIds.filter((id) => (blocks.get(id) as number[]).some((state) => accepts.has(state))),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const id of blockIds) {
      if (live.has(id)) continue;
      if (input.alphabet.some((_, symbol) => live.has(blockStep(id, symbol)))) {
        live.add(id);
        changed = true;
      }
    }
  }

  const startBlock = blockOf.get(input.start) as number;
  const order: number[] = [startBlock];
  const position = new Map([[startBlock, 0]]);
  for (let i = 0; i < order.length; i++) {
    for (let symbol = 0; symbol < input.alphabet.length; symbol++) {
      const target = blockStep(order[i] as number, symbol);
      if (live.has(target) && !position.has(target)) {
        position.set(target, order.length);
        order.push(target);
      }
    }
  }

  const memberStates = order.map((id) =>
    (blocks.get(id) as number[]).filter((state) => state !== dead),
  );
  const minimal: Dfa = {
    stateCount: order.length,
    names: memberStates.map((states) => states.map(nameOf).join(',')),
    start: 0,
    accepts: order.flatMap((id, i) =>
      (blocks.get(id) as number[]).some((state) => accepts.has(state)) ? [i] : [],
    ),
    alphabet: input.alphabet,
    delta: order.map((id) =>
      input.alphabet.map((_, symbol) => {
        const target = blockStep(id, symbol);
        return live.has(target) ? (position.get(target) as number) : NO_TRANSITION;
      }),
    ),
    sources: memberStates,
  };

  const merged = memberStates
    .filter((states) => states.length > 1)
    .map((states) => namesOf(states));
  recorder.add(
    'Finished',
    `No block can be split further, so the states left in each block are truly equivalent. ${merged.length > 0 ? `Merging ${merged.map((group) => `{${group}}`).join(' and ')} gives` : 'Nothing needed merging, so the DFA was already minimal, with'} ${minimal.stateCount} state${minimal.stateCount === 1 ? '' : 's'}.`,
    snapshot({ done: true }),
  );

  return { dfa: minimal, trace: recorder.finish() };
}
