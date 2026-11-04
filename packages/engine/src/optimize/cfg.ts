import { EngineError } from '../core/result';
import { formatTac, type TacInstr } from '../ir/types';

export const OPT_ENTRY = 'ENTRY';
export const OPT_EXIT = 'EXIT';

export interface OptBlock {
  /** B1, B2, ... in program order, plus the empty ENTRY and EXIT blocks. */
  id: string;
  /** Index of this block's first instruction in the program. Empty blocks use -1. */
  start: number;
  /** Index just past this block's last instruction. */
  end: number;
  instrs: TacInstr[];
  text: string[];
  preds: string[];
  succs: string[];
}

export interface OptCfg {
  blocks: OptBlock[];
  /** Flat edge list, so a visualizer can lay the graph out directly. */
  edges: { from: string; to: string }[];
}

/** Finds the leaders using the book's three rules, and returns their indexes in order. */
export function optFindLeaders(instrs: readonly TacInstr[]): number[] {
  const leaders = new Set<number>();
  if (instrs.length > 0) leaders.add(0);
  instrs.forEach((instr, index) => {
    // A label is only a jump target when something jumps to it, but a label starting a block is
    // harmless and keeps the output readable, so every label begins a block.
    if (instr.op === 'label') leaders.add(index);
    const jumps = instr.op === 'goto' || instr.op === 'if' || instr.op === 'return';
    if (jumps && index + 1 < instrs.length) leaders.add(index + 1);
  });
  return [...leaders].toSorted((a, b) => a - b);
}

/** Partitions the code into basic blocks and links them, adding ENTRY and EXIT. */
export function optBuildCfg(instrs: readonly TacInstr[]): OptCfg {
  const leaders = optFindLeaders(instrs);
  const blocks: OptBlock[] = [];
  const blockOfLabel = new Map<string, string>();

  const makeBlock = (id: string, start: number, end: number): OptBlock => {
    const body = start < 0 ? [] : instrs.slice(start, end);
    return { id, start, end, instrs: body, text: body.map(formatTac), preds: [], succs: [] };
  };

  blocks.push(makeBlock(OPT_ENTRY, -1, -1));
  leaders.forEach((start, index) => {
    const end = leaders[index + 1] ?? instrs.length;
    const block = makeBlock(`B${index + 1}`, start, end);
    blocks.push(block);
    for (const instr of block.instrs) {
      if (instr.op === 'label') blockOfLabel.set(instr.name, block.id);
    }
  });
  blocks.push(makeBlock(OPT_EXIT, -1, -1));

  const byId = new Map(blocks.map((block) => [block.id, block]));
  const edges: OptCfg['edges'] = [];
  const link = (from: OptBlock, to: string) => {
    if (from.succs.includes(to)) return;
    from.succs.push(to);
    (byId.get(to) as OptBlock).preds.push(from.id);
    edges.push({ from: from.id, to });
  };

  const targetOf = (label: string): string => {
    const target = blockOfLabel.get(label);
    if (target === undefined) {
      throw new EngineError({
        code: 'unknown_label',
        message: `This code jumps to ${label}, but no line defines that label.`,
        hint: `Add a line "${label}:" where the jump should land.`,
      });
    }
    return target;
  };

  link(blocks[0] as OptBlock, (blocks[1] as OptBlock).id);
  for (let i = 1; i < blocks.length - 1; i++) {
    const block = blocks[i] as OptBlock;
    const last = block.instrs.at(-1);
    const next = (blocks[i + 1] as OptBlock).id;
    if (last?.op === 'goto') {
      link(block, targetOf(last.target));
    } else if (last?.op === 'return') {
      link(block, OPT_EXIT);
    } else if (last?.op === 'if') {
      // Branch taken first, then fall through.
      link(block, targetOf(last.target));
      link(block, next);
    } else {
      link(block, next);
    }
  }

  return { blocks, edges };
}

/** Blocks reachable from ENTRY by following edges. */
export function optReachableBlocks(cfg: OptCfg): Set<string> {
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>([OPT_ENTRY]);
  const pending = [OPT_ENTRY];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const succ of (byId.get(id) as OptBlock).succs) {
      if (!seen.has(succ)) {
        seen.add(succ);
        pending.push(succ);
      }
    }
  }
  return seen;
}

/** Reverse postorder from ENTRY: forward analyses settle fastest visiting blocks in this order. */
export function optReversePostorder(cfg: OptCfg): string[] {
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  const postorder: string[] = [];
  // Explicit stack, because a long chain of blocks could overflow real recursion.
  const stack: { id: string; next: number }[] = [{ id: OPT_ENTRY, next: 0 }];
  seen.add(OPT_ENTRY);
  while (stack.length > 0) {
    const top = stack.at(-1) as { id: string; next: number };
    const succs = (byId.get(top.id) as OptBlock).succs;
    const succ = succs[top.next];
    top.next++;
    if (succ === undefined) {
      postorder.push(top.id);
      stack.pop();
    } else if (!seen.has(succ)) {
      seen.add(succ);
      stack.push({ id: succ, next: 0 });
    }
  }
  return postorder.toReversed();
}
