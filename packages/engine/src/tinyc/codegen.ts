import { ISA_OPCODE_OF_OPERATOR } from '../codegen/isa';
import { formatTac, type TacInstr, type TacOperand } from '../ir/types';
import { optDefOf, optOperandsOf } from '../optimize/tac-util';
import { TINYC_PRINT_BOOL, TINYC_PRINT_INT, type TinyIr, type TinyIrFunction } from './ir';

export interface TinyCodeRow {
  /** Index into the function's instructions. */
  tacIndex: number;
  tac: string;
  code: string[];
}

export interface TinyCodeFunction {
  name: string;
  /** Cells this function reserves below FP. */
  frameSize: number;
  /** Where each name lives: a negative or positive offset from FP. */
  slots: Record<string, number>;
  rows: TinyCodeRow[];
}

export interface TinyCodegenResult {
  /** The whole program as assembly text, for vmAssemble. */
  assembly: string;
  functions: TinyCodeFunction[];
  /**
   * For each VM instruction, in order: which function and TAC line it came from. A tacIndex of -1
   * means the function's entry. Null means the startup code or the implicit return at a function's end.
   */
  instructionMap: ({ function: string; tacIndex: number } | null)[];
}

/**
 * The frame, once ENTER has run. Addresses grow upward, and the stack grows downward:
 *
 *   FP + 2 + (n - 1 - i)   parameter i of n, pushed left to right, so the first is highest
 *   FP + 1                 return address, pushed by CALL
 *   FP                     the caller's FP, pushed by ENTER
 *   FP - k                 locals and temporaries
 */
function layoutFrame(fn: TinyIrFunction) {
  // No prototype, so a variable named toString is not mistaken for one already placed.
  const slots = Object.create(null) as Record<string, number>;
  const count = fn.params.length;
  fn.params.forEach((param, index) => {
    slots[param] = 2 + (count - 1 - index);
  });

  let frameSize = 0;
  const sizes = new Map<string, number>();
  for (const array of fn.arrays) {
    if (array.size !== null) {
      // Cell 0 is the lowest address of the block, so indexing adds to the base.
      frameSize += array.size;
      slots[array.symbol] = -frameSize;
      sizes.set(array.symbol, array.size);
    }
  }

  const place = (name: string) => {
    if (slots[name] === undefined) {
      frameSize += 1;
      slots[name] = -frameSize;
    }
  };
  for (const instr of fn.instrs) {
    const def = optDefOf(instr);
    if (def !== null) place(def);
    for (const operand of optOperandsOf(instr)) {
      if (operand.kind !== 'const') place(operand.name);
    }
  }
  return { slots, frameSize, sizes };
}

function generateFunction(fn: TinyIrFunction, instructionMap: TinyCodegenResult['instructionMap']) {
  const { slots, frameSize, sizes } = layoutFrame(fn);
  const lines: string[] = [];
  const rows: TinyCodeRow[] = [];
  const isLocalArray = (name: string) => sizes.has(name);

  const memory = (name: string) => `${slots[name] as number}(FP)`;
  const label = (name: string) => `${fn.name}.${name}`;

  const load = (register: string, operand: TacOperand) =>
    operand.kind === 'const'
      ? `LD ${register}, #${operand.value}`
      : `LD ${register}, ${memory(operand.name)}`;

  /** Leaves the cell's address in R2. Uses R1 for the index. */
  const addressOfCell = (base: string, index: TacOperand): string[] => {
    const code = [load('R1', index)];
    if (isLocalArray(base)) {
      code.push(`CHK R1, #${sizes.get(base) as number}`, `LEA R2, ${memory(base)}`);
    } else {
      // The size of an array parameter belongs to the caller, so only memory bounds apply.
      code.push(`LD R2, ${memory(base)}`);
    }
    code.push('ADD R2, R2, R1');
    return code;
  };

  const translate = (instr: TacInstr): string[] => {
    switch (instr.op) {
      case 'assign':
        return [load('R1', instr.src), `ST ${memory(instr.dest)}, R1`];
      case 'binary': {
        const opcode = ISA_OPCODE_OF_OPERATOR[instr.operator];
        if (instr.right.kind === 'const') {
          return [
            load('R1', instr.left),
            `${opcode} R1, R1, #${instr.right.value}`,
            `ST ${memory(instr.dest)}, R1`,
          ];
        }
        return [
          load('R1', instr.left),
          load('R2', instr.right),
          `${opcode} R1, R1, R2`,
          `ST ${memory(instr.dest)}, R1`,
        ];
      }
      case 'unary':
        return [
          load('R1', instr.arg),
          `${instr.operator === '-' ? 'NEG' : 'NOT'} R1, R1`,
          `ST ${memory(instr.dest)}, R1`,
        ];
      case 'load':
        return [
          ...addressOfCell(instr.base, instr.index),
          'LD R3, *R2',
          `ST ${memory(instr.dest)}, R3`,
        ];
      case 'store':
        return [load('R3', instr.src), ...addressOfCell(instr.base, instr.index), 'ST *R2, R3'];
      case 'label':
        return [`${label(instr.name)}:`];
      case 'goto':
        return [`BR ${label(instr.target)}`];
      case 'if':
        return [
          load('R1', instr.cond),
          `${instr.negate ? 'BEQZ' : 'BNEZ'} R1, ${label(instr.target)}`,
        ];
      case 'param':
        if (instr.arg.kind === 'const') return [`PUSH #${instr.arg.value}`];
        if (isLocalArray(instr.arg.name)) {
          return [`LEA R1, ${memory(instr.arg.name)}`, 'PUSH R1'];
        }
        return [load('R1', instr.arg), 'PUSH R1'];
      case 'call': {
        if (instr.name === TINYC_PRINT_INT) return ['PRINT'];
        if (instr.name === TINYC_PRINT_BOOL) return ['PRINTB'];
        const code = [`CALL ${instr.name}`];
        if (instr.argCount > 0) code.push(`ADD SP, SP, #${instr.argCount}`);
        if (instr.dest) code.push(`ST ${memory(instr.dest)}, R0`);
        return code;
      }
      case 'return': {
        const code = instr.value ? [load('R0', instr.value)] : [];
        code.push('LEAVE', 'RET');
        return code;
      }
      case 'phi':
        return [];
    }
  };

  lines.push(`${fn.name}:`, `ENTER ${frameSize}`);
  // A tacIndex of -1 means the function's entry, which is where a stack overflow shows up.
  instructionMap.push({ function: fn.name, tacIndex: -1 });

  fn.instrs.forEach((instr, tacIndex) => {
    const code = translate(instr);
    rows.push({ tacIndex, tac: formatTac(instr), code });
    lines.push(...code);
    for (const line of code) {
      if (!line.endsWith(':')) instructionMap.push({ function: fn.name, tacIndex });
    }
  });

  // Falling off the end must return, or control would run on into the next function. This also
  // catches a label at the very end of the code, after an if whose branches both return.
  const last = fn.instrs.at(-1);
  if (last?.op !== 'return' && last?.op !== 'goto') {
    lines.push('LEAVE', 'RET');
    instructionMap.push(null, null);
  }

  return { lines, info: { name: fn.name, frameSize, slots, rows } };
}

/** Stage 6: assembly for the teaching VM. Every name gets a frame slot, and rows map back to TAC. */
export function tinycCodegen(ir: TinyIr): TinyCodegenResult {
  const instructionMap: TinyCodegenResult['instructionMap'] = [null, null];
  const lines = ['; Startup: run main, then stop.', 'CALL main', 'HALT', ''];
  const functions: TinyCodeFunction[] = [];
  for (const fn of ir.functions) {
    const { lines: code, info } = generateFunction(fn, instructionMap);
    lines.push(`; ---- ${fn.name} ----`, ...code, '');
    functions.push(info);
  }
  return { assembly: lines.join('\n'), functions, instructionMap };
}
