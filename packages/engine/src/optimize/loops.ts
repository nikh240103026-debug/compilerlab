import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import type { TacInstr } from '../ir/types';
import {
  OPT_ENTRY,
  optBuildCfg,
  optReachableBlocks,
  optReversePostorder,
  type OptBlock,
  type OptCfg,
} from './cfg';
import { sortFacts } from './dataflow-solver';
import { optToInstrs } from './tac-util';

export interface LoopBackEdge {
  from: string;
  to: string;
}

export interface LoopNatural {
  header: string;
  /** Back edges that formed this loop. Loops sharing a header are merged, as the book does. */
  backEdges: LoopBackEdge[];
  /** Every block in the loop, including the header. */
  blocks: string[];
  /** Edges that leave the loop. */
  exits: LoopBackEdge[];
}

export type LoopPhase = 'dominators' | 'back-edges' | 'natural-loops' | 'done';

export interface LoopStepState {
  phase: LoopPhase;
  /** Sweep number while computing dominators. */
  iteration: number;
  block: string | null;
  dominators: Record<string, string[]>;
  backEdges: LoopBackEdge[];
  loops: LoopNatural[];
  /** The edge or set of blocks to highlight in this step. */
  highlightEdge: LoopBackEdge | null;
  highlightBlocks: string[];
}

export interface LoopAnalysis {
  cfg: OptCfg;
  dominators: Record<string, string[]>;
  /** Parent of each block in the dominator tree. ENTRY and unreachable blocks have none. */
  immediateDominators: Record<string, string | null>;
  backEdges: LoopBackEdge[];
  loops: LoopNatural[];
  /** True when every retreating edge is a back edge, so every cycle is a natural loop. */
  reducible: boolean;
}

export interface LoopResult extends LoopAnalysis {
  trace: Trace<LoopStepState>;
}

function retreatingEdges(cfg: OptCfg): LoopBackEdge[] {
  // An edge is retreating when it goes back up the depth-first tree, which means it points to a
  // block that is still on the current search path.
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const onPath = new Set<string>([OPT_ENTRY]);
  const seen = new Set<string>([OPT_ENTRY]);
  const edges: LoopBackEdge[] = [];
  const stack: { id: string; next: number }[] = [{ id: OPT_ENTRY, next: 0 }];
  while (stack.length > 0) {
    const top = stack.at(-1) as { id: string; next: number };
    const succ = (byId.get(top.id) as OptBlock).succs[top.next];
    top.next++;
    if (succ === undefined) {
      onPath.delete(top.id);
      stack.pop();
    } else if (onPath.has(succ)) {
      edges.push({ from: top.id, to: succ });
    } else if (!seen.has(succ)) {
      seen.add(succ);
      onPath.add(succ);
      stack.push({ id: succ, next: 0 });
    }
  }
  return edges;
}

/** The book's iterative algorithm, in reverse postorder: D(n) = {n} ∪ (∩ D(p) over preds p). */
function solveDominators(
  cfg: OptCfg,
  emit: (iteration: number, block: string, all: ReadonlyMap<string, Set<string>>) => void,
): Map<string, Set<string>> {
  const reachable = optReachableBlocks(cfg);
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const order = optReversePostorder(cfg);
  const dominators = new Map<string, Set<string>>();
  for (const id of order) dominators.set(id, new Set(order));
  dominators.set(OPT_ENTRY, new Set([OPT_ENTRY]));

  let iteration = 0;
  let changed = true;
  while (changed) {
    changed = false;
    iteration++;
    for (const id of order) {
      if (id === OPT_ENTRY) continue;
      const preds = (byId.get(id) as OptBlock).preds.filter((pred) => reachable.has(pred));
      const next = new Set<string>(dominators.get(preds[0] as string));
      for (const pred of preds.slice(1)) {
        const other = dominators.get(pred) as Set<string>;
        for (const candidate of next) {
          if (!other.has(candidate)) next.delete(candidate);
        }
      }
      next.add(id);
      const current = dominators.get(id) as Set<string>;
      if (next.size !== current.size) {
        changed = true;
        dominators.set(id, next);
        emit(iteration, id, dominators);
      }
    }
  }
  return dominators;
}

function immediateDominatorsOf(
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [id, doms] of dominators) {
    // The immediate dominator is the strict dominator with the most dominators of its own, which
    // makes it the closest one to this block.
    let closest: string | null = null;
    let closestSize = -1;
    for (const dom of doms) {
      if (dom === id) continue;
      const size = (dominators.get(dom) as ReadonlySet<string>).size;
      if (size > closestSize) {
        closest = dom;
        closestSize = size;
      }
    }
    result[id] = closest;
  }
  return result;
}

/** The book's algorithm: start from the back edge's tail and walk predecessors up to the header. */
function naturalLoopBlocks(
  cfg: OptCfg,
  edge: LoopBackEdge,
  reachable: ReadonlyMap<string, unknown>,
): Set<string> {
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const body = new Set<string>([edge.to]);
  const pending: string[] = [];
  if (!body.has(edge.from)) {
    body.add(edge.from);
    pending.push(edge.from);
  }
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const pred of (byId.get(id) as OptBlock).preds) {
      // Dead code that jumps into the loop is not part of it, because control never comes from it.
      if (!body.has(pred) && reachable.has(pred)) {
        body.add(pred);
        pending.push(pred);
      }
    }
  }
  return body;
}

function showDominators(dominators: ReadonlyMap<string, ReadonlySet<string>>) {
  const shown: Record<string, string[]> = {};
  for (const [id, doms] of dominators) shown[id] = sortFacts(doms);
  return shown;
}

function analyze(cfg: OptCfg, recorder: TraceRecorder<LoopStepState> | null): LoopAnalysis {
  const blank = {
    backEdges: [] as LoopBackEdge[],
    loops: [] as LoopNatural[],
    highlightEdge: null,
    highlightBlocks: [] as string[],
  };

  const dominators = solveDominators(cfg, (iteration, block, all) => {
    const doms = all.get(block) as Set<string>;
    recorder?.add(
      `Dominators of ${block}, sweep ${iteration}`,
      `D(${block}) = {${block}} ∪ the intersection of D(p) over its predecessors = {${sortFacts(doms).join(', ')}}. A block dominates ${block} only if every path from ENTRY to ${block} goes through it.`,
      { phase: 'dominators', iteration, block, dominators: showDominators(all), ...blank },
    );
  });
  const shownDominators = showDominators(dominators);

  recorder?.add(
    'Dominators settled',
    'A full sweep changed nothing, so these dominator sets are final.',
    { phase: 'dominators', iteration: 0, block: null, dominators: shownDominators, ...blank },
  );

  const backEdges: LoopBackEdge[] = [];
  for (const { from, to } of cfg.edges) {
    const doms = dominators.get(from);
    if (doms?.has(to)) {
      backEdges.push({ from, to });
      recorder?.add(
        `Back edge ${from} → ${to}`,
        `${to} dominates ${from}, so ${from} → ${to} is a back edge. Every back edge marks a loop whose header is ${to}.`,
        {
          phase: 'back-edges',
          iteration: 0,
          block: null,
          dominators: shownDominators,
          backEdges: [...backEdges],
          loops: [],
          highlightEdge: { from, to },
          highlightBlocks: [from, to],
        },
      );
    }
  }

  const byHeader = new Map<string, { edges: LoopBackEdge[]; body: Set<string> }>();
  for (const edge of backEdges) {
    const body = naturalLoopBlocks(cfg, edge, dominators);
    const existing = byHeader.get(edge.to);
    if (existing) {
      existing.edges.push(edge);
      for (const block of body) existing.body.add(block);
    } else {
      byHeader.set(edge.to, { edges: [edge], body });
    }
  }

  const loops: LoopNatural[] = [];
  for (const [header, { edges, body }] of byHeader) {
    const exits = cfg.edges.filter(({ from, to }) => body.has(from) && !body.has(to));
    const loop: LoopNatural = { header, backEdges: edges, blocks: sortFacts(body), exits };
    loops.push(loop);
    recorder?.add(
      `Natural loop at ${header}`,
      `Starting from the back edge${edges.length === 1 ? '' : 's'} ${edges.map((edge) => `${edge.from} → ${edge.to}`).join(', ')}, walk predecessors until reaching the header ${header}. The loop is {${loop.blocks.join(', ')}}${edges.length > 1 ? ', merging the loops that share this header' : ''}.`,
      {
        phase: 'natural-loops',
        iteration: 0,
        block: null,
        dominators: shownDominators,
        backEdges: [...backEdges],
        loops: [...loops],
        highlightEdge: null,
        highlightBlocks: loop.blocks,
      },
    );
  }

  const isBackEdge = (edge: LoopBackEdge) =>
    backEdges.some(({ from, to }) => from === edge.from && to === edge.to);
  const reducible = retreatingEdges(cfg).every(isBackEdge);

  recorder?.add(
    'Loops found',
    `Found ${loops.length} natural loop${loops.length === 1 ? '' : 's'}. ${reducible ? 'Every retreating edge is a back edge, so this flow graph is reducible.' : 'Some retreating edge is not a back edge, so this flow graph is not reducible, and that cycle is not a natural loop.'}`,
    {
      phase: 'done',
      iteration: 0,
      block: null,
      dominators: shownDominators,
      backEdges,
      loops,
      highlightEdge: null,
      highlightBlocks: [],
    },
  );

  return {
    cfg,
    dominators: shownDominators,
    immediateDominators: immediateDominatorsOf(dominators),
    backEdges,
    loops,
    reducible,
  };
}

/** Finds dominators, back edges and natural loops, with a trace. */
export function loopAnalyze(input: string | readonly TacInstr[]): LoopResult {
  const cfg = optBuildCfg(optToInstrs(input));
  if (cfg.blocks.length > 200) {
    throw new EngineError({
      code: 'loops_too_big',
      message: `This code has ${cfg.blocks.length} blocks, which is too many to animate.`,
      hint: 'Try a shorter program.',
    });
  }
  const recorder = new TraceRecorder<LoopStepState>();
  const analysis = analyze(cfg, recorder);
  return { ...analysis, trace: recorder.finish() };
}

/** The same analysis without a trace, for the loop optimization passes. */
export function optFindLoops(cfg: OptCfg): LoopAnalysis {
  return analyze(cfg, null);
}
