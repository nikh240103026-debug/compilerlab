import { TraceRecorder, type Trace } from '../core/trace';
import { IR_ENTRY, IR_EXIT, type IrCfg } from './cfg';

// Dominators, by the iterative algorithm of section 9.6.1:
//
//   D(ENTRY) = { ENTRY }
//   D(n) = { n } ∪ the intersection of D(p) over each predecessor p of n
//
// Then the immediate dominators, the dominator tree, and the dominance frontiers that SSA needs.
// A block no path reaches has no meaningful dominators, so those blocks are left out and named.

export interface IrDominatorRow {
  node: string;
  dominators: string[];
}

export interface IrFrontierRow {
  node: string;
  frontier: string[];
}

export type IrDominatorPhase = 'init' | 'iterate' | 'idom' | 'frontier' | 'finished';

export interface IrDominatorState {
  phase: IrDominatorPhase;
  iteration: number;
  node: string | null;
  /** D(n) for each reachable node, at this step. */
  rows: IrDominatorRow[];
  /** Immediate dominators known at this step. */
  idom: { node: string; idom: string | null }[];
  /** DF(n) for each reachable node, at this step. */
  frontier: IrFrontierRow[];
}

export interface IrDominatorResult {
  /** The nodes a path from ENTRY reaches, in cfg.nodes order. */
  reachable: string[];
  /** Blocks no path reaches. */
  unreachable: string[];
  dominators: Record<string, string[]>;
  idom: Record<string, string | null>;
  /** The dominator tree, as each node's children. */
  tree: Record<string, string[]>;
  frontier: Record<string, string[]>;
  trace: Trace<IrDominatorState>;
}

/** Depth-first from ENTRY, then reversed. Predecessors mostly come first, so few passes are needed. */
function reversePostorder(cfg: IrCfg): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (node: string): void => {
    seen.add(node);
    for (const next of cfg.successors[node] ?? []) {
      if (!seen.has(next)) visit(next);
    }
    order.push(node);
  };
  visit(IR_ENTRY);
  return order.reverse();
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/** Computes dominators, immediate dominators, the dominator tree and dominance frontiers. */
export function irDominators(cfg: IrCfg): IrDominatorResult {
  const recorder = new TraceRecorder<IrDominatorState>();
  const order = reversePostorder(cfg);
  const reachableSet = new Set(order);
  const reachable = cfg.nodes.filter((node) => reachableSet.has(node));
  const unreachable = cfg.nodes.filter((node) => !reachableSet.has(node) && node !== IR_EXIT);
  const position = new Map(cfg.nodes.map((node, index) => [node, index]));
  const byNodeOrder = (list: Iterable<string>): string[] =>
    [...list].toSorted((a, b) => (position.get(a) as number) - (position.get(b) as number));
  const predecessorsOf = (node: string): string[] =>
    (cfg.predecessors[node] ?? []).filter((item) => reachableSet.has(item));

  // Rows are rebuilt only for the node that changed, so each step shares the rest.
  const sets = new Map<string, Set<string>>();
  const rows = new Map<string, IrDominatorRow>();
  const setRow = (node: string, set: Set<string>): void => {
    sets.set(node, set);
    rows.set(node, { node, dominators: byNodeOrder(set) });
  };
  const rowList = (): IrDominatorRow[] => reachable.map((node) => rows.get(node) as IrDominatorRow);

  let idomRows: { node: string; idom: string | null }[] = [];
  const frontierRows = new Map<string, IrFrontierRow>(
    reachable.map((node) => [node, { node, frontier: [] }]),
  );
  const frontierList = (): IrFrontierRow[] =>
    reachable.map((node) => frontierRows.get(node) as IrFrontierRow);

  const add = (
    title: string,
    explanation: string,
    phase: IrDominatorPhase,
    iteration: number,
    node: string | null,
  ): void => {
    recorder.add(title, explanation, {
      phase,
      iteration,
      node,
      rows: rowList(),
      idom: idomRows,
      frontier: frontierList(),
    });
  };

  // ------ Dominator sets ------
  for (const node of reachable) {
    setRow(node, node === IR_ENTRY ? new Set([node]) : new Set(reachable));
  }
  add(
    'Start',
    'ENTRY is dominated only by itself. Every other node starts out with all the nodes, the largest possible answer. Each pass can only shrink these sets, so the process must stop.',
    'init',
    0,
    null,
  );

  let iteration = 0;
  let changed = true;
  while (changed) {
    changed = false;
    iteration++;
    for (const node of order) {
      if (node === IR_ENTRY) continue;
      const predecessors = predecessorsOf(node);
      const first = predecessors[0] as string;
      const common = new Set(sets.get(first));
      for (const other of predecessors.slice(1)) {
        const set = sets.get(other) as Set<string>;
        for (const item of [...common]) {
          if (!set.has(item)) common.delete(item);
        }
      }
      common.add(node);
      if (sameSet(common, sets.get(node) as Set<string>)) continue;
      setRow(node, common);
      changed = true;
      add(
        `D(${node})`,
        `Everything that dominates ${node} must dominate all its predecessors (${predecessors.join(', ')}), and ${node} dominates itself. That gives D(${node}) = {${byNodeOrder(common).join(', ')}}.`,
        'iterate',
        iteration,
        node,
      );
    }
    add(
      `End of pass ${iteration}`,
      changed
        ? 'Some set changed, so another pass is needed.'
        : 'No set changed in this pass, so these are the final dominators.',
      'iterate',
      iteration,
      null,
    );
  }

  // ------ Immediate dominators and the tree ------
  // Dominators of a node form a chain, so the nearest strict one is the one with the largest set.
  const idom = new Map<string, string | null>();
  for (const node of reachable) {
    if (node === IR_ENTRY) {
      idom.set(node, null);
      continue;
    }
    let nearest: string | null = null;
    for (const candidate of sets.get(node) as Set<string>) {
      if (candidate === node) continue;
      if (
        nearest === null ||
        (sets.get(candidate) as Set<string>).size > (sets.get(nearest) as Set<string>).size
      ) {
        nearest = candidate;
      }
    }
    idom.set(node, nearest);
    idomRows = [...idomRows, { node, idom: nearest }];
    add(
      `idom(${node}) = ${nearest}`,
      `${nearest} is the strict dominator of ${node} closest to it, so it is the parent of ${node} in the dominator tree.`,
      'idom',
      iteration,
      node,
    );
  }
  const tree = new Map<string, string[]>(reachable.map((node) => [node, []]));
  for (const node of reachable) {
    const parent = idom.get(node);
    if (parent) (tree.get(parent) as string[]).push(node);
  }

  // ------ Dominance frontiers ------
  // A join point is in DF(n) when n dominates a predecessor of it, but does not strictly dominate
  // the join point itself. Walking up from each predecessor to the join's idom finds exactly those.
  const frontier = new Map<string, Set<string>>(reachable.map((node) => [node, new Set<string>()]));
  for (const node of reachable) {
    const predecessors = predecessorsOf(node);
    if (predecessors.length < 2) continue;
    const stop = idom.get(node) ?? null;
    for (const predecessor of predecessors) {
      let runner: string | null = predecessor;
      const walked: string[] = [];
      while (runner !== null && runner !== stop) {
        const set = frontier.get(runner) as Set<string>;
        if (!set.has(node)) {
          set.add(node);
          frontierRows.set(runner, { node: runner, frontier: byNodeOrder(set) });
          walked.push(runner);
        }
        runner = idom.get(runner) ?? null;
      }
      if (walked.length > 0) {
        add(
          `${node} joins paths`,
          `${node} has several predecessors. Walking up the dominator tree from ${predecessor} to idom(${node}) = ${stop}, ${node} goes in the frontier of ${walked.join(', ')}. Those nodes dominate a way into ${node} without strictly dominating ${node}.`,
          'frontier',
          iteration,
          node,
        );
      }
    }
  }

  add(
    'Finished',
    unreachable.length > 0
      ? `Done, in ${iteration} passes. ${unreachable.join(', ')} ${unreachable.length === 1 ? 'is' : 'are'} unreachable, so ${unreachable.length === 1 ? 'it has' : 'they have'} no dominators.`
      : `Done, in ${iteration} passes.`,
    'finished',
    iteration,
    null,
  );

  return {
    reachable,
    unreachable,
    dominators: Object.fromEntries(
      reachable.map((node) => [node, byNodeOrder(sets.get(node) as Set<string>)]),
    ),
    idom: Object.fromEntries(idom),
    tree: Object.fromEntries(tree),
    frontier: Object.fromEntries(
      reachable.map((node) => [node, byNodeOrder(frontier.get(node) as Set<string>)]),
    ),
    trace: recorder.finish(),
  };
}
