import type { TacInstr } from '../ir/types';
import { optBuildCfg, optReachableBlocks, type OptBlock, type OptCfg } from './cfg';
import { collectExpressions, expressionsKilledBy } from './dataflow-facts';
import { optSolveAvailable } from './dataflow';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optOperandOfName } from './tac-text';
import { optDefOf, optExprKey, optFreshTemp, optToInstrs } from './tac-util';

// Global common subexpression elimination, the book's way: if x = y + z runs where y + z is
// already available, find the computations that made it available by searching backward, and
// reuse their value instead of computing it again.

interface Redundant {
  index: number;
  key: string;
}

/** The first statement whose expression is available just before it runs. */
function findRedundant(cfg: OptCfg): Redundant | null {
  const reachable = optReachableBlocks(cfg);
  const solution = optSolveAvailable(cfg);
  const expressions = collectExpressions(cfg);
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) continue;
    const available = new Set(solution.in.get(block.id) as Set<string>);
    for (let offset = 0; offset < block.instrs.length; offset++) {
      const instr = block.instrs[offset] as TacInstr;
      const key = optExprKey(instr);
      if (key !== null) {
        if (available.has(key)) return { index: block.start + offset, key };
        available.add(key);
      }
      for (const killed of expressionsKilledBy(instr, expressions)) available.delete(killed);
    }
  }
  return null;
}

interface SearchResult {
  /** Indexes of the computations that reach the statement. */
  sources: number[];
  /** Everything assigned on the paths between those computations and the statement. */
  assignedBetween: Set<string>;
}

/** Walks backward along every path until each one meets the expression. */
function searchSources(cfg: OptCfg, target: Redundant): SearchResult {
  const byId = new Map<string, OptBlock>(cfg.blocks.map((block) => [block.id, block]));
  const sources = new Set<number>();
  const assignedBetween = new Set<string>();

  /** Scans one block backward from `from`. True means this path found a computation. */
  const scan = (block: OptBlock, from: number): boolean => {
    for (let index = from; index >= block.start; index--) {
      const instr = block.instrs[index - block.start] as TacInstr;
      if (optExprKey(instr) === target.key) {
        // Around a loop the search can come back to the statement itself. That path then needs
        // no source of its own, because the statement will no longer change the reused value.
        if (index !== target.index) sources.add(index);
        return true;
      }
      const def = optDefOf(instr);
      if (def !== null) assignedBetween.add(def);
    }
    return false;
  };

  const home = cfg.blocks.find(
    (block) => block.start >= 0 && target.index >= block.start && target.index < block.end,
  ) as OptBlock;

  const seen = new Set<string>();
  const pending: string[] = [];
  if (!scan(home, target.index - 1)) pending.push(...home.preds);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const block = byId.get(id) as OptBlock;
    if (block.start >= 0 && !scan(block, block.end - 1)) pending.push(...block.preds);
  }

  return { sources: [...sources].toSorted((a, b) => a - b), assignedBetween };
}

function destOf(instr: TacInstr): string {
  return optDefOf(instr) as string;
}

/** Removes one redundant computation. Returns false once none are left. */
function eliminateOne(run: OptPassRun, taken: Set<string>): boolean {
  const cfg = optBuildCfg(run.instrs);
  const redundant = findRedundant(cfg);
  if (!redundant) return false;

  const { index, key } = redundant;
  const statement = run.instrs[index] as TacInstr;
  const dest = destOf(statement);
  const { sources, assignedBetween } = searchSources(cfg, redundant);
  const single = sources.length === 1 ? (run.instrs[sources[0] as number] as TacInstr) : null;
  const holder = single ? destOf(single) : null;

  // With one source whose result is untouched since, reuse its name directly. When the holder
  // is the statement's own target, the statement simply goes.
  if (holder !== null && !assignedBetween.has(holder)) {
    if (holder === dest) {
      run.remove(index, `${key} was already computed into ${dest}, and neither has changed since.`);
    } else {
      run.replace(
        index,
        { op: 'assign', dest, src: optOperandOfName(holder) },
        `${key} is already available, and ${holder} still holds its value, so there is no need to compute it again.`,
      );
    }
    return true;
  }

  // Otherwise several computations may reach here, or the name holding the value gets overwritten
  // first. A new temporary carries the value along every path.
  const temp = optFreshTemp(run.instrs, taken);
  run.replace(
    index,
    { op: 'assign', dest, src: optOperandOfName(temp) },
    `${key} is available on every path here, from ${sources.length} earlier computation${sources.length === 1 ? '' : 's'}. A new temporary ${temp} will carry the value to this line.`,
  );
  for (const source of sources.toReversed()) {
    const original = run.instrs[source] as TacInstr;
    const sourceDest = destOf(original);
    run.replace(
      source,
      { ...original, dest: temp } as TacInstr,
      `This computation of ${key} now saves its value in ${temp} as well.`,
    );
    run.insert(
      source + 1,
      { op: 'assign', dest: sourceDest, src: optOperandOfName(temp) },
      `${sourceDest} still gets the same value as before.`,
    );
  }
  return true;
}

export function optCommonSubexpressions(input: string | readonly TacInstr[]): OptPassResult {
  const run = new OptPassRun(
    'cse',
    optToInstrs(input),
    'An expression is available at a point if every path there computes it and then changes none of its operands. Computing an available expression again is a waste, so reuse the earlier value.',
  );
  const taken = new Set<string>();
  // Every elimination removes one redundant computation, so this stops on its own. The limit only
  // guards against a mistake turning into a hang in the student's browser.
  for (let round = 0; round < 500; round++) {
    if (!eliminateOne(run, taken)) break;
  }
  return run.finish('No expression is computed where it is already available.');
}
