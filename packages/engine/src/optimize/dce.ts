import type { TacInstr } from '../ir/types';
import { optBuildCfg, optReachableBlocks, type OptCfg } from './cfg';
import { optSolveLive } from './dataflow';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optDefOf, optDefaultLiveAtExit, optHasNoEffect, optToInstrs, optUsesOf } from './tac-util';

export interface OptDceOptions {
  /** Names read after this code ends. Defaults to every non-temporary name, as the book assumes. */
  liveAtExit?: readonly string[];
}

function removeUnreachable(run: OptPassRun): void {
  const cfg = optBuildCfg(run.instrs);
  const reachable = optReachableBlocks(cfg);
  const doomed: number[] = [];
  for (const block of cfg.blocks) {
    if (reachable.has(block.id)) continue;
    for (let index = block.start; index < block.end; index++) doomed.push(index);
  }
  for (const index of doomed.toReversed()) {
    run.remove(
      index,
      'No path from the start of the program reaches this line, so it can never run.',
    );
  }
}

function findDead(cfg: OptCfg, liveAtExit: readonly string[]) {
  const solution = optSolveLive(cfg, liveAtExit);
  const dead: { index: number; reason: string }[] = [];
  for (const block of cfg.blocks) {
    const live = new Set(solution.out.get(block.id) as Set<string>);
    for (let offset = block.instrs.length - 1; offset >= 0; offset--) {
      const instr = block.instrs[offset] as TacInstr;
      const def = optDefOf(instr);
      if (def !== null && !live.has(def) && optHasNoEffect(instr)) {
        dead.push({
          index: block.start + offset,
          reason: `${def} is not live after this line: nothing reads this value before ${def} is set again or the code ends. Computing it has no other effect.`,
        });
        // Skipping its uses is what lets a whole chain of dead lines go in one sweep.
        continue;
      }
      if (def !== null) live.delete(def);
      for (const name of optUsesOf(instr)) live.add(name);
    }
  }
  return dead;
}

/** Removes lines that cannot run, and assignments to names that are not live. */
export function optDeadCode(
  input: string | readonly TacInstr[],
  options: OptDceOptions = {},
): OptPassResult {
  const instrs = optToInstrs(input);
  const liveAtExit = options.liveAtExit ?? optDefaultLiveAtExit(instrs);
  const run = new OptPassRun(
    'dce',
    instrs,
    `Live-variable analysis tells us which values are still needed. An assignment to a name that is not live does nothing useful, so it can go, unless the line also has an effect, like a call or a division that might fail. Assumed live at the end: ${liveAtExit.length > 0 ? liveAtExit.join(', ') : 'nothing'}.`,
  );

  removeUnreachable(run);
  // Each sweep removes at least one line, so the program's length bounds the number of sweeps.
  while (true) {
    const dead = findDead(optBuildCfg(run.instrs), liveAtExit);
    if (dead.length === 0) break;
    for (const { index, reason } of dead.toSorted((a, b) => b.index - a.index)) {
      run.remove(index, reason);
    }
  }
  return run.finish('Every line can run, and every value computed here is used.');
}
