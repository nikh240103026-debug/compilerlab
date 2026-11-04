import type { TacInstr } from '../ir/types';
import type { OptBlock, OptCfg } from './cfg';
import type { LoopNatural } from './loops';
import type { OptPassRun } from './pass-core';

export interface PreheaderStatement {
  instr: TacInstr;
  reason: string;
}

function freshLabel(instrs: readonly TacInstr[]): string {
  const taken = new Set(instrs.flatMap((instr) => (instr.op === 'label' ? [instr.name] : [])));
  let number = 1;
  while (taken.has(`P${number}`)) number++;
  return `P${number}`;
}

/**
 * Puts statements in front of a loop, so they run once on entry and never on the way around.
 * Our code is a flat list, so a preheader is just a spot directly above the header's label:
 *
 * - Code entering by falling through passes over the new lines on its own.
 * - Code entering by a jump is retargeted to a new label above those lines.
 * - The back edges still jump to the header's label, and so skip them.
 * - A block inside the loop that sits just above the header gets a goto, so it cannot fall into
 *   the new lines.
 *
 * `cfg` must describe `run.instrs` exactly as they are now.
 */
export function optInsertIntoPreheader(
  run: OptPassRun,
  cfg: OptCfg,
  loop: LoopNatural,
  statements: readonly PreheaderStatement[],
): void {
  if (statements.length === 0) return;
  const byId = new Map<string, OptBlock>(cfg.blocks.map((block) => [block.id, block]));
  const header = byId.get(loop.header) as OptBlock;
  const inLoop = new Set(loop.blocks);
  const first = header.instrs[0];
  // A back edge is a jump to the header, so the header always starts with a label.
  const headerLabel = first?.op === 'label' ? first.name : '';

  let preheaderLabel: string | null = null;
  for (const predId of header.preds) {
    if (inLoop.has(predId)) continue;
    const pred = byId.get(predId) as OptBlock;
    const last = pred.instrs.at(-1);
    if ((last?.op === 'goto' || last?.op === 'if') && last.target === headerLabel) {
      preheaderLabel ??= freshLabel(run.instrs);
      run.replace(
        pred.end - 1,
        { ...last, target: preheaderLabel },
        `Entry to the loop must pass through the new preheader ${preheaderLabel}, so this jump goes there rather than straight to ${headerLabel}.`,
      );
    }
  }

  let at = header.start;
  const above = cfg.blocks.find((block) => block.start >= 0 && block.end === header.start);
  const aboveLast = above?.instrs.at(-1);
  const aboveFallsIn =
    above !== undefined &&
    inLoop.has(above.id) &&
    aboveLast?.op !== 'goto' &&
    aboveLast?.op !== 'return';
  if (aboveFallsIn) {
    run.insert(
      at,
      { op: 'goto', target: headerLabel },
      `This block is inside the loop and used to fall into ${headerLabel}. The goto keeps it from running the preheader on every trip.`,
    );
    at++;
  }
  if (preheaderLabel !== null) {
    run.insert(
      at,
      { op: 'label', name: preheaderLabel },
      `A preheader is a new block that runs once, just before the loop is entered.`,
    );
    at++;
  }
  for (const { instr, reason } of statements) {
    run.insert(at, instr, reason);
    at++;
  }
}
