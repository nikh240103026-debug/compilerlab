// Three-address code, the form every later phase shares: the IR builders produce it, and the
// optimizer, data-flow analyses and code generators consume it.

export type TacOperand =
  { kind: 'var'; name: string } | { kind: 'temp'; name: string } | { kind: 'const'; value: number };

export type TacBinaryOp =
  '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export type TacUnaryOp = '-' | '!';

export type TacInstr =
  | { op: 'assign'; dest: string; src: TacOperand }
  | { op: 'binary'; dest: string; operator: TacBinaryOp; left: TacOperand; right: TacOperand }
  | { op: 'unary'; dest: string; operator: TacUnaryOp; arg: TacOperand }
  | { op: 'label'; name: string }
  | { op: 'goto'; target: string }
  /** if cond goto target. With negate set: ifFalse cond goto target. */
  | { op: 'if'; cond: TacOperand; target: string; negate?: boolean }
  | { op: 'param'; arg: TacOperand }
  | { op: 'call'; dest: string | null; name: string; argCount: number }
  | { op: 'return'; value: TacOperand | null }
  /** dest = base[index] */
  | { op: 'load'; dest: string; base: string; index: TacOperand }
  /** base[index] = src */
  | { op: 'store'; base: string; index: TacOperand; src: TacOperand }
  /** SSA only. Which value dest takes depends on the block control came from. */
  | { op: 'phi'; dest: string; sources: { block: string; value: TacOperand }[] };

export function formatTacOperand(operand: TacOperand): string {
  return operand.kind === 'const' ? String(operand.value) : operand.name;
}

/** One instruction as a textbook prints it, like: t1 = a + b */
export function formatTac(instr: TacInstr): string {
  const show = formatTacOperand;
  switch (instr.op) {
    case 'assign':
      return `${instr.dest} = ${show(instr.src)}`;
    case 'binary':
      return `${instr.dest} = ${show(instr.left)} ${instr.operator} ${show(instr.right)}`;
    case 'unary':
      return `${instr.dest} = ${instr.operator}${show(instr.arg)}`;
    case 'label':
      return `${instr.name}:`;
    case 'goto':
      return `goto ${instr.target}`;
    case 'if':
      return `${instr.negate ? 'ifFalse' : 'if'} ${show(instr.cond)} goto ${instr.target}`;
    case 'param':
      return `param ${show(instr.arg)}`;
    case 'call':
      return `${instr.dest ? `${instr.dest} = ` : ''}call ${instr.name}, ${instr.argCount}`;
    case 'return':
      return instr.value ? `return ${show(instr.value)}` : 'return';
    case 'load':
      return `${instr.dest} = ${instr.base}[${show(instr.index)}]`;
    case 'store':
      return `${instr.base}[${show(instr.index)}] = ${show(instr.src)}`;
    case 'phi':
      return `${instr.dest} = φ(${instr.sources
        .map(({ block, value }) => `${block}: ${show(value)}`)
        .join(', ')})`;
  }
}
