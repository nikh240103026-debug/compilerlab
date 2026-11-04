import { EngineError } from '../core/result';
import { formatTac, formatTacOperand, type TacInstr, type TacOperand } from '../ir/types';
import { MAX_TAC_LINES, optIsTempName, optParseTac } from './tac-text';

/** The name an instruction assigns, if any. A store changes array contents, not a scalar name. */
export function optDefOf(instr: TacInstr): string | null {
  switch (instr.op) {
    case 'assign':
    case 'binary':
    case 'unary':
    case 'load':
    case 'phi':
      return instr.dest;
    case 'call':
      return instr.dest;
    default:
      return null;
  }
}

/** The operands an instruction reads. Array bases are not included. See optUsesOf. */
export function optOperandsOf(instr: TacInstr): TacOperand[] {
  switch (instr.op) {
    case 'assign':
      return [instr.src];
    case 'binary':
      return [instr.left, instr.right];
    case 'unary':
      return [instr.arg];
    case 'if':
      return [instr.cond];
    case 'param':
      return [instr.arg];
    case 'return':
      return instr.value ? [instr.value] : [];
    case 'load':
      return [instr.index];
    case 'store':
      return [instr.index, instr.src];
    case 'phi':
      return instr.sources.map((source) => source.value);
    default:
      return [];
  }
}

/**
 * Every name an instruction reads. An array base counts as a read, because the array has to
 * stay alive for as long as anything touches it. Liveness therefore treats a[i] as using a.
 */
export function optUsesOf(instr: TacInstr): string[] {
  const names = optOperandsOf(instr).flatMap((operand) =>
    operand.kind === 'const' ? [] : [operand.name],
  );
  if (instr.op === 'load' || instr.op === 'store') names.push(instr.base);
  return [...new Set(names)];
}

/** Rebuilds an instruction with `change` applied to each operand it reads. */
export function optMapOperands(
  instr: TacInstr,
  change: (operand: TacOperand) => TacOperand,
): TacInstr {
  switch (instr.op) {
    case 'assign':
      return { ...instr, src: change(instr.src) };
    case 'binary':
      return { ...instr, left: change(instr.left), right: change(instr.right) };
    case 'unary':
      return { ...instr, arg: change(instr.arg) };
    case 'if':
      return { ...instr, cond: change(instr.cond) };
    case 'param':
      return { ...instr, arg: change(instr.arg) };
    case 'return':
      return instr.value ? { ...instr, value: change(instr.value) } : instr;
    case 'load':
      return { ...instr, index: change(instr.index) };
    case 'store':
      return { ...instr, index: change(instr.index), src: change(instr.src) };
    default:
      return instr;
  }
}

/** a + b and b + a compute the same value, so they share a key. a - b and b - a do not. */
const COMMUTATIVE = new Set(['+', '*', '==', '!=', '&&', '||']);

export function optIsCommutative(operator: string): boolean {
  return COMMUTATIVE.has(operator);
}

/** A key for the value an instruction computes, or null if it does not compute one to reuse. */
export function optExprKey(instr: TacInstr): string | null {
  if (instr.op === 'binary') {
    const left = formatTacOperand(instr.left);
    const right = formatTacOperand(instr.right);
    const swap = optIsCommutative(instr.operator) && right < left;
    return swap ? `${right} ${instr.operator} ${left}` : `${left} ${instr.operator} ${right}`;
  }
  if (instr.op === 'unary') return `${instr.operator}${formatTacOperand(instr.arg)}`;
  if (instr.op === 'load') return `${instr.base}[${formatTacOperand(instr.index)}]`;
  return null;
}

/** The names an expression key depends on: if any of them changes, the value is stale. */
export function optExprOperands(instr: TacInstr): string[] {
  if (instr.op === 'binary' || instr.op === 'unary' || instr.op === 'load') return optUsesOf(instr);
  return [];
}

/** Arrays can alias through reference parameters, so a store or a call may change any of them. */
export function optTouchesMemory(instr: TacInstr): boolean {
  return instr.op === 'store' || instr.op === 'call';
}

/**
 * True when removing or moving this instruction cannot change what the program does, apart from
 * dropping its result. Calls and stores have effects. Division can stop the program with an
 * error, so only a nonzero constant divisor is safe.
 *
 * A dead array read is allowed to go. Its bounds error then disappears too, which is the same
 * freedom C compilers take.
 */
export function optHasNoEffect(instr: TacInstr): boolean {
  switch (instr.op) {
    case 'assign':
    case 'unary':
    case 'load':
      return true;
    case 'binary':
      if (instr.operator === '/' || instr.operator === '%') {
        return instr.right.kind === 'const' && instr.right.value !== 0;
      }
      return true;
    default:
      return false;
  }
}

/** The book's default assumption: program variables may be read after the code, temporaries not. */
export function optDefaultLiveAtExit(instrs: readonly TacInstr[]): string[] {
  const names = new Set<string>();
  for (const instr of instrs) {
    const def = optDefOf(instr);
    if (def !== null) names.add(def);
    for (const use of optUsesOf(instr)) names.add(use);
  }
  return [...names].filter((name) => !optIsTempName(name)).toSorted();
}

/** Every optimizer entry point takes text a student typed, or instructions from an earlier phase. */
export function optToInstrs(input: string | readonly TacInstr[]): TacInstr[] {
  const instrs = typeof input === 'string' ? optParseTac(input) : [...input];
  if (instrs.length > MAX_TAC_LINES) {
    throw new EngineError({
      code: 'tac_too_long',
      message: `This code has more than ${MAX_TAC_LINES} instructions, which is too long to optimize.`,
      hint: 'Try a shorter program.',
    });
  }
  const phi = instrs.find((instr) => instr.op === 'phi');
  if (phi) {
    throw new EngineError({
      code: 'tac_has_phi',
      message: `These passes work on ordinary three-address code, but this has a φ: ${formatTac(phi)}.`,
      hint: 'Use the code from before SSA conversion.',
    });
  }
  return instrs;
}

/** A temporary name not used anywhere in this code. */
export function optFreshTemp(instrs: readonly TacInstr[], taken: Set<string>): string {
  if (taken.size === 0) {
    for (const instr of instrs) {
      const def = optDefOf(instr);
      if (def !== null) taken.add(def);
      for (const use of optUsesOf(instr)) taken.add(use);
    }
  }
  let number = 1;
  while (taken.has(`t${number}`)) number++;
  const name = `t${number}`;
  taken.add(name);
  return name;
}
