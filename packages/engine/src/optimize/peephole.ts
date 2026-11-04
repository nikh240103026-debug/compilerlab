import { formatTacOperand, type TacInstr, type TacOperand } from '../ir/types';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optIsTempName } from './tac-text';
import { optDefOf, optToInstrs, optUsesOf } from './tac-util';

// A peephole pass looks at a small window of adjacent lines and rewrites it. Each pattern is small,
// but they feed each other, so the pass repeats until none of them fires.

const isConst = (operand: TacOperand, value: number) =>
  operand.kind === 'const' && operand.value === value;

const sameOperand = (a: TacOperand, b: TacOperand) =>
  a.kind === b.kind && formatTacOperand(a) === formatTacOperand(b);

/** Index of the first non-label line at or after `index`. */
function skipLabels(instrs: readonly TacInstr[], index: number): number {
  let at = index;
  while (instrs[at]?.op === 'label') at++;
  return at;
}

/** The first real line control reaches after jumping to this label. */
function landingOf(instrs: readonly TacInstr[], name: string): TacInstr | undefined {
  const at = instrs.findIndex((instr) => instr.op === 'label' && instr.name === name);
  return at === -1 ? undefined : instrs[skipLabels(instrs, at)];
}

/** False for a cycle of gotos, where shortening jumps would go around forever. */
function chainEnds(instrs: readonly TacInstr[], start: string): boolean {
  const seen = new Set<string>();
  let label = start;
  while (!seen.has(label)) {
    seen.add(label);
    const landing = landingOf(instrs, label);
    if (landing?.op !== 'goto') return true;
    label = landing.target;
  }
  return false;
}

/** True if `name` is one of the labels sitting directly after `index`. */
function labelFollows(instrs: readonly TacInstr[], index: number, name: string): boolean {
  for (let at = index + 1; ; at++) {
    const instr = instrs[at];
    if (instr?.op !== 'label') return false;
    if (instr.name === name) return true;
  }
}

/** Algebra that holds for any value of the other operand. Null when nothing applies. */
function simplify(instr: TacInstr): { replacement: TacInstr; why: string } | null {
  if (instr.op !== 'binary') return null;
  const { dest, operator, left, right } = instr;
  const copyOf = (src: TacOperand): TacInstr => ({ op: 'assign', dest, src });
  const zero = copyOf({ kind: 'const', value: 0 });
  const shown = `${formatTacOperand(left)} ${operator} ${formatTacOperand(right)}`;

  if (operator === '+' && isConst(right, 0)) {
    return {
      replacement: copyOf(left),
      why: `Adding 0 changes nothing, so ${shown} is just its left operand.`,
    };
  }
  if (operator === '+' && isConst(left, 0)) {
    return {
      replacement: copyOf(right),
      why: `Adding 0 changes nothing, so ${shown} is just its right operand.`,
    };
  }
  if (operator === '-' && isConst(right, 0)) {
    return {
      replacement: copyOf(left),
      why: `Subtracting 0 changes nothing, so ${shown} is just its left operand.`,
    };
  }
  if (operator === '*' && isConst(right, 1)) {
    return {
      replacement: copyOf(left),
      why: `Multiplying by 1 changes nothing, so ${shown} is just its left operand.`,
    };
  }
  if (operator === '*' && isConst(left, 1)) {
    return {
      replacement: copyOf(right),
      why: `Multiplying by 1 changes nothing, so ${shown} is just its right operand.`,
    };
  }
  if (operator === '/' && isConst(right, 1)) {
    return {
      replacement: copyOf(left),
      why: `Dividing by 1 changes nothing, so ${shown} is just its left operand.`,
    };
  }
  if (operator === '*' && (isConst(left, 0) || isConst(right, 0))) {
    return { replacement: zero, why: `Anything times 0 is 0, so ${shown} is 0.` };
  }
  if (operator === '%' && isConst(right, 1)) {
    return {
      replacement: zero,
      why: `Any integer leaves remainder 0 when divided by 1, so ${shown} is 0.`,
    };
  }
  if (operator === '-' && left.kind !== 'const' && sameOperand(left, right)) {
    return { replacement: zero, why: `A value minus itself is 0, so ${shown} is 0.` };
  }
  return null;
}

/** Applies the first rule that matches anywhere. Returns false once none do. */
function applyOneRule(run: OptPassRun): boolean {
  const instrs = run.instrs;

  const targeted = new Set<string>();
  const useCount = new Map<string, number>();
  const defCount = new Map<string, number>();
  for (const instr of instrs) {
    if (instr.op === 'goto' || instr.op === 'if') targeted.add(instr.target);
    for (const name of optUsesOf(instr)) useCount.set(name, (useCount.get(name) ?? 0) + 1);
    const def = optDefOf(instr);
    if (def !== null) defCount.set(def, (defCount.get(def) ?? 0) + 1);
  }

  for (let index = 0; index < instrs.length; index++) {
    const instr = instrs[index] as TacInstr;
    const next = instrs[index + 1];

    if (instr.op === 'if' && instr.cond.kind === 'const') {
      const taken = (instr.cond.value !== 0) !== (instr.negate === true);
      if (taken) {
        run.replace(
          index,
          { op: 'goto', target: instr.target },
          `The condition is the constant ${instr.cond.value}, so this jump is always taken.`,
        );
      } else {
        run.remove(
          index,
          `The condition is the constant ${instr.cond.value}, so this jump is never taken.`,
        );
      }
      return true;
    }

    if (instr.op === 'goto' || instr.op === 'if') {
      if (labelFollows(instrs, index, instr.target)) {
        run.remove(
          index,
          `This jumps to ${instr.target}, which is the very next line. Control gets there anyway.`,
        );
        return true;
      }
      const landing = landingOf(instrs, instr.target);
      if (
        landing?.op === 'goto' &&
        landing.target !== instr.target &&
        chainEnds(instrs, landing.target)
      ) {
        run.replace(
          index,
          { ...instr, target: landing.target },
          `${instr.target} only jumps on to ${landing.target}, so go straight there and skip the extra jump.`,
        );
        return true;
      }
    }

    // if c goto L1; goto L2; L1:   becomes   ifFalse c goto L2; L1:
    if (instr.op === 'if' && next?.op === 'goto' && labelFollows(instrs, index + 1, instr.target)) {
      const inverted: TacInstr = instr.negate
        ? { op: 'if', cond: instr.cond, target: next.target }
        : { op: 'if', cond: instr.cond, target: next.target, negate: true };
      run.replace(
        index,
        inverted,
        `The conditional only jumps over a goto. Testing the opposite condition makes the goto unnecessary.`,
      );
      run.remove(index + 1, `The inverted test above does this jump now.`);
      return true;
    }

    if (
      (instr.op === 'goto' || instr.op === 'return') &&
      next !== undefined &&
      next.op !== 'label'
    ) {
      run.remove(
        index + 1,
        `This line follows an unconditional ${instr.op} and has no label, so nothing can reach it.`,
      );
      return true;
    }

    if (instr.op === 'label' && !targeted.has(instr.name)) {
      run.remove(index, `Nothing jumps to ${instr.name}, so the label does nothing.`);
      return true;
    }

    const algebra = simplify(instr);
    if (algebra) {
      run.replace(index, algebra.replacement, algebra.why);
      return true;
    }

    if (instr.op === 'assign' && instr.src.kind !== 'const' && instr.src.name === instr.dest) {
      run.remove(index, `${instr.dest} = ${instr.dest} changes nothing.`);
      return true;
    }

    if (
      instr.op === 'assign' &&
      instr.src.kind !== 'const' &&
      next?.op === 'assign' &&
      next.src.kind !== 'const' &&
      next.src.name === instr.dest &&
      next.dest === instr.src.name
    ) {
      run.remove(
        index + 1,
        `The line above just made ${next.dest} and ${next.src.name} equal, so copying back changes nothing.`,
      );
      return true;
    }

    // t = a + b; x = t   becomes   x = a + b, when nothing else needs t.
    if (next?.op === 'assign' && next.src.kind !== 'const') {
      const def = optDefOf(instr);
      if (
        def !== null &&
        def === next.src.name &&
        optIsTempName(def) &&
        useCount.get(def) === 1 &&
        defCount.get(def) === 1
      ) {
        run.replace(
          index,
          { ...instr, dest: next.dest } as TacInstr,
          `${def} exists only to be copied into ${next.dest} on the next line, so compute into ${next.dest} directly.`,
        );
        run.remove(index + 1, `The line above now assigns ${next.dest} itself.`);
        return true;
      }
    }
  }
  return false;
}

/** Jump cleanup, unreachable lines, algebra and redundant copies, in small windows of code. */
export function optPeephole(input: string | readonly TacInstr[]): OptPassResult {
  const run = new OptPassRun(
    'peephole',
    optToInstrs(input),
    'Slide a small window over the code and replace short patterns with something shorter or simpler. One rewrite often exposes the next, so this repeats until nothing matches.',
  );
  // Every rule shortens the code or removes a jump hop, so this ends well before the limit.
  for (let round = 0; round < 2000; round++) {
    if (!applyOneRule(run)) break;
  }
  return run.finish('No pattern matches anywhere in this code.');
}
