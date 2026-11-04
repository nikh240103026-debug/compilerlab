import { TraceRecorder, type Trace } from '../core/trace';
import { IR_ENTRY, IR_EXIT, irPartitionBlocks, type IrCfg } from './cfg';
import { irDominators, type IrDominatorResult } from './dominators';
import { irToTac } from './tac-gen';
import { tacDefinedName, tacRename, tacUsedOperands } from './tac-utils';
import { formatTac, type TacInstr, type TacOperand } from './types';

// SSA form, built the standard way (Cytron et al.). The book introduces SSA in section 6.2.4.
//
//   1. Place phi functions: if a block assigns x, every block in its dominance frontier may see two
//      values of x, so it needs a phi. A phi is itself an assignment, so the step repeats.
//   2. Rename: walk the dominator tree with a stack of names per variable. A definition pushes a
//      new name, a use takes the name on top, and leaving a block pops what it pushed.
//
// Names use subscripts, like x₁, which a program's own identifiers cannot contain. A temporary
// assigned exactly once is already in SSA form, so it keeps its name. Array names stay as they are:
// an array is treated as memory, not as a variable. x₀ means the value x had on entry, for a path
// that reaches a use with no assignment. A name the code never assigns at all stays unchanged.

export interface IrSsaOptions {
  /** Skip a phi when its variable is not live there. The default is minimal SSA, as in the paper. */
  pruned?: boolean;
}

export interface IrSsaPhi {
  block: string;
  variable: string;
}

export interface IrSsaBlockView {
  id: string;
  /** The block's instructions as they stand at this step. */
  text: string[];
}

export interface IrSsaBlock {
  id: string;
  code: TacInstr[];
  text: string[];
}

export type IrSsaPhase = 'analyze' | 'place' | 'rename' | 'finished';

export interface IrSsaState {
  phase: IrSsaPhase;
  block: string | null;
  variable: string | null;
  /** Blocks still to process for this variable, while placing phis. */
  worklist: string[];
  /** Phis placed so far. */
  phis: IrSsaPhi[];
  /** The stack of names for each variable, bottom first, while renaming. */
  stacks: { variable: string; stack: string[] }[];
  blocks: IrSsaBlockView[];
}

export interface IrSsaResult {
  /** The code before conversion. */
  input: TacInstr[];
  cfg: IrCfg;
  dominators: Omit<IrDominatorResult, 'trace'>;
  /** The variables that get versions, with the blocks that assign them. */
  variables: { name: string; defSites: string[] }[];
  phis: IrSsaPhi[];
  blocks: IrSsaBlock[];
  /** All the blocks together, in order. */
  code: TacInstr[];
  text: string[];
  trace: Trace<IrSsaState>;
}

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';

function versionName(variable: string, version: number): string {
  return `${variable}${String(version).replace(/[0-9]/g, (digit) => SUBSCRIPTS[Number(digit)] as string)}`;
}

interface PhiEntry {
  variable: string;
  dest: string;
  kind: 'var' | 'temp';
  sources: Map<string, TacOperand>;
}

interface BlockState {
  id: string;
  predecessors: string[];
  code: TacInstr[];
  phis: PhiEntry[];
}

const UNFILLED: TacOperand = { kind: 'var', name: '?' };

function phiInstr(block: BlockState, phi: PhiEntry): TacInstr {
  return {
    op: 'phi',
    dest: phi.dest,
    sources: block.predecessors.map((predecessor) => ({
      block: predecessor,
      value: phi.sources.get(predecessor) ?? UNFILLED,
    })),
  };
}

/** Labels first, then phis, then everything else, because a phi runs on entry to the block. */
function assembled(block: BlockState): TacInstr[] {
  const firstReal = block.code.findIndex((instr) => instr.op !== 'label');
  const split = firstReal === -1 ? block.code.length : firstReal;
  return [
    ...block.code.slice(0, split),
    ...block.phis.map((phi) => phiInstr(block, phi)),
    ...block.code.slice(split),
  ];
}

/** Standard backward liveness over blocks, only for the variables that get versions. */
function liveInSets(
  blocks: readonly BlockState[],
  cfg: IrCfg,
  tracked: ReadonlySet<string>,
): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  const defs = new Map<string, Set<string>>();
  for (const block of blocks) {
    const used = new Set<string>();
    const defined = new Set<string>();
    for (const instr of block.code) {
      for (const operand of tacUsedOperands(instr)) {
        if (operand.kind !== 'const' && tracked.has(operand.name) && !defined.has(operand.name)) {
          used.add(operand.name);
        }
      }
      const dest = tacDefinedName(instr);
      if (dest !== null && tracked.has(dest)) defined.add(dest);
    }
    uses.set(block.id, used);
    defs.set(block.id, defined);
  }
  const live = new Map<string, Set<string>>(
    blocks.map((block) => [block.id, new Set(uses.get(block.id))]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      const here = live.get(block.id) as Set<string>;
      const defined = defs.get(block.id) as Set<string>;
      for (const successor of cfg.successors[block.id] ?? []) {
        for (const name of live.get(successor) ?? []) {
          if (!defined.has(name) && !here.has(name)) {
            here.add(name);
            changed = true;
          }
        }
      }
    }
  }
  return live;
}

/** Converts three-address code to SSA form, with phi placement and renaming as separate phases. */
export function irToSsa(code: readonly TacInstr[], options: IrSsaOptions = {}): IrSsaResult {
  const { cfg } = irPartitionBlocks(code);
  const analysis = irDominators(cfg);
  const dominators: IrSsaResult['dominators'] = {
    reachable: analysis.reachable,
    unreachable: analysis.unreachable,
    dominators: analysis.dominators,
    idom: analysis.idom,
    tree: analysis.tree,
    frontier: analysis.frontier,
  };
  const recorder = new TraceRecorder<IrSsaState>();

  const blocks: BlockState[] = cfg.blocks
    .filter((block) => dominators.reachable.includes(block.id))
    .map((block) => ({
      id: block.id,
      predecessors: (cfg.predecessors[block.id] ?? []).filter((item) =>
        dominators.reachable.includes(item),
      ),
      code: block.code.slice(),
      phis: [],
    }));
  const blockById = new Map(blocks.map((block) => [block.id, block]));

  // ------ Which names get versions ------
  const defCount = new Map<string, number>();
  const defSites = new Map<string, string[]>();
  const readAsTemp = new Set<string>();
  const readAsVariable = new Set<string>();
  for (const block of blocks) {
    for (const instr of block.code) {
      const dest = tacDefinedName(instr);
      if (dest !== null) {
        defCount.set(dest, (defCount.get(dest) ?? 0) + 1);
        const sites = defSites.get(dest) ?? [];
        if (!sites.includes(block.id)) sites.push(block.id);
        defSites.set(dest, sites);
      }
      for (const operand of tacUsedOperands(instr)) {
        if (operand.kind === 'temp') readAsTemp.add(operand.name);
        if (operand.kind === 'var') readAsVariable.add(operand.name);
      }
    }
  }
  const isTemp = (name: string): boolean =>
    readAsTemp.has(name) || (/^t[0-9]+$/.test(name) && !readAsVariable.has(name));
  const variables = [...defSites.keys()].filter(
    (name) => !(isTemp(name) && defCount.get(name) === 1),
  );
  const tracked = new Set(variables);

  // ------ Steps ------
  const views = new Map<string, IrSsaBlockView>();
  const refreshView = (block: BlockState): void => {
    views.set(block.id, { id: block.id, text: assembled(block).map(formatTac) });
  };
  for (const block of blocks) refreshView(block);
  let phiList: IrSsaPhi[] = [];
  const stacks = new Map<string, string[]>(variables.map((name) => [name, []]));
  const add = (
    title: string,
    explanation: string,
    phase: IrSsaPhase,
    fields: { block?: string | null; variable?: string | null; worklist?: string[] } = {},
  ): void => {
    recorder.add(title, explanation, {
      phase,
      block: fields.block ?? null,
      variable: fields.variable ?? null,
      worklist: fields.worklist ?? [],
      phis: phiList,
      stacks: variables.map((name) => ({
        variable: name,
        stack: (stacks.get(name) as string[]).slice(),
      })),
      blocks: blocks.map((block) => views.get(block.id) as IrSsaBlockView),
    });
  };

  add(
    'Start',
    variables.length > 0
      ? `The blocks and dominance frontiers are ready. ${variables.join(', ')} ${variables.length === 1 ? 'needs' : 'need'} versions. Temporaries assigned once already follow the rule, so they keep their names.`
      : 'Nothing here is assigned more than once in a way that needs versions, so no phi can be needed.',
    'analyze',
  );
  if (dominators.unreachable.length > 0) {
    add(
      'Unreachable code',
      `${dominators.unreachable.join(', ')} can never run, so ${dominators.unreachable.length === 1 ? 'it is' : 'they are'} left out. Unreachable code has no place in the dominator tree.`,
      'analyze',
    );
  }

  // ------ Phi placement, with an iterated dominance frontier ------
  const live = options.pruned ? liveInSets(blocks, cfg, tracked) : null;
  for (const variable of variables) {
    const sites = defSites.get(variable) as string[];
    const worklist = sites.slice();
    const placed = new Set<string>();
    const inWorklist = new Set(worklist);
    add(
      `Place phis for ${variable}`,
      `${variable} is assigned in ${sites.join(', ')}. Each of those blocks goes on the worklist, and its dominance frontier is where another value of ${variable} can meet this one.`,
      'place',
      { variable, worklist: worklist.slice() },
    );
    while (worklist.length > 0) {
      const from = worklist.shift() as string;
      inWorklist.delete(from);
      for (const target of dominators.frontier[from] ?? []) {
        if (target === IR_EXIT || placed.has(target)) continue;
        const block = blockById.get(target) as BlockState;
        if (live && !(live.get(target) as Set<string>).has(variable)) {
          add(
            `Skip ${target}`,
            `${target} is in DF(${from}), but ${variable} is not live on entry to ${target}, so a phi there would never be read. This is pruned SSA, which leaves it out.`,
            'place',
            { block: target, variable, worklist: worklist.slice() },
          );
          continue;
        }
        placed.add(target);
        block.phis.push({
          variable,
          dest: variable,
          kind: isTemp(variable) ? 'temp' : 'var',
          sources: new Map(),
        });
        phiList = [...phiList, { block: target, variable }];
        refreshView(block);
        const addsWork = !sites.includes(target) && !inWorklist.has(target);
        if (addsWork) {
          worklist.push(target);
          inWorklist.add(target);
        }
        add(
          `φ for ${variable} in ${target}`,
          `${target} is in DF(${from}), so two different values of ${variable} can reach it, and it needs a phi.${addsWork ? ` A phi assigns ${variable} too, so ${target} joins the worklist.` : ''}`,
          'place',
          { block: target, variable, worklist: worklist.slice() },
        );
      }
    }
  }

  // ------ Renaming, by a walk of the dominator tree ------
  const counters = new Map<string, number>();
  const newName = (variable: string): string => {
    const version = (counters.get(variable) ?? 0) + 1;
    counters.set(variable, version);
    const name = versionName(variable, version);
    (stacks.get(variable) as string[]).push(name);
    return name;
  };
  const currentName = (variable: string): string =>
    (stacks.get(variable) as string[]).at(-1) ?? versionName(variable, 0);
  const useOperand = (operand: TacOperand): TacOperand =>
    operand.kind !== 'const' && tracked.has(operand.name)
      ? { kind: operand.kind, name: currentName(operand.name) }
      : operand;

  const rename = (node: string): void => {
    const pushed: string[] = [];
    const block = blockById.get(node);
    if (block) {
      for (const phi of block.phis) {
        phi.dest = newName(phi.variable);
        pushed.push(phi.variable);
        refreshView(block);
        add(
          `${phi.dest} in ${node}`,
          `A phi counts as an assignment at the top of the block, so ${phi.variable} gets the new name ${phi.dest}.`,
          'rename',
          { block: node, variable: phi.variable },
        );
      }
      block.code.forEach((instr, index) => {
        if (instr.op === 'label') return;
        const before = formatTac(instr);
        const renamed = tacRename(instr, useOperand, (name) => {
          if (!tracked.has(name)) return name;
          pushed.push(name);
          return newName(name);
        });
        const after = formatTac(renamed);
        if (before === after) return;
        block.code[index] = renamed;
        refreshView(block);
        const dest = tacDefinedName(instr);
        add(
          after,
          `In ${node}, ${before} becomes ${after}. Uses take the name now on top of the stack${dest !== null && tracked.has(dest) ? `, and ${dest} gets a new name, because this assigns to it` : ''}.`,
          'rename',
          { block: node, variable: dest !== null && tracked.has(dest) ? dest : null },
        );
      });
    }
    for (const successor of cfg.successors[node] ?? []) {
      const next = blockById.get(successor);
      if (!next) continue;
      for (const phi of next.phis) {
        const name = currentName(phi.variable);
        phi.sources.set(node, { kind: phi.kind, name });
        refreshView(next);
        add(
          `Fill φ in ${successor}`,
          `${node} is a predecessor of ${successor}. Coming from ${node}, ${phi.variable} has the name ${name}, so that is what the phi in ${successor} takes for this edge.${name === versionName(phi.variable, 0) ? ` No assignment reaches here on this path, so ${name} stands for the value on entry.` : ''}`,
          'rename',
          { block: successor, variable: phi.variable },
        );
      }
    }
    for (const child of dominators.tree[node] ?? []) rename(child);
    if (pushed.length > 0) {
      for (const variable of pushed.toReversed()) (stacks.get(variable) as string[]).pop();
      add(
        `Leave ${node}`,
        `Everything ${node} dominates has been renamed, so the names it pushed are popped: ${[...new Set(pushed)].join(', ')}. Sibling blocks must not see them.`,
        'rename',
        { block: node },
      );
    }
  };
  rename(IR_ENTRY);

  const finalBlocks: IrSsaBlock[] = blocks.map((block) => {
    const blockCode = assembled(block);
    return { id: block.id, code: blockCode, text: blockCode.map(formatTac) };
  });
  const finalCode = finalBlocks.flatMap((block) => block.code);
  add(
    'Finished',
    `Every assignment now has its own name. ${phiList.length} phi${phiList.length === 1 ? '' : 's'} joined values where paths meet.`,
    'finished',
  );

  return {
    input: code.slice(),
    cfg,
    dominators,
    variables: variables.map((name) => ({ name, defSites: defSites.get(name) as string[] })),
    phis: phiList,
    blocks: finalBlocks,
    code: finalCode,
    text: finalCode.map(formatTac),
    trace: recorder.finish(),
  };
}

/** Translates source text to three-address code, then converts that code to SSA form. */
export function irSourceToSsa(source: string, options: IrSsaOptions = {}): IrSsaResult {
  return irToSsa(irToTac(source).code, options);
}
