// The teaching instruction set. It follows the target machine in the book's Chapter 8: three-address
// operations, and load and store with the book's addressing modes. The same text runs on the VM.
//
// Registers: R0 to R7, plus SP (stack pointer) and FP (frame pointer). R0 holds a function's result.
//
// Addressing modes, for LD and ST:
//   x        the memory cell named x
//   x(R1)    the cell at the address of x plus the value of R1 (arrays)
//   -2(FP)   the cell at the value of FP minus 2 (locals and parameters)
//   *R1      the cell whose address is in R1
//   *4(R1)   the cell whose address is stored at 4 plus the value of R1
// A source can also be #5 (a constant) or R2 (a register).
//
// Many opcodes have two forms. With registers, ADD R1, R2, R3 means R1 = R2 + R3. With no operands,
// ADD pops two values and pushes the result, which is the stack-machine form.

export const ISA_REGISTER_COUNT = 8;

export const ISA_OPERATORS = {
  ADD: '+',
  SUB: '-',
  MUL: '*',
  DIV: '/',
  MOD: '%',
  LT: '<',
  LE: '<=',
  GT: '>',
  GE: '>=',
  EQ: '==',
  NE: '!=',
  AND: '&&',
  OR: '||',
} as const;

export type IsaBinaryOpcode = keyof typeof ISA_OPERATORS;

/** The opcode for each three-address operator. */
export const ISA_OPCODE_OF_OPERATOR = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '%': 'MOD',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
  '==': 'EQ',
  '!=': 'NE',
  '&&': 'AND',
  '||': 'OR',
} as const satisfies Record<string, IsaBinaryOpcode>;

export type IsaOpcode =
  | IsaBinaryOpcode
  | 'LD'
  | 'ST'
  | 'LEA'
  | 'NEG'
  | 'NOT'
  | 'BR'
  | 'BEQZ'
  | 'BNEZ'
  | 'BLTZ'
  | 'BLEZ'
  | 'BGTZ'
  | 'BGEZ'
  | 'PUSH'
  | 'POP'
  | 'CALL'
  | 'RET'
  | 'ENTER'
  | 'LEAVE'
  | 'CHK'
  | 'PRINT'
  | 'PRINTB'
  | 'NOP'
  | 'HALT';

export interface IsaDescription {
  opcode: IsaOpcode;
  /** The instruction's format. */
  format: string;
  meaning: string;
}

/** The full instruction reference, ready for a table on screen. */
export const ISA_REFERENCE: readonly IsaDescription[] = [
  {
    opcode: 'LD',
    format: 'LD Rd, src',
    meaning: 'Load: Rd = the value of src, which may be #n, a register or a memory operand.',
  },
  { opcode: 'ST', format: 'ST dst, Rs', meaning: 'Store: the memory operand dst = Rs.' },
  {
    opcode: 'LEA',
    format: 'LEA Rd, mem',
    meaning: 'Load address: Rd = the address of a memory operand, without reading it.',
  },
  {
    opcode: 'ADD',
    format: 'ADD Rd, Rs, src | ADD',
    meaning: 'Rd = Rs + src. With no operands, pop two values and push their sum.',
  },
  {
    opcode: 'SUB',
    format: 'SUB Rd, Rs, src | SUB',
    meaning: 'Rd = Rs - src. On the stack, the value below the top minus the top.',
  },
  {
    opcode: 'MUL',
    format: 'MUL Rd, Rs, src | MUL',
    meaning: 'Rd = Rs * src, keeping the low 32 bits.',
  },
  {
    opcode: 'DIV',
    format: 'DIV Rd, Rs, src | DIV',
    meaning: 'Rd = Rs / src, rounding toward zero. Dividing by zero stops the program.',
  },
  {
    opcode: 'MOD',
    format: 'MOD Rd, Rs, src | MOD',
    meaning: 'Rd = the remainder of Rs / src, with the sign of Rs.',
  },
  { opcode: 'LT', format: 'LT Rd, Rs, src | LT', meaning: 'Rd = 1 if Rs < src, otherwise 0.' },
  { opcode: 'LE', format: 'LE Rd, Rs, src | LE', meaning: 'Rd = 1 if Rs <= src, otherwise 0.' },
  { opcode: 'GT', format: 'GT Rd, Rs, src | GT', meaning: 'Rd = 1 if Rs > src, otherwise 0.' },
  { opcode: 'GE', format: 'GE Rd, Rs, src | GE', meaning: 'Rd = 1 if Rs >= src, otherwise 0.' },
  { opcode: 'EQ', format: 'EQ Rd, Rs, src | EQ', meaning: 'Rd = 1 if Rs equals src, otherwise 0.' },
  {
    opcode: 'NE',
    format: 'NE Rd, Rs, src | NE',
    meaning: 'Rd = 1 if Rs differs from src, otherwise 0.',
  },
  {
    opcode: 'AND',
    format: 'AND Rd, Rs, src | AND',
    meaning: 'Rd = 1 if both are nonzero, otherwise 0.',
  },
  {
    opcode: 'OR',
    format: 'OR Rd, Rs, src | OR',
    meaning: 'Rd = 1 if either is nonzero, otherwise 0.',
  },
  {
    opcode: 'NEG',
    format: 'NEG Rd, Rs | NEG',
    meaning: 'Rd = -Rs. With no operands, negate the top of the stack.',
  },
  { opcode: 'NOT', format: 'NOT Rd, Rs | NOT', meaning: 'Rd = 1 if Rs is 0, otherwise 0.' },
  { opcode: 'BR', format: 'BR L', meaning: 'Jump to label L.' },
  {
    opcode: 'BEQZ',
    format: 'BEQZ Rs, L | BEQZ L',
    meaning: 'Jump to L if Rs is 0. With one operand, pop the value to test.',
  },
  {
    opcode: 'BNEZ',
    format: 'BNEZ Rs, L | BNEZ L',
    meaning: 'Jump to L if Rs is not 0. With one operand, pop the value to test.',
  },
  { opcode: 'BLTZ', format: 'BLTZ Rs, L', meaning: 'Jump to L if Rs < 0.' },
  { opcode: 'BLEZ', format: 'BLEZ Rs, L', meaning: 'Jump to L if Rs <= 0.' },
  { opcode: 'BGTZ', format: 'BGTZ Rs, L', meaning: 'Jump to L if Rs > 0.' },
  { opcode: 'BGEZ', format: 'BGEZ Rs, L', meaning: 'Jump to L if Rs >= 0.' },
  { opcode: 'PUSH', format: 'PUSH src', meaning: 'Push the value of src onto the stack.' },
  {
    opcode: 'POP',
    format: 'POP dst | POP',
    meaning: 'Pop into a register or memory operand. With no operand, discard the top.',
  },
  {
    opcode: 'CALL',
    format: 'CALL f',
    meaning: 'Push the return address and jump to label f. The VM also opens a call-stack entry.',
  },
  { opcode: 'RET', format: 'RET', meaning: 'Pop the return address and jump to it.' },
  {
    opcode: 'ENTER',
    format: 'ENTER n',
    meaning: 'Build a frame: push FP, set FP = SP, then reserve n cells for locals, cleared to 0.',
  },
  { opcode: 'LEAVE', format: 'LEAVE', meaning: 'Remove the frame: set SP = FP, then pop FP.' },
  {
    opcode: 'CHK',
    format: 'CHK Rs, src',
    meaning: 'Stop with an error unless 0 <= Rs < src. Used for array bounds.',
  },
  {
    opcode: 'PRINT',
    format: 'PRINT Rs | PRINT',
    meaning: 'Output an integer from Rs. With no operand, pop it.',
  },
  {
    opcode: 'PRINTB',
    format: 'PRINTB Rs | PRINTB',
    meaning: 'Output true or false from Rs. With no operand, pop it.',
  },
  { opcode: 'NOP', format: 'NOP', meaning: 'Do nothing.' },
  { opcode: 'HALT', format: 'HALT', meaning: 'Stop the program.' },
];

/**
 * The book's cost model: one for the instruction, plus one for each extra word it needs. A register
 * or *R needs no extra word. A constant, a memory address, an offset or a label needs one.
 */
export function isaInstructionCost(instruction: string): number {
  const operands = instruction
    .trim()
    .replace(/^\S+\s*/, '')
    .split(',')
    .map((operand) => operand.trim())
    .filter((operand) => operand !== '');
  const extra = operands.filter((operand) => !/^\*?(R[0-7]|SP|FP)$/i.test(operand)).length;
  return 1 + extra;
}
