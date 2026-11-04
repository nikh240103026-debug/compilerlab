import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { irToTac } from './tac-gen';
import { formatTac, type TacInstr } from './types';

// Basic blocks by the leader rules of section 8.4.1, and the flow graph between them:
//
//   1. The first instruction is a leader.
//   2. Any instruction that is the target of a jump is a leader.
//   3. Any instruction right after a jump is a leader.
//
// Labels here are instructions in the list, though they do nothing. Adjacent labels name one spot,
// so they count as one place and stay in one block. Return also ends a block, since control never
// falls through it.

export const MAX_IR_BLOCKS = 300;
export const IR_ENTRY = 'ENTRY';
export const IR_EXIT = 'EXIT';

export type IrLeaderRule = 1 | 2 | 3;

export interface IrLeader {
  /** Where it is in the code. */
  index: number;
  rule: IrLeaderRule;
  reason: string;
}

export interface IrBasicBlock {
  /** B1, B2 and so on, in code order. */
  id: string;
  /** Covers code[start..end). */
  start: number;
  end: number;
  code: TacInstr[];
  text: string[];
  /** The labels at the top of this block. */
  labels: string[];
  rule: IrLeaderRule;
}

export type IrCfgEdgeKind = 'entry' | 'fallthrough' | 'jump' | 'true' | 'false' | 'exit';

export interface IrCfgEdge {
  from: string;
  to: string;
  kind: IrCfgEdgeKind;
}

export interface IrCfg {
  blocks: IrBasicBlock[];
  edges: IrCfgEdge[];
  /** ENTRY, then the blocks in order, then EXIT. */
  nodes: string[];
  successors: Record<string, string[]>;
  predecessors: Record<string, string[]>;
}

export type IrPartitionPhase = 'leaders' | 'blocks' | 'edges' | 'finished';

export interface IrPartitionState {
  phase: IrPartitionPhase;
  /** The instruction this step looked at. */
  instruction: number | null;
  /** Leaders found so far, in code order. */
  leaders: IrLeader[];
  /** The result's blocks[0..blockCount) exist at this step. */
  blockCount: number;
  /** The result's edges[0..edgeCount) exist at this step. */
  edgeCount: number;
}

export interface IrPartitionResult {
  code: TacInstr[];
  text: string[];
  leaders: IrLeader[];
  cfg: IrCfg;
  trace: Trace<IrPartitionState>;
}

/** Splits code into basic blocks and connects them, with a step for each decision. */
export function irPartitionBlocks(code: readonly TacInstr[]): IrPartitionResult {
  const recorder = new TraceRecorder<IrPartitionState>();
  const text = code.map(formatTac);

  const labelAt = new Map<string, number>();
  code.forEach((instr, index) => {
    if (instr.op !== 'label') return;
    if (labelAt.has(instr.name)) {
      throw new EngineError({
        code: 'ir_bad_code',
        message: `The label ${instr.name} is defined twice.`,
        hint: 'Each label marks one place.',
      });
    }
    labelAt.set(instr.name, index);
  });
  const targetIndex = (label: string): number => {
    const index = labelAt.get(label);
    if (index === undefined) {
      throw new EngineError({
        code: 'ir_bad_code',
        message: `A jump goes to ${label}, but that label is not in the code.`,
        hint: 'Every jump target needs a matching label.',
      });
    }
    return index;
  };
  const runStart = (index: number): number => {
    let at = index;
    while (at > 0 && code[at - 1]?.op === 'label') at--;
    return at;
  };

  // ------ Leaders ------
  const leaders = new Map<number, IrLeader>();
  const leaderList = (): IrLeader[] => [...leaders.values()].toSorted((a, b) => a.index - b.index);
  const addLeader = (index: number, rule: IrLeaderRule, reason: string, from: number): void => {
    if (leaders.has(index)) {
      recorder.add(
        `Instruction ${from}`,
        `${reason} Instruction ${index} is already a leader, so nothing changes.`,
        { phase: 'leaders', instruction: from, leaders: leaderList(), blockCount: 0, edgeCount: 0 },
      );
      return;
    }
    const leader: IrLeader = { index, rule, reason };
    leaders.set(index, leader);
    recorder.add(`Leader: instruction ${index}`, `Rule ${rule}. ${reason}`, {
      phase: 'leaders',
      instruction: from,
      leaders: leaderList(),
      blockCount: 0,
      edgeCount: 0,
    });
  };

  if (code.length > 0) addLeader(0, 1, 'The first instruction always starts a block.', 0);
  code.forEach((instr, index) => {
    const isJump = instr.op === 'goto' || instr.op === 'if';
    if (isJump) {
      const target = runStart(targetIndex(instr.target));
      addLeader(
        target,
        2,
        `${formatTac(instr)} can jump to ${instr.target}, so instruction ${target} starts a block.`,
        index,
      );
    }
    if ((isJump || instr.op === 'return') && index + 1 < code.length) {
      addLeader(
        index + 1,
        3,
        `Instruction ${index} is ${instr.op === 'return' ? 'a return' : 'a jump'}, so the one after it starts a block.`,
        index,
      );
    }
  });

  // ------ Blocks ------
  const sorted = leaderList();
  if (sorted.length > MAX_IR_BLOCKS) {
    throw new EngineError({
      code: 'ir_too_long',
      message: `This code has more than ${MAX_IR_BLOCKS} basic blocks.`,
      hint: 'Try a shorter program.',
    });
  }
  const blocks: IrBasicBlock[] = [];
  const blockOfLabel = new Map<string, string>();
  sorted.forEach((leader, position) => {
    const start = leader.index;
    const end = sorted[position + 1]?.index ?? code.length;
    const id = `B${position + 1}`;
    const slice = code.slice(start, end);
    const labels: string[] = [];
    for (const instr of slice) {
      if (instr.op !== 'label') break;
      labels.push(instr.name);
    }
    for (const instr of slice) {
      if (instr.op === 'label') blockOfLabel.set(instr.name, id);
    }
    blocks.push({
      id,
      start,
      end,
      code: slice,
      text: text.slice(start, end),
      labels,
      rule: leader.rule,
    });
    recorder.add(
      `Block ${id}`,
      `${id} runs from its leader, instruction ${start}, up to ${end < code.length ? `the next leader, instruction ${end}` : 'the end of the code'}. Control enters only at the top and leaves only at the bottom.`,
      {
        phase: 'blocks',
        instruction: start,
        leaders: sorted,
        blockCount: blocks.length,
        edgeCount: 0,
      },
    );
  });

  // ------ Edges ------
  const edges: IrCfgEdge[] = [];
  const addEdge = (
    from: string,
    to: string,
    kind: IrCfgEdgeKind,
    why: string,
    instruction: number | null,
  ): void => {
    edges.push({ from, to, kind });
    recorder.add(`${from} → ${to}`, why, {
      phase: 'edges',
      instruction,
      leaders: sorted,
      blockCount: blocks.length,
      edgeCount: edges.length,
    });
  };
  addEdge(
    IR_ENTRY,
    blocks[0]?.id ?? IR_EXIT,
    'entry',
    blocks.length > 0
      ? 'Control enters the program at the first block.'
      : 'There is no code, so control goes straight to the exit.',
    null,
  );
  blocks.forEach((block, position) => {
    const last = block.code.at(-1) as TacInstr;
    const lastIndex = block.end - 1;
    const following = blocks[position + 1]?.id ?? IR_EXIT;
    if (last.op === 'goto') {
      addEdge(
        block.id,
        blockOfLabel.get(last.target) as string,
        'jump',
        `${block.id} ends with ${formatTac(last)}, so control always goes to the block with ${last.target}.`,
        lastIndex,
      );
    } else if (last.op === 'if') {
      const jumpKind = last.negate ? 'false' : 'true';
      addEdge(
        block.id,
        blockOfLabel.get(last.target) as string,
        jumpKind,
        `${block.id} ends with ${formatTac(last)}. When the test is ${jumpKind}, control jumps to the block with ${last.target}.`,
        lastIndex,
      );
      addEdge(
        block.id,
        following,
        last.negate ? 'true' : 'false',
        `When the test is ${last.negate ? 'true' : 'false'}, control falls through to ${following}.`,
        lastIndex,
      );
    } else if (last.op === 'return') {
      addEdge(
        block.id,
        IR_EXIT,
        'exit',
        `${block.id} ends with a return, so control leaves the program.`,
        lastIndex,
      );
    } else {
      addEdge(
        block.id,
        following,
        following === IR_EXIT ? 'exit' : 'fallthrough',
        following === IR_EXIT
          ? `${block.id} is the last block and has no jump, so control leaves the program.`
          : `${block.id} has no jump at its end, so control falls through to ${following}.`,
        lastIndex,
      );
    }
  });

  const nodes = [IR_ENTRY, ...blocks.map((block) => block.id), IR_EXIT];
  const successors = new Map<string, string[]>(nodes.map((node) => [node, []]));
  const predecessors = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const { from, to } of edges) {
    const out = successors.get(from) as string[];
    const incoming = predecessors.get(to) as string[];
    if (!out.includes(to)) out.push(to);
    if (!incoming.includes(from)) incoming.push(from);
  }

  recorder.add(
    'Finished',
    `${code.length} instruction${code.length === 1 ? '' : 's'} became ${blocks.length} basic block${blocks.length === 1 ? '' : 's'}, joined by ${edges.length} edge${edges.length === 1 ? '' : 's'}, counting ENTRY and EXIT.`,
    {
      phase: 'finished',
      instruction: null,
      leaders: sorted,
      blockCount: blocks.length,
      edgeCount: edges.length,
    },
  );

  return {
    code: code.slice(),
    text,
    leaders: sorted,
    cfg: {
      blocks,
      edges,
      nodes,
      successors: Object.fromEntries(successors),
      predecessors: Object.fromEntries(predecessors),
    },
    trace: recorder.finish(),
  };
}

/** Translates source text to three-address code, then partitions that code. */
export function irSourceToCfg(source: string): IrPartitionResult {
  return irPartitionBlocks(irToTac(source).code);
}
