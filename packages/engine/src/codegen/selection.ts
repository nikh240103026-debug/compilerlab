import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, formatTacOperand, type TacInstr, type TacOperand } from '../ir/types';
import { optToInstrs } from '../optimize/tac-util';
import { ISA_OPCODE_OF_OPERATOR, isaInstructionCost } from './isa';

export interface SelectionRule {
  rule: string;
  /** The shape of statement this rule matches, in the book's notation. */
  pattern: string;
  code: string[];
}

export interface SelectionRow extends SelectionRule {
  tacIndex: number;
  tac: string;
  cost: number;
}

export interface SelectionState {
  /** The statement matched in this step. */
  tacIndex: number;
  row: SelectionRow;
  /** All code so far. */
  code: string[];
  totalCost: number;
}

export interface SelectionResult {
  rows: SelectionRow[];
  code: string[];
  totalCost: number;
  trace: Trace<SelectionState>;
}

/** Loading an operand: a constant needs #, a name reads its memory cell. */
const loadSource = (operand: TacOperand) =>
  operand.kind === 'const' ? `#${operand.value}` : operand.name;

/**
 * Picks the template for one statement. Rules are tried from most specific to least, which is
 * the idea behind tree-pattern matching: a template that uses an immediate operand is cheaper than
 * loading the constant into a register first, so it wins when both match.
 */
export function codegenSelectRule(instr: TacInstr): SelectionRule {
  switch (instr.op) {
    case 'assign':
      return {
        rule: instr.src.kind === 'const' ? 'assign-constant' : 'assign-name',
        pattern: instr.src.kind === 'const' ? 'x = c' : 'x = y',
        code: [`LD R1, ${loadSource(instr.src)}`, `ST ${instr.dest}, R1`],
      };
    case 'binary': {
      const opcode = ISA_OPCODE_OF_OPERATOR[instr.operator];
      if (instr.right.kind === 'const') {
        return {
          rule: 'binary-immediate',
          pattern: `x = y ${instr.operator} c`,
          code: [
            `LD R1, ${loadSource(instr.left)}`,
            `${opcode} R1, R1, #${instr.right.value}`,
            `ST ${instr.dest}, R1`,
          ],
        };
      }
      return {
        rule: 'binary',
        pattern: `x = y ${instr.operator} z`,
        code: [
          `LD R1, ${loadSource(instr.left)}`,
          `LD R2, ${loadSource(instr.right)}`,
          `${opcode} R1, R1, R2`,
          `ST ${instr.dest}, R1`,
        ],
      };
    }
    case 'unary':
      return {
        rule: 'unary',
        pattern: `x = ${instr.operator}y`,
        code: [
          `LD R1, ${loadSource(instr.arg)}`,
          `${instr.operator === '-' ? 'NEG' : 'NOT'} R1, R1`,
          `ST ${instr.dest}, R1`,
        ],
      };
    case 'load':
      return {
        rule: 'array-read',
        pattern: 'x = a[i]',
        code: [
          `LD R1, ${loadSource(instr.index)}`,
          `LD R2, ${instr.base}(R1)`,
          `ST ${instr.dest}, R2`,
        ],
      };
    case 'store':
      return {
        rule: 'array-write',
        pattern: 'a[i] = y',
        code: [
          `LD R1, ${loadSource(instr.src)}`,
          `LD R2, ${loadSource(instr.index)}`,
          `ST ${instr.base}(R2), R1`,
        ],
      };
    case 'label':
      return { rule: 'label', pattern: 'L:', code: [`${instr.name}:`] };
    case 'goto':
      return { rule: 'goto', pattern: 'goto L', code: [`BR ${instr.target}`] };
    case 'if':
      return {
        rule: instr.negate ? 'if-false' : 'if-true',
        pattern: instr.negate ? 'ifFalse x goto L' : 'if x goto L',
        code: [
          `LD R1, ${loadSource(instr.cond)}`,
          `${instr.negate ? 'BEQZ' : 'BNEZ'} R1, ${instr.target}`,
        ],
      };
    case 'param':
      return {
        rule: 'param',
        pattern: 'param x',
        code: [`LD R1, ${loadSource(instr.arg)}`, 'PUSH R1'],
      };
    case 'call': {
      const code = [`CALL ${instr.name}`];
      if (instr.argCount > 0) code.push(`ADD SP, SP, #${instr.argCount}`);
      if (instr.dest) code.push(`ST ${instr.dest}, R0`);
      return { rule: 'call', pattern: instr.dest ? 'x = call f, n' : 'call f, n', code };
    }
    case 'return':
      return {
        rule: 'return',
        pattern: instr.value ? 'return x' : 'return',
        code: instr.value ? [`LD R0, ${loadSource(instr.value)}`, 'RET'] : ['RET'],
      };
    case 'phi':
      // optToInstrs refuses φ, and SSA has to be undone before code generation anyway.
      return { rule: 'phi', pattern: 'x = φ(...)', code: [] };
  }
}

function describeRow(instr: TacInstr, row: SelectionRow): string {
  if (instr.op === 'label') return 'A label produces no code. It just names the next instruction.';
  if (instr.op === 'binary' && instr.right.kind === 'const') {
    return `The right operand ${formatTacOperand(instr.right)} is a constant, so the cheaper immediate form fits and needs one less load. Cost ${row.cost}.`;
  }
  return `This statement matches the pattern ${row.pattern}, so its template gives the code on the right. Cost ${row.cost}.`;
}

/** Instruction selection by templates: each TAC statement becomes a fixed instruction sequence. */
export function codegenSelectInstructions(input: string | readonly TacInstr[]): SelectionResult {
  const instrs = optToInstrs(input);
  const recorder = new TraceRecorder<SelectionState>();
  const code: string[] = [];
  const rows: SelectionRow[] = [];
  let totalCost = 0;

  instrs.forEach((instr, tacIndex) => {
    const rule = codegenSelectRule(instr);
    const cost = rule.code
      .filter((line) => !line.endsWith(':'))
      .reduce((sum, line) => sum + isaInstructionCost(line), 0);
    const row: SelectionRow = { ...rule, tacIndex, tac: formatTac(instr), cost };
    rows.push(row);
    code.push(...rule.code);
    totalCost += cost;
    recorder.add(row.tac, describeRow(instr, row), { tacIndex, row, code: [...code], totalCost });
  });

  return { rows, code, totalCost, trace: recorder.finish() };
}
