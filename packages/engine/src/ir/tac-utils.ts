import type { TacInstr, TacOperand } from './types';

// What each instruction defines and uses. Private to this folder: these names are too general to
// export from the package.

/** The name an instruction assigns to, if it assigns to one. An array store changes memory instead. */
export function tacDefinedName(instr: TacInstr): string | null {
  switch (instr.op) {
    case 'assign':
    case 'binary':
    case 'unary':
    case 'load':
    case 'phi':
    case 'call':
      return instr.dest;
    default:
      return null;
  }
}

/** The operands an instruction reads. */
export function tacUsedOperands(instr: TacInstr): TacOperand[] {
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
    case 'call':
    case 'label':
    case 'goto':
      return [];
  }
}

/** A copy of an instruction with its uses and its definition renamed. Uses are done first. */
export function tacRename(
  instr: TacInstr,
  use: (operand: TacOperand) => TacOperand,
  define: (name: string) => string,
): TacInstr {
  switch (instr.op) {
    case 'assign': {
      const src = use(instr.src);
      return { ...instr, src, dest: define(instr.dest) };
    }
    case 'binary': {
      const left = use(instr.left);
      const right = use(instr.right);
      return { ...instr, left, right, dest: define(instr.dest) };
    }
    case 'unary': {
      const arg = use(instr.arg);
      return { ...instr, arg, dest: define(instr.dest) };
    }
    case 'load': {
      const index = use(instr.index);
      return { ...instr, index, dest: define(instr.dest) };
    }
    case 'store':
      return { ...instr, index: use(instr.index), src: use(instr.src) };
    case 'if':
      return { ...instr, cond: use(instr.cond) };
    case 'param':
      return { ...instr, arg: use(instr.arg) };
    case 'return':
      return instr.value ? { ...instr, value: use(instr.value) } : instr;
    case 'call':
      return instr.dest ? { ...instr, dest: define(instr.dest) } : instr;
    case 'label':
    case 'goto':
    case 'phi':
      return instr;
  }
}
