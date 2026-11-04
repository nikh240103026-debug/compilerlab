import type { TacInstr, TacOperand } from '../ir/types';
import { vmEvalBinary } from '../vm/arith';
import { optBuildCfg, type OptBlock, type OptCfg } from './cfg';
import { optFindLoops, type LoopNatural } from './loops';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optInsertIntoPreheader } from './preheader';
import { optOperandOfName } from './tac-text';
import { optDefOf, optFreshTemp, optToInstrs } from './tac-util';

interface LoopLine {
  index: number;
  instr: TacInstr;
}

function loopLines(cfg: OptCfg, loop: LoopNatural): LoopLine[] {
  const inLoop = new Set(loop.blocks);
  const lines: LoopLine[] = [];
  for (const block of cfg.blocks) {
    if (!inLoop.has(block.id)) continue;
    block.instrs.forEach((instr, offset) => {
      lines.push({ index: block.start + offset, instr });
    });
  }
  return lines;
}

/** The step of a basic induction variable's update: i = i + c, i = c + i, or i = i - c. */
function stepOf(instr: TacInstr, name: string): number | null {
  if (instr.op !== 'binary' || instr.dest !== name) return null;
  const { operator, left, right } = instr;
  const isName = (operand: TacOperand) => operand.kind !== 'const' && operand.name === name;
  if (operator === '+' && isName(left) && right.kind === 'const') return right.value;
  if (operator === '+' && isName(right) && left.kind === 'const') return left.value;
  if (operator === '-' && isName(left) && right.kind === 'const') return -right.value | 0;
  return null;
}

interface Multiply {
  line: LoopLine;
  variable: TacOperand & { name: string };
  factor: number;
}

function multiplyOf(line: LoopLine): Multiply | null {
  const { instr } = line;
  if (instr.op !== 'binary' || instr.operator !== '*') return null;
  if (instr.left.kind === 'const' && instr.right.kind !== 'const') {
    return { line, variable: instr.right, factor: instr.left.value };
  }
  if (instr.right.kind === 'const' && instr.left.kind !== 'const') {
    return { line, variable: instr.left, factor: instr.right.value };
  }
  return null;
}

/**
 * Finds t = c * i in the loop, where i changes exactly once per trip by a constant. A new
 * temporary s then tracks c * i: it starts as c * i before the loop, and whenever i changes by n,
 * s changes by c * n. So t = c * i can become the copy t = s, and the multiply is gone from the
 * loop. Wrapping 32-bit arithmetic keeps s and c * i equal even if they overflow.
 */
function reduceInLoop(
  run: OptPassRun,
  cfg: OptCfg,
  loop: LoopNatural,
  taken: Set<string>,
): boolean {
  const lines = loopLines(cfg, loop);
  const candidate = lines.flatMap((line) => {
    const multiply = multiplyOf(line);
    if (!multiply) return [];
    if (optDefOf(line.instr) === multiply.variable.name) return [];
    const defs = lines.filter((other) => optDefOf(other.instr) === multiply.variable.name);
    if (defs.length !== 1) return [];
    const update = defs[0] as LoopLine;
    const step = stepOf(update.instr, multiply.variable.name);
    return step === null ? [] : [{ multiply, update, step }];
  })[0];
  if (!candidate) return false;

  const { update, step } = candidate;
  const { variable, factor } = candidate.multiply;
  const stepProduct = vmEvalBinary('*', factor, step) as number;
  const temp = optFreshTemp(run.instrs, taken);
  const tempOperand = optOperandOfName(temp);

  const sameMultiplies = lines.flatMap((line) => {
    const other = multiplyOf(line);
    return other && other.variable.name === variable.name && other.factor === factor
      ? [line.index]
      : [];
  });

  for (const index of sameMultiplies) {
    const instr = run.instrs[index] as TacInstr;
    run.replace(
      index,
      { op: 'assign', dest: optDefOf(instr) as string, src: tempOperand },
      `${temp} always equals ${factor} * ${variable.name} inside this loop, so the multiply is not needed here.`,
    );
  }

  const add = stepProduct >= 0;
  const magnitude = Math.abs(stepProduct);
  run.insert(
    update.index + 1,
    {
      op: 'binary',
      dest: temp,
      operator: add ? '+' : '-',
      left: tempOperand,
      right: { kind: 'const', value: magnitude },
    },
    `${variable.name} just changed by ${step}, so ${factor} * ${variable.name} changes by ${stepProduct}. Adding is cheaper than multiplying.`,
  );

  // Rebuild, since the insert moved lines, then find this same loop again by its header label.
  const firstOf = (flow: OptCfg, id: string) =>
    (flow.blocks.find((block) => block.id === id) as OptBlock).instrs[0];
  const headerFirst = firstOf(cfg, loop.header);
  const updated = optBuildCfg(run.instrs);
  const same = optFindLoops(updated).loops.find((other) => {
    const first = firstOf(updated, other.header);
    return first?.op === 'label' && headerFirst?.op === 'label' && first.name === headerFirst.name;
  }) as LoopNatural;
  optInsertIntoPreheader(run, updated, same, [
    {
      instr: {
        op: 'binary',
        dest: temp,
        operator: '*',
        left: { kind: 'const', value: factor },
        right: variable,
      },
      reason: `${temp} needs its starting value once, before the loop.`,
    },
  ]);
  return true;
}

/** x * 2 becomes x + x, the book's example of a cheaper operation with the same result. */
function reduceDoubling(run: OptPassRun): void {
  run.instrs.forEach((instr, index) => {
    if (instr.op !== 'binary' || instr.operator !== '*') return;
    const operand =
      instr.right.kind === 'const' && instr.right.value === 2 && instr.left.kind !== 'const'
        ? instr.left
        : instr.left.kind === 'const' && instr.left.value === 2 && instr.right.kind !== 'const'
          ? instr.right
          : null;
    if (operand) {
      run.replace(
        index,
        { op: 'binary', dest: instr.dest, operator: '+', left: operand, right: operand },
        'Doubling by adding a value to itself is cheaper than multiplying.',
      );
    }
  });
}

/** Induction-variable strength reduction in loops, then cheaper doubling everywhere. */
export function optStrengthReduction(input: string | readonly TacInstr[]): OptPassResult {
  const run = new OptPassRun(
    'strength-reduction',
    optToInstrs(input),
    'Replace an expensive operation with a cheaper one. In a loop, if i changes by a fixed step each trip, then c * i also changes by a fixed step, so it can be updated by adding rather than recomputed by multiplying.',
  );
  const taken = new Set<string>();
  // Each reduction takes one multiply out of a loop. The limit only guards against a mistake.
  for (let round = 0; round < 100; round++) {
    const cfg = optBuildCfg(run.instrs);
    const loops = optFindLoops(cfg).loops.toSorted((a, b) => a.blocks.length - b.blocks.length);
    if (!loops.some((loop) => reduceInLoop(run, cfg, loop, taken))) break;
  }
  reduceDoubling(run);
  return run.finish('No multiplication here can be replaced by something cheaper.');
}
