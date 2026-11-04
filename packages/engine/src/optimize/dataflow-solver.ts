import type { TraceRecorder } from '../core/trace';
import { OPT_ENTRY, OPT_EXIT, optReversePostorder, type OptBlock, type OptCfg } from './cfg';
import type { BlockFacts } from './dataflow-facts';

// One iterative solver for all three analyses. Each analysis differs only in its direction, its
// meet operator, its boundary value, and its gen and kill sets.

export type DataflowDirection = 'forward' | 'backward';
export type DataflowMeet = 'union' | 'intersection';

export interface DataflowSets {
  in: string[];
  out: string[];
}

export interface DataflowStepState {
  /** Which sweep over the worklist this is. The first sweep visits every block. */
  iteration: number;
  /** The block just recomputed. null for the initial state. */
  block: string | null;
  /** Blocks still waiting after this step, in visit order. */
  worklist: string[];
  /** IN and OUT for every block, as they stand after this step. */
  sets: Record<string, DataflowSets>;
  /** Whether this step changed the value that flows to neighboring blocks. */
  changed: boolean;
}

export interface SolverProblem {
  direction: DataflowDirection;
  meet: DataflowMeet;
  facts: ReadonlyMap<string, BlockFacts>;
  /** OUT[ENTRY] going forward, or IN[EXIT] going backward. */
  boundary: ReadonlySet<string>;
  /** The starting guess for every other block: empty for union, everything for intersection. */
  initial: ReadonlySet<string>;
  /** Names used in explanations, like use and def rather than gen and kill. */
  genName: string;
  killName: string;
}

export interface SolverSolution {
  in: Map<string, Set<string>>;
  out: Map<string, Set<string>>;
  iterations: number;
}

export function sortFacts(facts: Iterable<string>): string[] {
  return [...facts].toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const showSet = (facts: Iterable<string>) => `{${sortFacts(facts).join(', ')}}`;

/** Each sweep follows the flow of data, which is the order that settles in the fewest sweeps. */
function visitOrder(cfg: OptCfg, direction: DataflowDirection): string[] {
  const reverse = optReversePostorder(cfg);
  const reached = new Set(reverse);
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !reached.has(id));
  const order = [...reverse, ...unreachable];
  const skip = direction === 'forward' ? OPT_ENTRY : OPT_EXIT;
  const visible = order.filter((id) => id !== skip);
  return direction === 'forward' ? visible : visible.toReversed();
}

function meetOf(sets: readonly ReadonlySet<string>[], meet: DataflowMeet): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets as [ReadonlySet<string>, ...ReadonlySet<string>[]];
  const result = new Set(first);
  for (const set of rest) {
    if (meet === 'union') {
      for (const fact of set) result.add(fact);
    } else {
      for (const fact of result) {
        if (!set.has(fact)) result.delete(fact);
      }
    }
  }
  return result;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const fact of a) {
    if (!b.has(fact)) return false;
  }
  return true;
}

/** Solves the equations to a fixed point. With a recorder, every block visit becomes a step. */
export function solveDataflow(
  cfg: OptCfg,
  problem: SolverProblem,
  recorder: TraceRecorder<DataflowStepState> | null,
): SolverSolution {
  const { direction, meet, facts, boundary, initial, genName, killName } = problem;
  const forward = direction === 'forward';
  const flowName = forward ? 'OUT' : 'IN';
  const meetName = forward ? 'IN' : 'OUT';
  const byId = new Map<string, OptBlock>(cfg.blocks.map((block) => [block.id, block]));
  const order = visitOrder(cfg, direction);

  const inSets = new Map<string, Set<string>>();
  const outSets = new Map<string, Set<string>>();
  const views: Record<string, DataflowSets> = {};
  const refreshView = (id: string) => {
    views[id] = Object.freeze({
      in: sortFacts(inSets.get(id) as Set<string>),
      out: sortFacts(outSets.get(id) as Set<string>),
    });
  };

  for (const block of cfg.blocks) {
    const isBoundary = block.id === (forward ? OPT_ENTRY : OPT_EXIT);
    // The side the equations compute starts at the initial guess. The other side starts empty.
    const flow = new Set(isBoundary ? boundary : initial);
    inSets.set(block.id, forward ? new Set() : flow);
    outSets.set(block.id, forward ? flow : new Set());
    refreshView(block.id);
  }

  const pending = new Set(order);
  const flowSets = forward ? outSets : inSets;
  const meetSets = forward ? inSets : outSets;

  recorder?.add(
    'Starting values',
    `${flowName} starts as ${showSet(initial)} for every block, except the boundary ${forward ? 'OUT[ENTRY]' : 'IN[EXIT]'} = ${showSet(boundary)}. ${meet === 'intersection' ? 'Starting from everything lets the intersection shrink each set to what truly holds on all paths.' : 'Starting empty lets the union grow each set only with facts that really arrive.'}`,
    { iteration: 0, block: null, worklist: [...order], sets: { ...views }, changed: false },
  );

  let iteration = 0;
  while (pending.size > 0) {
    iteration++;
    for (const id of order) {
      if (!pending.has(id)) continue;
      pending.delete(id);
      const block = byId.get(id) as OptBlock;
      const neighbors = forward ? block.preds : block.succs;
      const dependents = forward ? block.succs : block.preds;
      const { gen, kill } = facts.get(id) as BlockFacts;

      const met = meetOf(
        neighbors.map((neighbor) => flowSets.get(neighbor) as Set<string>),
        meet,
      );
      const flow = new Set(gen);
      for (const fact of met) {
        if (!kill.has(fact)) flow.add(fact);
      }

      const changed = !sameSet(flow, flowSets.get(id) as Set<string>);
      meetSets.set(id, met);
      flowSets.set(id, flow);
      refreshView(id);
      if (changed) {
        for (const dependent of dependents) {
          if (dependent !== (forward ? OPT_ENTRY : OPT_EXIT)) pending.add(dependent);
        }
      }

      if (recorder) {
        const sources = neighbors.map((neighbor) => `${flowName}[${neighbor}]`);
        const symbol = meet === 'union' ? ' ∪ ' : ' ∩ ';
        const waking = dependents.filter((d) => d !== (forward ? OPT_ENTRY : OPT_EXIT));
        recorder.add(
          `Iteration ${iteration}: ${id}`,
          `${meetName}[${id}] = ${sources.length > 0 ? sources.join(symbol) : 'nothing flows in'} = ${showSet(met)}. ${flowName}[${id}] = ${genName} ∪ (${meetName} − ${killName}) = ${showSet(gen)} ∪ (${showSet(met)} − ${showSet(kill)}) = ${showSet(flow)}. ${changed ? (waking.length > 0 ? `${flowName}[${id}] changed, so ${waking.join(', ')} must be looked at again.` : `${flowName}[${id}] changed, but nothing depends on it.`) : `${flowName}[${id}] did not change, so nothing else needs another look because of this block.`}`,
          {
            iteration,
            block: id,
            worklist: order.filter((item) => pending.has(item)),
            sets: { ...views },
            changed,
          },
        );
      }
    }
  }

  recorder?.add(
    'Fixed point',
    `The worklist is empty after ${iteration} iteration${iteration === 1 ? '' : 's'}, so another pass could not change any set. These are the final IN and OUT sets.`,
    { iteration, block: null, worklist: [], sets: { ...views }, changed: false },
  );

  return { in: inSets, out: outSets, iterations: iteration };
}
