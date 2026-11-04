import type { TacInstr } from '../ir/types';
import { optBuildCfg, type OptBlock } from '../optimize/cfg';
import { optSolveLive } from '../optimize/dataflow';
import { optFindLoops } from '../optimize/loops';
import { optDefOf, optOperandsOf } from '../optimize/tac-util';

export interface ColoringLiveRange {
  name: string;
  /** Indexes of the statements where this name is defined. */
  defs: number[];
  /** Indexes of the statements that read it. */
  uses: number[];
  /** Indexes of the statements just after which its value is still needed. */
  liveAfter: number[];
  /** How costly it would be to keep in memory: accesses, weighted by 10 per loop level. */
  spillCost: number;
}

export interface ColoringEdge {
  source: string;
  target: string;
}

export interface ColoringGraph {
  ranges: ColoringLiveRange[];
  /** Each edge appears once, with source alphabetically before target. */
  edges: ColoringEdge[];
}

const operandNames = (instr: TacInstr) =>
  optOperandsOf(instr).flatMap((operand) => (operand.kind === 'const' ? [] : [operand.name]));

/**
 * Finds live ranges and builds the interference graph. Two names interfere when one is defined
 * while the other is live, because they then need different registers. A copy x = y is the one
 * exception: x and y hold the same value right then, so sharing a register is fine. This is
 * Chaitin's rule, and it lets later coloring remove the copy.
 *
 * Array bases are memory addresses in this model, not values in registers, so they get no node.
 */
export function coloringBuildGraph(instrs: readonly TacInstr[]): ColoringGraph {
  const cfg = optBuildCfg(instrs);
  const solution = optSolveLive(cfg, []);
  const { loops } = optFindLoops(cfg);

  const ranges = new Map<string, ColoringLiveRange>();
  const rangeOf = (name: string) => {
    let range = ranges.get(name);
    if (!range) {
      range = { name, defs: [], uses: [], liveAfter: [], spillCost: 0 };
      ranges.set(name, range);
    }
    return range;
  };

  const edgeKeys = new Set<string>();
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    rangeOf(a);
    rangeOf(b);
    edgeKeys.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  };

  /** Loop depth of a block: how many natural loops contain it. */
  const depthOf = (block: OptBlock) =>
    loops.filter((loop) => loop.blocks.includes(block.id)).length;

  // Liveness counts an array base as a use, which is right for keeping code, but a base gets no
  // register in this model. So bases are filtered out of the live sets.
  const bases = new Set<string>();
  for (const instr of instrs) {
    if (instr.op === 'load' || instr.op === 'store') bases.add(instr.base);
  }
  const isRegisterName = (name: string) => !bases.has(name);

  for (const block of cfg.blocks) {
    const weight = 10 ** depthOf(block);
    const live = new Set([...(solution.out.get(block.id) as Set<string>)].filter(isRegisterName));
    for (let offset = block.instrs.length - 1; offset >= 0; offset--) {
      const instr = block.instrs[offset] as TacInstr;
      const index = block.start + offset;
      const def = optDefOf(instr);

      for (const name of live) rangeOf(name).liveAfter.push(index);

      if (def !== null) {
        const range = rangeOf(def);
        range.defs.push(index);
        range.spillCost += weight;
        const copySource =
          instr.op === 'assign' && instr.src.kind !== 'const' ? instr.src.name : null;
        for (const other of live) {
          if (other !== copySource) addEdge(def, other);
        }
        live.delete(def);
      }
      for (const name of operandNames(instr)) {
        const range = rangeOf(name);
        range.uses.push(index);
        range.spillCost += weight;
        live.add(name);
      }
    }
  }

  // Everything live at the very start arrives from outside at the same moment, so all of it
  // interferes. Without this, two parameters could wrongly share a register.
  const atEntry = [...(solution.in.get('B1') ?? new Set<string>())].filter(isRegisterName);
  atEntry.forEach((a, i) => {
    rangeOf(a);
    for (const b of atEntry.slice(i + 1)) addEdge(a, b);
  });

  const sorted = [...ranges.values()]
    .map((range) => ({
      ...range,
      defs: range.defs.toSorted((a, b) => a - b),
      uses: [...new Set(range.uses)].toSorted((a, b) => a - b),
      liveAfter: [...new Set(range.liveAfter)].toSorted((a, b) => a - b),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const edges = [...edgeKeys]
    .map((key) => {
      const [source, target] = key.split('\u0000') as [string, string];
      return { source, target };
    })
    .toSorted(
      (a, b) =>
        a.source.localeCompare(b.source, 'en', { numeric: true }) ||
        a.target.localeCompare(b.target, 'en', { numeric: true }),
    );

  return { ranges: sorted, edges };
}
