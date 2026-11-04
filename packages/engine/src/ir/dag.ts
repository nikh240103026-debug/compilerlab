import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { irParse, type IrExpr, type IrProgram, type IrStmt } from './parser';
import {
  formatTac,
  type TacBinaryOp,
  type TacInstr,
  type TacOperand,
  type TacUnaryOp,
} from './types';

// A DAG for expressions, built with the value-number method of section 6.1.2. Every node is a row
// in one array, and its children are row numbers. Leaf and Node look for an identical row first,
// and return it if there is one. That is how common subexpressions come to share a node.
//
// Assigning to a variable changes what later reads of it mean, so a table keeps each variable's
// current value number. A read after an assignment gets that node, not the old leaf. This is what
// makes the DAG correct over a whole basic block, and not only for one expression.

export interface IrDagRecord {
  /** The value number. These start at 1, as in the book's figure 6.6. */
  valueNumber: number;
  /** id, num, an operator, minus for unary minus, or =. */
  op: string;
  left: number | null;
  right: number | null;
  /** The name or number of a leaf. */
  leaf: string | null;
  /** Variables holding this value right now. */
  labels: string[];
}

export type IrDagAction = 'created' | 'reused' | 'current' | 'emit' | 'done';

export interface IrDagState {
  phase: 'build' | 'generate' | 'finished';
  action: IrDagAction;
  /** The call in the book's notation, like Node('+', 1, 2). */
  call: string;
  /** The value number the call returned. */
  valueNumber: number | null;
  text: string;
  start: number;
  end: number;
  records: IrDagRecord[];
  /** Each assigned variable and the value number it holds now. */
  variables: { name: string; valueNumber: number }[];
  /** Instructions emitted in this step. */
  emitted: string[];
  /** code[0..codeLength) exists at this step. */
  codeLength: number;
}

export interface IrDagResult {
  program: IrProgram;
  records: IrDagRecord[];
  /** The value number of each stand-alone expression and each assignment. */
  roots: number[];
  /** How many times Leaf or Node found a row that already existed. */
  reusedCount: number;
  code: TacInstr[];
  text: string[];
  trace: Trace<IrDagState>;
}

const MAX_DAG_NODES = 1000;

function unsupported(what: string, node: { start: number; end: number }): never {
  throw new EngineError({
    code: 'ir_dag_unsupported',
    message: `The DAG builder works on assignments and arithmetic, so it cannot take ${what}.`,
    hint: 'Try a few statements like: a = b + c; d = b + c;',
    position: node.start,
    length: node.end - node.start,
  });
}

class DagBuilder {
  readonly records: IrDagRecord[] = [];
  readonly roots: number[] = [];
  readonly code: TacInstr[] = [];
  readonly text: string[] = [];
  reusedCount = 0;
  private readonly recorder = new TraceRecorder<IrDagState>();
  private readonly found = new Map<string, number>();
  private readonly current = new Map<string, number>();
  private readonly taken: Set<string>;
  private tempCount = 0;

  constructor(private readonly program: IrProgram) {
    this.taken = new Set(program.names);
  }

  private add(
    title: string,
    explanation: string,
    node: { start: number; end: number } | null,
    fields: Pick<IrDagState, 'phase' | 'action' | 'call' | 'valueNumber'> & { emitted?: string[] },
  ): void {
    this.recorder.add(title, explanation, {
      phase: fields.phase,
      action: fields.action,
      call: fields.call,
      valueNumber: fields.valueNumber,
      text: node ? this.program.source.slice(node.start, node.end) : '',
      start: node ? node.start : 0,
      end: node ? node.end : 0,
      records: this.records.slice(),
      variables: [...this.current].map(([name, valueNumber]) => ({ name, valueNumber })),
      emitted: fields.emitted ?? [],
      codeLength: this.code.length,
    });
  }

  private create(
    op: string,
    left: number | null,
    right: number | null,
    leaf: string | null,
  ): number {
    if (this.records.length >= MAX_DAG_NODES) {
      throw new EngineError({
        code: 'ir_too_long',
        message: `This DAG would have more than ${MAX_DAG_NODES} nodes.`,
        hint: 'Try a shorter program.',
      });
    }
    const valueNumber = this.records.length + 1;
    // Rows are frozen once recorded, so a change later on replaces the row.
    this.records.push({ valueNumber, op, left, right, leaf, labels: [] });
    return valueNumber;
  }

  /** The book's Leaf(op, val): the existing leaf if there is one, or else a new one. */
  private leaf(kind: 'id' | 'num', value: string, node: { start: number; end: number }): number {
    const key = `${kind}:${value}`;
    const call = `Leaf(${kind}, ${value})`;
    const existing = this.found.get(key);
    if (existing !== undefined) {
      this.reusedCount++;
      this.add(
        call,
        `A leaf for ${value} already exists at value number ${existing}, so that is the answer, and no new row is added.`,
        node,
        {
          phase: 'build',
          action: 'reused',
          call,
          valueNumber: existing,
        },
      );
      return existing;
    }
    const valueNumber = this.create(kind, null, null, value);
    this.found.set(key, valueNumber);
    this.add(call, `No leaf for ${value} exists yet, so row ${valueNumber} is created.`, node, {
      phase: 'build',
      action: 'created',
      call,
      valueNumber,
    });
    return valueNumber;
  }

  /** The book's Node(op, left, right): the existing node if there is one, or else a new one. */
  private node(
    op: string,
    left: number,
    right: number | null,
    node: { start: number; end: number },
  ): number {
    const key = `${op}:${left}:${right ?? ''}`;
    const call = right === null ? `Node('${op}', ${left})` : `Node('${op}', ${left}, ${right})`;
    const existing = this.found.get(key);
    if (existing !== undefined) {
      this.reusedCount++;
      this.add(
        call,
        `A row with this operator and these children already exists, at value number ${existing}. This is a common subexpression, so it shares that node.`,
        node,
        {
          phase: 'build',
          action: 'reused',
          call,
          valueNumber: existing,
        },
      );
      return existing;
    }
    const valueNumber = this.create(op, left, right, null);
    this.found.set(key, valueNumber);
    this.add(
      call,
      `No row has this operator and these children, so row ${valueNumber} is created.`,
      node,
      {
        phase: 'build',
        action: 'created',
        call,
        valueNumber,
      },
    );
    return valueNumber;
  }

  private expr(expr: IrExpr): number {
    switch (expr.kind) {
      case 'num':
        return this.leaf('num', String(expr.value), expr);
      case 'bool':
        return this.leaf('num', expr.value ? '1' : '0', expr);
      case 'var': {
        const held = this.current.get(expr.name);
        if (held === undefined) return this.leaf('id', expr.name, expr);
        this.add(
          expr.name,
          `${expr.name} was assigned earlier in this block, so reading it now means value number ${held}, not the old leaf.`,
          expr,
          {
            phase: 'build',
            action: 'current',
            call: `current(${expr.name})`,
            valueNumber: held,
          },
        );
        return held;
      }
      case 'unary': {
        const arg = this.expr(expr.arg);
        return this.node(expr.op === '-' ? 'minus' : '!', arg, null, expr);
      }
      case 'binary': {
        const left = this.expr(expr.left);
        const right = this.expr(expr.right);
        return this.node(expr.op, left, right, expr);
      }
      case 'index':
        return unsupported('array references', expr);
      case 'call':
        return unsupported('function calls', expr);
    }
  }

  private statement(statement: IrStmt): void {
    switch (statement.kind) {
      case 'decl':
        if (statement.dims.length > 0) unsupported('array declarations', statement);
        return;
      case 'block':
        for (const inner of statement.body) this.statement(inner);
        return;
      case 'expr':
        this.roots.push(this.expr(statement.expr));
        return;
      case 'assign': {
        if (statement.target.kind !== 'var') unsupported('array references', statement);
        const name = statement.target.name;
        const target = this.leaf('id', name, statement.target);
        const value = this.expr(statement.value);
        // Never shared: assigning twice means two different moments, and both must happen.
        const valueNumber = this.create('=', target, value, null);
        const previous = this.current.get(name);
        if (previous !== undefined) {
          const row = this.records[previous - 1] as IrDagRecord;
          this.records[previous - 1] = {
            ...row,
            labels: row.labels.filter((label) => label !== name),
          };
        }
        const row = this.records[value - 1] as IrDagRecord;
        this.records[value - 1] = { ...row, labels: [...row.labels, name] };
        this.current.set(name, value);
        this.roots.push(valueNumber);
        const call = `Node('=', ${target}, ${value})`;
        this.add(
          call,
          `Row ${valueNumber} assigns value number ${value} to ${name}. From now on, reading ${name} means value number ${value}. An assignment always gets its own row, because each one is a separate action.`,
          statement,
          {
            phase: 'build',
            action: 'created',
            call,
            valueNumber,
          },
        );
        return;
      }
      case 'if':
      case 'while':
      case 'switch':
      case 'break':
      case 'return':
        unsupported('control flow', statement);
    }
  }

  private newTemp(): string {
    let name: string;
    do {
      name = `t${++this.tempCount}`;
    } while (this.taken.has(name));
    return name;
  }

  private emit(instr: TacInstr): string {
    const text = formatTac(instr);
    this.code.push(instr);
    this.text.push(text);
    return text;
  }

  /**
   * Rows are in creation order, so children always come before parents. Walking them once gives
   * each row a place to live: leaves are themselves, and each operator gets one temporary, so a
   * shared node is computed once.
   */
  private generate(): void {
    const operands = new Map<number, TacOperand>();
    const saved = new Set<string>();
    const operand = (valueNumber: number): TacOperand => operands.get(valueNumber) as TacOperand;

    for (const record of this.records) {
      const call = `row ${record.valueNumber}`;
      if (record.op === 'id') {
        operands.set(record.valueNumber, { kind: 'var', name: record.leaf as string });
      } else if (record.op === 'num') {
        operands.set(record.valueNumber, { kind: 'const', value: Number(record.leaf) });
      } else if (record.op === '=') {
        const leafNumber = record.left as number;
        const name = (this.records[leafNumber - 1] as IrDagRecord).leaf as string;
        const emitted: string[] = [];
        // A later row may still want the value this variable had on entry to the block. That value
        // is about to be overwritten, so a temporary keeps it.
        const readLater = this.records.some(
          (later) =>
            later.valueNumber > record.valueNumber &&
            (later.right === leafNumber || (later.op !== '=' && later.left === leafNumber)),
        );
        if (readLater && !saved.has(name)) {
          saved.add(name);
          const temp = this.newTemp();
          emitted.push(this.emit({ op: 'assign', dest: temp, src: { kind: 'var', name } }));
          operands.set(leafNumber, { kind: 'temp', name: temp });
        }
        emitted.push(this.emit({ op: 'assign', dest: name, src: operand(record.right as number) }));
        this.add(
          `Generate ${call}`,
          `This row assigns to ${name}.${emitted.length > 1 ? ` A later row still needs the old value of ${name}, so a temporary saves it first.` : ''}`,
          null,
          {
            phase: 'generate',
            action: 'emit',
            call,
            valueNumber: record.valueNumber,
            emitted,
          },
        );
      } else {
        const temp = this.newTemp();
        operands.set(record.valueNumber, { kind: 'temp', name: temp });
        const left = operand(record.left as number);
        const instr: TacInstr =
          record.right === null
            ? {
                op: 'unary',
                dest: temp,
                operator: (record.op === 'minus' ? '-' : '!') as TacUnaryOp,
                arg: left,
              }
            : {
                op: 'binary',
                dest: temp,
                operator: record.op as TacBinaryOp,
                left,
                right: operand(record.right),
              };
        const text = this.emit(instr);
        this.add(
          `Generate ${call}`,
          `This row runs once, however many parents share it, and its value goes in ${temp}.`,
          null,
          {
            phase: 'generate',
            action: 'emit',
            call,
            valueNumber: record.valueNumber,
            emitted: [text],
          },
        );
      }
    }
  }

  run(): Trace<IrDagState> {
    for (const statement of this.program.body) this.statement(statement);
    this.generate();
    this.add(
      'Finished',
      `The DAG has ${this.records.length} row${this.records.length === 1 ? '' : 's'}, and Leaf or Node found an existing row ${this.reusedCount} time${this.reusedCount === 1 ? '' : 's'}. The code computes each shared node once, in ${this.code.length} instruction${this.code.length === 1 ? '' : 's'}.`,
      null,
      { phase: 'finished', action: 'done', call: '', valueNumber: null },
    );
    return this.recorder.finish();
  }
}

/** Builds the DAG for a run of assignments and expressions, then generates code from it. */
export function irBuildDag(source: string): IrDagResult {
  const program = irParse(source);
  const builder = new DagBuilder(program);
  const trace = builder.run();
  return {
    program,
    records: builder.records,
    roots: builder.roots,
    reusedCount: builder.reusedCount,
    code: builder.code,
    text: builder.text,
    trace,
  };
}
