import { formatTacOperand, type TacInstr, type TacOperand } from '../ir/types';
import { vmEvalBinary, vmEvalUnary } from '../vm/arith';
import { OPT_ENTRY, optBuildCfg, optReversePostorder, type OptBlock, type OptCfg } from './cfg';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optDefOf, optMapOperands, optToInstrs, optUsesOf } from './tac-util';

// Constant propagation over the whole flow graph, on the book's lattice. Each name is a constant
// or "not a constant" (NAC). A block not visited yet says nothing, which is the lattice's top.

type Value = number | 'nac';
type Env = Map<string, Value>;

function meetInto(target: Env, other: ReadonlyMap<string, Value>): void {
  for (const [name, value] of other) {
    const existing = target.get(name);
    if (existing !== undefined && existing !== value) target.set(name, 'nac');
  }
}

function operandValue(operand: TacOperand, env: ReadonlyMap<string, Value>): Value {
  return operand.kind === 'const' ? operand.value : (env.get(operand.name) ?? 'nac');
}

function applyInstr(instr: TacInstr, env: Env): void {
  const def = optDefOf(instr);
  if (def === null) return;
  let value: Value = 'nac';
  if (instr.op === 'assign') {
    value = operandValue(instr.src, env);
  } else if (instr.op === 'unary') {
    const arg = operandValue(instr.arg, env);
    if (arg !== 'nac') value = vmEvalUnary(instr.operator, arg);
  } else if (instr.op === 'binary') {
    const left = operandValue(instr.left, env);
    const right = operandValue(instr.right, env);
    if (left !== 'nac' && right !== 'nac') {
      value = vmEvalBinary(instr.operator, left, right) ?? 'nac';
    }
  }
  env.set(def, value);
}

/** Solves for the value of every name at the start of each block. Null means unreachable. */
function solveConstants(cfg: OptCfg, instrs: readonly TacInstr[]): Map<string, Env | null> {
  // Names read before they are set hold unknown input, so everything starts as NAC at ENTRY.
  const startingEnv: Env = new Map();
  for (const instr of instrs) {
    const def = optDefOf(instr);
    if (def !== null) startingEnv.set(def, 'nac');
    for (const name of optUsesOf(instr)) startingEnv.set(name, 'nac');
  }

  const byId = new Map<string, OptBlock>(cfg.blocks.map((block) => [block.id, block]));
  const order = optReversePostorder(cfg);
  const outEnvs = new Map<string, Env>([[OPT_ENTRY, startingEnv]]);
  const inEnvs = new Map<string, Env | null>(cfg.blocks.map((block) => [block.id, null]));

  // A value only moves from constant to NAC, so at most two changes per name per block.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      if (id === OPT_ENTRY) continue;
      const block = byId.get(id) as OptBlock;
      let incoming: Env | null = null;
      for (const pred of block.preds) {
        const out = outEnvs.get(pred);
        if (!out) continue;
        if (incoming) meetInto(incoming, out);
        else incoming = new Map(out);
      }
      if (!incoming) continue;
      inEnvs.set(id, new Map(incoming));
      for (const instr of block.instrs) applyInstr(instr, incoming);
      const previous = outEnvs.get(id);
      const differs =
        !previous || [...incoming].some(([name, value]) => previous.get(name) !== value);
      if (differs) {
        outEnvs.set(id, incoming);
        changed = true;
      }
    }
  }
  return inEnvs;
}

/** Replaces names known to be constant, then evaluates whatever became computable. */
export function optConstantFolding(input: string | readonly TacInstr[]): OptPassResult {
  const instrs = optToInstrs(input);
  const run = new OptPassRun(
    'constant-folding',
    instrs,
    'Work out which names hold a known constant at each point, on every path. Replace those names with their values, then evaluate any operation whose operands are all constants.',
  );
  const cfg = optBuildCfg(instrs);
  const inEnvs = solveConstants(cfg, instrs);
  const removals: { index: number; reason: string }[] = [];

  for (const block of cfg.blocks) {
    const env = inEnvs.get(block.id);
    if (!env) continue;
    block.instrs.forEach((_, offset) => {
      const index = block.start + offset;
      let instr = run.instrs[index] as TacInstr;

      const known: string[] = [];
      const propagated = optMapOperands(instr, (operand) => {
        if (operand.kind === 'const') return operand;
        const value = env.get(operand.name);
        if (typeof value !== 'number') return operand;
        known.push(`${operand.name} = ${value}`);
        return { kind: 'const', value };
      });
      if (known.length > 0) {
        run.replace(
          index,
          propagated,
          `On every path reaching here, ${[...new Set(known)].join(' and ')}, so the constant can replace the name.`,
        );
        instr = propagated;
      }

      if (instr.op === 'binary' && instr.left.kind === 'const' && instr.right.kind === 'const') {
        const shown = `${formatTacOperand(instr.left)} ${instr.operator} ${formatTacOperand(instr.right)}`;
        const value = vmEvalBinary(instr.operator, instr.left.value, instr.right.value);
        if (value !== null) {
          instr = { op: 'assign', dest: instr.dest, src: { kind: 'const', value } };
          run.replace(index, instr, `${shown} can be computed now: it is always ${value}.`);
        }
      } else if (instr.op === 'unary' && instr.arg.kind === 'const') {
        const value = vmEvalUnary(instr.operator, instr.arg.value);
        const shown = `${instr.operator}${instr.arg.value}`;
        instr = { op: 'assign', dest: instr.dest, src: { kind: 'const', value } };
        run.replace(index, instr, `${shown} can be computed now: it is always ${value}.`);
      } else if (instr.op === 'if' && instr.cond.kind === 'const') {
        const taken = (instr.cond.value !== 0) !== (instr.negate === true);
        if (taken) {
          run.replace(
            index,
            { op: 'goto', target: instr.target },
            `The condition is always ${instr.cond.value}, so this jump is always taken.`,
          );
        } else {
          removals.push({
            index,
            reason: `The condition is always ${instr.cond.value}, so this jump is never taken.`,
          });
        }
      }

      // Walk with the original instruction, so values match what the solver assumed.
      applyInstr(block.instrs[offset] as TacInstr, env);
    });
  }

  for (const { index, reason } of removals.toReversed()) run.remove(index, reason);
  return run.finish('No name holds a known constant where it is read, so nothing changes.');
}
