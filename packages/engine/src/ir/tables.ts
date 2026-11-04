import { irToTac } from './tac-gen';
import { tacDefinedName, tacUsedOperands } from './tac-utils';
import { formatTac, formatTacOperand, type TacInstr, type TacOperand } from './types';

// The three table forms of section 6.2 for the same code:
//
//   Quadruples name their result, so instructions can move freely.
//   Triples drop the result, and later instructions refer to a value by its row number.
//   Indirect triples keep a separate list of pointers to triples, so an optimizer can reorder that
//   list and leave the triples, and every reference to them, alone.

export interface IrQuadruple {
  index: number;
  op: string;
  arg1: string;
  arg2: string;
  result: string;
}

export interface IrTriple {
  index: number;
  op: string;
  arg1: string;
  arg2: string;
  /** The instruction in the code this row came from. */
  instruction: number;
}

export interface IrIndirectTriple {
  /** Its place in the instruction list. */
  position: number;
  /** The triple it points to. */
  triple: number;
}

export interface IrTables {
  /** The code as text, indexed like the instructions. */
  code: string[];
  quadruples: IrQuadruple[];
  triples: IrTriple[];
  indirect: IrIndirectTriple[];
}

export const IR_INDIRECT_START = 35;

function unaryName(operator: string): string {
  return operator === '-' ? 'minus' : operator;
}

function quadrupleOf(instr: TacInstr, index: number): IrQuadruple {
  const show = formatTacOperand;
  const row = (op: string, arg1: string, arg2: string, result: string): IrQuadruple => ({
    index,
    op,
    arg1,
    arg2,
    result,
  });
  switch (instr.op) {
    case 'assign':
      return row('=', show(instr.src), '', instr.dest);
    case 'binary':
      return row(instr.operator, show(instr.left), show(instr.right), instr.dest);
    case 'unary':
      return row(unaryName(instr.operator), show(instr.arg), '', instr.dest);
    case 'label':
      return row('label', '', '', instr.name);
    case 'goto':
      return row('goto', '', '', instr.target);
    case 'if':
      return row(instr.negate ? 'ifFalse' : 'if', show(instr.cond), '', instr.target);
    case 'param':
      return row('param', show(instr.arg), '', '');
    case 'call':
      return row('call', instr.name, String(instr.argCount), instr.dest ?? '');
    case 'return':
      return row('return', instr.value ? show(instr.value) : '', '', '');
    case 'load':
      return row('=[]', instr.base, show(instr.index), instr.dest);
    case 'store':
      // Read it as: result[arg2] = arg1.
      return row('[]=', show(instr.src), show(instr.index), instr.base);
    case 'phi':
      return row(
        'phi',
        instr.sources.map(({ block, value }) => `${block}: ${show(value)}`).join(', '),
        '',
        instr.dest,
      );
  }
}

/** Builds all three tables from the same code. Works on any TacInstr list. */
export function irBuildTables(
  code: readonly TacInstr[],
  indirectStart: number = IR_INDIRECT_START,
): IrTables {
  // A temporary assigned once can be replaced by the row that computes it. One assigned on two
  // paths, as in t = 1 and t = 0, has no single row, so it stays a named location.
  const definitions = new Map<string, number>();
  const readAsTemp = new Set<string>();
  const readAsVariable = new Set<string>();
  for (const instr of code) {
    const name = tacDefinedName(instr);
    if (name !== null) definitions.set(name, (definitions.get(name) ?? 0) + 1);
    for (const operand of tacUsedOperands(instr)) {
      if (operand.kind === 'temp') readAsTemp.add(operand.name);
      if (operand.kind === 'var') readAsVariable.add(operand.name);
    }
  }
  // A destination is only a name, so a temporary nothing reads is known by its spelling.
  const isTemp = (name: string): boolean =>
    readAsTemp.has(name) || (/^t[0-9]+$/.test(name) && !readAsVariable.has(name));
  const replaceable = (name: string | null): boolean =>
    name !== null && isTemp(name) && definitions.get(name) === 1;

  // First pass: how many rows each instruction needs, which fixes every row number. A value that
  // lands in a named variable needs an extra = row, as x[i] = y and x = y[i] do in the book.
  const rowOfTemp = new Map<string, number>();
  const rowOfLabel = new Map<string, number>();
  let rowCount = 0;
  for (const instr of code) {
    if (instr.op === 'label') {
      rowOfLabel.set(instr.name, rowCount);
      continue;
    }
    const name = tacDefinedName(instr);
    if (replaceable(name)) rowOfTemp.set(name as string, rowCount);
    const computes =
      instr.op === 'binary' || instr.op === 'unary' || instr.op === 'load' || instr.op === 'call';
    const extraRow = instr.op === 'store' || (computes && name !== null && !replaceable(name));
    rowCount += extraRow ? 2 : 1;
  }

  const show = (operand: TacOperand): string => {
    if (operand.kind === 'temp') {
      const row = rowOfTemp.get(operand.name);
      if (row !== undefined) return `(${row})`;
    }
    return formatTacOperand(operand);
  };
  const target = (label: string): string => {
    const row = rowOfLabel.get(label);
    return row === undefined ? label : `(${row})`;
  };

  const triples: IrTriple[] = [];
  code.forEach((instr, instruction) => {
    const add = (op: string, arg1: string, arg2: string): void => {
      triples.push({ index: triples.length, op, arg1, arg2, instruction });
    };
    const storeResult = (name: string | null): void => {
      if (name !== null && !replaceable(name)) add('=', name, `(${triples.length - 1})`);
    };
    switch (instr.op) {
      case 'label':
        return;
      case 'assign':
        add('=', instr.dest, show(instr.src));
        return;
      case 'binary':
        add(instr.operator, show(instr.left), show(instr.right));
        storeResult(instr.dest);
        return;
      case 'unary':
        add(unaryName(instr.operator), show(instr.arg), '');
        storeResult(instr.dest);
        return;
      case 'goto':
        add('goto', target(instr.target), '');
        return;
      case 'if':
        add(instr.negate ? 'ifFalse' : 'if', show(instr.cond), target(instr.target));
        return;
      case 'param':
        add('param', show(instr.arg), '');
        return;
      case 'call':
        add('call', instr.name, String(instr.argCount));
        storeResult(instr.dest);
        return;
      case 'return':
        add('return', instr.value ? show(instr.value) : '', '');
        return;
      case 'load':
        add('=[]', instr.base, show(instr.index));
        storeResult(instr.dest);
        return;
      case 'store':
        add('[]=', instr.base, show(instr.index));
        add('=', `(${triples.length - 1})`, show(instr.src));
        return;
      case 'phi':
        add(
          'phi',
          instr.sources.map(({ block, value }) => `${block}: ${show(value)}`).join(', '),
          '',
        );
        return;
    }
  });

  return {
    code: code.map(formatTac),
    quadruples: code.map(quadrupleOf),
    triples,
    indirect: triples.map((triple) => ({
      position: indirectStart + triple.index,
      triple: triple.index,
    })),
  };
}

/** Translates source text to three-address code, then builds the tables from that code. */
export function irSourceToTables(
  source: string,
  indirectStart: number = IR_INDIRECT_START,
): IrTables {
  return irBuildTables(irToTac(source).code, indirectStart);
}
