import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr, type TacOperand } from '../ir/types';
import { optDefOf, optMapOperands, optToInstrs } from '../optimize/tac-util';
import {
  coloringBuildGraph,
  type ColoringEdge,
  type ColoringGraph,
  type ColoringLiveRange,
} from './coloring-graph';

export type { ColoringEdge, ColoringGraph, ColoringLiveRange } from './coloring-graph';

export const COLORING_MAX_NODES = 150;
export const COLORING_MAX_ROUNDS = 6;
/** Spill code is reached through this array, which lives in memory rather than a register. */
export const COLORING_SPILL_ARRAY = 'spill';

export type ColoringPhase = 'build' | 'simplify' | 'spill-candidate' | 'select' | 'spill' | 'done';

export type ColoringNodeStatus = 'in-graph' | 'on-stack' | 'colored' | 'spilled';

export interface ColoringNodeView {
  id: string;
  /** Neighbors still in the graph, which is what simplify compares with k. */
  degree: number;
  status: ColoringNodeStatus;
  /** A register name, once select has assigned one. */
  color: string | null;
  spillCost: number;
}

export interface ColoringStepState {
  round: number;
  phase: ColoringPhase;
  /** The node this step acted on. */
  focus: string | null;
  nodes: ColoringNodeView[];
  /** Plain edges, so a visualizer can run its own 2D or 3D layout. */
  edges: ColoringEdge[];
  /** The select stack, bottom first. */
  stack: string[];
  program: string[];
}

export interface ColoringResult {
  k: number;
  registers: string[];
  /** The final graph. */
  nodes: {
    id: string;
    degree: number;
    color: string | null;
    range: ColoringLiveRange;
  }[];
  edges: ColoringEdge[];
  /** Every name that got a register, with the register. */
  assignment: Record<string, string>;
  /** Names spilled to memory, in any round. */
  spilled: string[];
  rounds: number;
  /** The code after any spill rewrites. */
  program: string[];
  trace: Trace<ColoringStepState>;
}

interface NodeInfo {
  status: ColoringNodeStatus;
  color: string | null;
}

/** One pass of build, simplify and select. Returns the names that got no color. */
function colorOnce(
  graph: ColoringGraph,
  registers: readonly string[],
  round: number,
  program: string[],
  noSpill: ReadonlySet<string>,
  recorder: TraceRecorder<ColoringStepState>,
  info: Map<string, NodeInfo>,
): string[] {
  const k = registers.length;
  const neighbors = new Map<string, Set<string>>();
  const costs = new Map<string, number>();
  for (const range of graph.ranges) {
    neighbors.set(range.name, new Set());
    costs.set(range.name, range.spillCost);
    info.set(range.name, { status: 'in-graph', color: null });
  }
  for (const { source, target } of graph.edges) {
    (neighbors.get(source) as Set<string>).add(target);
    (neighbors.get(target) as Set<string>).add(source);
  }

  const stack: string[] = [];
  const remaining = new Set(neighbors.keys());
  const degreeOf = (id: string) =>
    [...(neighbors.get(id) as Set<string>)].filter((other) => remaining.has(other)).length;

  const record = (
    phase: ColoringPhase,
    focus: string | null,
    title: string,
    explanation: string,
  ) => {
    recorder.add(title, explanation, {
      round,
      phase,
      focus,
      nodes: graph.ranges.map((range) => {
        const node = info.get(range.name) as NodeInfo;
        return {
          id: range.name,
          degree: degreeOf(range.name),
          status: node.status,
          color: node.color,
          spillCost: range.spillCost,
        };
      }),
      edges: graph.edges,
      stack: [...stack],
      program,
    });
  };

  record(
    'build',
    null,
    `Round ${round}: interference graph`,
    `${graph.ranges.length} live ranges and ${graph.edges.length} interference edges. An edge means the two names are live at the same time, so they need different registers. There are k = ${k} registers.`,
  );

  // Simplify: a node with fewer than k neighbors can always be colored later, whatever its
  // neighbors get. So it can wait on the stack.
  while (remaining.size > 0) {
    const easy = [...remaining].find((id) => degreeOf(id) < k);
    if (easy !== undefined) {
      const degree = degreeOf(easy);
      remaining.delete(easy);
      stack.push(easy);
      (info.get(easy) as NodeInfo).status = 'on-stack';
      record(
        'simplify',
        easy,
        `Simplify: remove ${easy}`,
        `${easy} has ${degree} neighbor${degree === 1 ? '' : 's'}, fewer than k = ${k}. Whatever colors they get, one is left over for ${easy}. Push it and remove it from the graph.`,
      );
      continue;
    }
    // Stuck: every node has k or more neighbors. Pick the cheapest to spill per neighbor, and push
    // it optimistically, since its neighbors may still end up sharing colors.
    let candidate: string | null = null;
    let bestRatio = Infinity;
    for (const id of remaining) {
      if (noSpill.has(id)) continue;
      const ratio = (costs.get(id) as number) / Math.max(degreeOf(id), 1);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        candidate = id;
      }
    }
    // Only reload temporaries are left. Pick one anyway: select decides whether it truly fails.
    const chosen = candidate ?? ([...remaining][0] as string);
    const degree = degreeOf(chosen);
    remaining.delete(chosen);
    stack.push(chosen);
    (info.get(chosen) as NodeInfo).status = 'on-stack';
    record(
      'spill-candidate',
      chosen,
      `Spill candidate: ${chosen}`,
      `Every remaining node has at least k = ${k} neighbors, so simplify is stuck. ${chosen} is the cheapest to keep in memory for its ${degree} neighbors, so it goes on the stack as a possible spill. It may still get a color.`,
    );
  }

  // Select: pop in reverse. Each node's neighbors already colored are the only constraint.
  const uncolored: string[] = [];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    remaining.add(id);
    const node = info.get(id) as NodeInfo;
    const taken = new Set(
      [...(neighbors.get(id) as Set<string>)].flatMap((other) => {
        const color = (info.get(other) as NodeInfo).color;
        return color === null ? [] : [color];
      }),
    );
    const color = registers.find((register) => !taken.has(register));
    if (color === undefined) {
      node.status = 'spilled';
      uncolored.push(id);
      record(
        'select',
        id,
        `Select: ${id} cannot be colored`,
        `Its neighbors already use all ${k} registers, so this one is an actual spill. Its value will live in memory.`,
      );
    } else {
      node.status = 'colored';
      node.color = color;
      record(
        'select',
        id,
        `Select: ${id} gets ${color}`,
        `Pop ${id}. ${taken.size === 0 ? 'None of its neighbors has a color yet' : `Its colored neighbors use ${[...taken].join(', ')}`}, so ${color} is free.`,
      );
    }
  }
  return uncolored;
}

/**
 * Rewrites the code so a spilled name lives in memory. Each read loads into a brand-new short-lived
 * temporary just before the statement, and each write stores from one just after. Their ranges are
 * tiny, which is why spilling makes the graph easier to color.
 */
function rewriteSpills(
  instrs: readonly TacInstr[],
  spilled: readonly string[],
  slots: Map<string, number>,
  noSpill: Set<string>,
): TacInstr[] {
  let counter = noSpill.size;
  const fresh = (name: string) => {
    counter++;
    const temp = `${name}.r${counter}`;
    noSpill.add(temp);
    return temp;
  };
  for (const name of spilled) {
    if (!slots.has(name)) slots.set(name, slots.size);
  }
  const slotOperand = (name: string): TacOperand => ({
    kind: 'const',
    value: slots.get(name) as number,
  });

  const output: TacInstr[] = [];
  for (const instr of instrs) {
    const reload = new Map<string, string>();
    const rewritten = optMapOperands(instr, (operand) => {
      if (operand.kind === 'const' || !spilled.includes(operand.name)) return operand;
      let temp = reload.get(operand.name);
      if (!temp) {
        temp = fresh(operand.name);
        reload.set(operand.name, temp);
        output.push({
          op: 'load',
          dest: temp,
          base: COLORING_SPILL_ARRAY,
          index: slotOperand(operand.name),
        });
      }
      return { kind: 'temp', name: temp };
    });
    const def = optDefOf(rewritten);
    if (def !== null && spilled.includes(def)) {
      const temp = fresh(def);
      output.push({ ...rewritten, dest: temp } as TacInstr);
      output.push({
        op: 'store',
        base: COLORING_SPILL_ARRAY,
        index: slotOperand(def),
        src: { kind: 'temp', name: temp },
      });
    } else {
      output.push(rewritten);
    }
  }
  return output;
}

/** Chaitin-style register allocation: build, simplify, select, and on failure spill and rebuild. */
export function codegenColorGraph(
  input: string | readonly TacInstr[],
  options: { registers?: number } = {},
): ColoringResult {
  const k = options.registers ?? 3;
  if (!Number.isInteger(k) || k < 1 || k > 8) {
    throw new EngineError({
      code: 'bad_register_count',
      message: `Register allocation needs between 1 and 8 registers, but was asked to use ${k}.`,
      hint: 'Try 3 or 4.',
    });
  }
  const registers = Array.from({ length: k }, (_, index) => `R${index}`);
  const recorder = new TraceRecorder<ColoringStepState>();
  let instrs = optToInstrs(input);
  const slots = new Map<string, number>();
  const noSpill = new Set<string>();
  const allSpilled: string[] = [];

  for (let round = 1; round <= COLORING_MAX_ROUNDS; round++) {
    const graph = coloringBuildGraph(instrs);
    if (graph.ranges.length > COLORING_MAX_NODES) {
      throw new EngineError({
        code: 'coloring_too_big',
        message: `This code has ${graph.ranges.length} live ranges, more than the ${COLORING_MAX_NODES} this can animate.`,
        hint: 'Try a shorter program.',
      });
    }
    const program = instrs.map(formatTac);
    const info = new Map<string, NodeInfo>();
    const uncolored = colorOnce(graph, registers, round, program, noSpill, recorder, info);

    if (uncolored.length === 0) {
      const assignment = Object.create(null) as Record<string, string>;
      for (const [name, node] of info) {
        if (node.color !== null) assignment[name] = node.color;
      }
      const neighborCount = new Map<string, number>();
      for (const { source, target } of graph.edges) {
        neighborCount.set(source, (neighborCount.get(source) ?? 0) + 1);
        neighborCount.set(target, (neighborCount.get(target) ?? 0) + 1);
      }
      const nodes = graph.ranges.map((range) => ({
        id: range.name,
        degree: neighborCount.get(range.name) ?? 0,
        color: assignment[range.name] ?? null,
        range,
      }));
      recorder.add(
        'Done',
        `Every live range has a register${allSpilled.length > 0 ? `, after spilling ${allSpilled.join(', ')} to memory` : ', and nothing had to be spilled'}.`,
        {
          round,
          phase: 'done',
          focus: null,
          nodes: nodes.map((node) => ({
            id: node.id,
            degree: node.degree,
            status: 'colored',
            color: node.color,
            spillCost: node.range.spillCost,
          })),
          edges: graph.edges,
          stack: [],
          program,
        },
      );
      return {
        k,
        registers,
        nodes,
        edges: graph.edges,
        assignment,
        spilled: allSpilled,
        rounds: round,
        program,
        trace: recorder.finish(),
      };
    }

    // A reload temporary is already as short as a live range gets, so spilling it cannot help.
    const spillable = uncolored.filter((name) => !noSpill.has(name));
    if (spillable.length === 0) {
      throw new EngineError({
        code: 'too_few_registers',
        message: `${k} register${k === 1 ? ' is' : 's are'} too few for this code: a single statement needs more registers at once than that.`,
        hint: 'Try more registers.',
      });
    }
    allSpilled.push(...spillable);
    instrs = rewriteSpills(instrs, spillable, slots, noSpill);
    recorder.add(
      `Spill ${spillable.join(', ')}`,
      `These names now live in memory, in the ${COLORING_SPILL_ARRAY} array. Each read loads into a new short-lived temporary and each write stores from one. The graph is then rebuilt with these much shorter ranges.`,
      {
        round,
        phase: 'spill',
        focus: null,
        nodes: [],
        edges: [],
        stack: [],
        program: instrs.map(formatTac),
      },
    );
  }

  throw new EngineError({
    code: 'too_few_registers',
    message: `This code still needs spills after ${COLORING_MAX_ROUNDS} rounds with ${k} registers.`,
    hint: 'Try more registers.',
  });
}
