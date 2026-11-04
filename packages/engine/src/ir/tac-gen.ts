import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { irParse, type IrExpr, type IrIndexExpr, type IrProgram, type IrStmt } from './parser';
import { irArrayLayout, irDeclareSymbol, type IrSymbol } from './symbols';
import { formatTac, formatTacOperand, type TacInstr, type TacOperand } from './types';

// AST to three-address code, following the book's schemes: figure 6.19 for expressions, 6.22 for
// arrays, 6.36 for statements and 6.37 for boolean expressions.
//
// One difference is forced by the shared TacInstr: its conditional jump takes one operand, not a
// comparison. So the book's "if x < 100 goto L2" comes out as two instructions, t1 = x < 100 and
// if t1 goto L2. The control flow and labels are otherwise the book's. backpatch.ts keeps the
// book's one-instruction form, because that is what its lesson is about.

export const MAX_IR_INSTRUCTIONS = 3000;

export interface IrTacLabel {
  /** The attribute, like B.true or S.next. */
  name: string;
  label: string;
}

export interface IrTacState {
  node: number | null;
  nodeKind: string;
  /** The source text of the node visited. */
  text: string;
  start: number;
  end: number;
  /** The book's rule for this node, like E → E1 + E2 { ... }. */
  rule: string;
  /** Where this node's value is, E.addr, for an expression. */
  addr: string | null;
  /** The labels this node was given. */
  labels: IrTacLabel[];
  /** The instructions emitted in this step, as text. */
  emitted: string[];
  /** Where those instructions start in the result's code. */
  emittedFrom: number;
  /** code[0..codeLength) exists at this step. */
  codeLength: number;
}

export interface IrTacResult {
  program: IrProgram;
  code: TacInstr[];
  /** The same code, printed. */
  text: string[];
  /** Declarations, with their widths and offsets. */
  symbols: IrSymbol[];
  trace: Trace<IrTacState>;
}

/** Whether a statement jumps to whatever follows it, so that spot needs a label. */
function needsNext(statement: IrStmt): boolean {
  switch (statement.kind) {
    case 'if':
    case 'while':
    case 'switch':
      return true;
    case 'block': {
      const last = statement.body.at(-1);
      return last !== undefined && needsNext(last);
    }
    default:
      return false;
  }
}

function isComparison(op: string): boolean {
  return ['<', '<=', '>', '>=', '==', '!='].includes(op);
}

class TacGenerator {
  readonly code: TacInstr[] = [];
  readonly text: string[] = [];
  readonly symbols = new Map<string, IrSymbol>();
  private readonly recorder = new TraceRecorder<IrTacState>();
  private readonly taken: Set<string>;
  private readonly breakTargets: string[] = [];
  private tempCount = 0;
  private labelCount = 0;
  private offset = 0;

  constructor(private readonly program: IrProgram) {
    this.taken = new Set(program.names);
  }

  run(): Trace<IrTacState> {
    this.statements(this.program.body, null);
    this.recorder.add(
      'Finished',
      `The whole program is translated, into ${this.code.length} instruction${this.code.length === 1 ? '' : 's'}.`,
      {
        node: null,
        nodeKind: 'program',
        text: '',
        start: 0,
        end: this.program.source.length,
        rule: '',
        addr: null,
        labels: [],
        emitted: [],
        emittedFrom: this.code.length,
        codeLength: this.code.length,
      },
    );
    return this.recorder.finish();
  }

  private newTemp(): string {
    let name: string;
    do {
      name = `t${++this.tempCount}`;
    } while (this.taken.has(name));
    return name;
  }

  private newLabel(): string {
    return `L${++this.labelCount}`;
  }

  private emit(instr: TacInstr): void {
    if (this.code.length >= MAX_IR_INSTRUCTIONS) {
      throw new EngineError({
        code: 'ir_too_long',
        message: `This program needs more than ${MAX_IR_INSTRUCTIONS} instructions.`,
        hint: 'Try a shorter program.',
      });
    }
    this.code.push(instr);
    this.text.push(formatTac(instr));
  }

  private step(
    title: string,
    explanation: string,
    node: { id: number; kind: string; start: number; end: number },
    rule: string,
    from: number,
    addr: TacOperand | null = null,
    labels: IrTacLabel[] = [],
  ): void {
    this.recorder.add(title, explanation, {
      node: node.id,
      nodeKind: node.kind,
      text: this.program.source.slice(node.start, node.end),
      start: node.start,
      end: node.end,
      rule,
      addr: addr ? formatTacOperand(addr) : null,
      labels,
      emitted: this.text.slice(from),
      emittedFrom: from,
      codeLength: this.code.length,
    });
  }

  // ------ Expressions ------

  private expr(expr: IrExpr): TacOperand {
    switch (expr.kind) {
      case 'num': {
        const addr: TacOperand = { kind: 'const', value: expr.value };
        this.step(
          `Number ${expr.value}`,
          'A constant needs no code. It is its own address.',
          expr,
          'E → num { E.addr = num.value }',
          this.code.length,
          addr,
        );
        return addr;
      }
      case 'bool': {
        const addr: TacOperand = { kind: 'const', value: expr.value ? 1 : 0 };
        this.step(
          `Constant ${expr.value}`,
          `As a value, ${expr.value} is represented by ${expr.value ? 1 : 0}.`,
          expr,
          'E → true | false { E.addr = 1 or 0 }',
          this.code.length,
          addr,
        );
        return addr;
      }
      case 'var': {
        const addr: TacOperand = { kind: 'var', name: expr.name };
        this.step(
          `Name ${expr.name}`,
          `A name needs no code. E.addr is ${expr.name} itself, found in the symbol table.`,
          expr,
          'E → id { E.addr = top.get(id.lexeme) }',
          this.code.length,
          addr,
        );
        return addr;
      }
      case 'unary': {
        const arg = this.expr(expr.arg);
        const from = this.code.length;
        const temp = this.newTemp();
        this.emit({ op: 'unary', dest: temp, operator: expr.op, arg });
        const addr: TacOperand = { kind: 'temp', name: temp };
        this.step(
          `Unary ${expr.op}`,
          `The operand's value is in ${formatTacOperand(arg)}. A new temporary, ${temp}, holds the result.`,
          expr,
          expr.op === '-'
            ? "E → - E1 { E.addr = new Temp(); gen(E.addr '=' 'minus' E1.addr) }"
            : "E → ! E1 { E.addr = new Temp(); gen(E.addr '=' '!' E1.addr) }",
          from,
          addr,
        );
        return addr;
      }
      case 'binary':
        if (expr.op === '&&' || expr.op === '||') return this.logicalValue(expr);
        return this.binaryValue(expr);
      case 'index':
        return this.load(expr);
      case 'call':
        return this.call(expr, true) as TacOperand;
    }
  }

  private binaryValue(expr: Extract<IrExpr, { kind: 'binary' }>): TacOperand {
    const left = this.expr(expr.left);
    const right = this.expr(expr.right);
    const from = this.code.length;
    const temp = this.newTemp();
    this.emit({ op: 'binary', dest: temp, operator: expr.op, left, right });
    const addr: TacOperand = { kind: 'temp', name: temp };
    this.step(
      `Operator ${expr.op}`,
      `The operands are in ${formatTacOperand(left)} and ${formatTacOperand(right)}. A new temporary, ${temp}, holds the result.`,
      expr,
      `E → E1 ${expr.op} E2 { E.addr = new Temp(); gen(E.addr '=' E1.addr '${expr.op}' E2.addr) }`,
      from,
      addr,
    );
    return addr;
  }

  /** && or || used for its value: jump around, and set 1 or 0 at the end (section 6.6.6). */
  private logicalValue(expr: Extract<IrExpr, { kind: 'binary' }>): TacOperand {
    const trueLabel = this.newLabel();
    const falseLabel = this.newLabel();
    const after = this.newLabel();
    this.condition(expr, trueLabel, falseLabel);
    const from = this.code.length;
    const temp = this.newTemp();
    this.emit({ op: 'label', name: trueLabel });
    this.emit({ op: 'assign', dest: temp, src: { kind: 'const', value: 1 } });
    this.emit({ op: 'goto', target: after });
    this.emit({ op: 'label', name: falseLabel });
    this.emit({ op: 'assign', dest: temp, src: { kind: 'const', value: 0 } });
    this.emit({ op: 'label', name: after });
    const addr: TacOperand = { kind: 'temp', name: temp };
    this.step(
      'Boolean value',
      `This boolean expression is used for its value, so it still short-circuits with jumps. The two ends set ${temp} to 1 or 0.`,
      expr,
      'E → B { B.true, B.false = new labels; E.addr = new Temp(); set it to 1 at B.true and 0 at B.false }',
      from,
      addr,
      [
        { name: 'B.true', label: trueLabel },
        { name: 'B.false', label: falseLabel },
      ],
    );
    return addr;
  }

  /** Figure 6.22. The offset builds up one index at a time, each scaled by its level's width. */
  private location(reference: IrIndexExpr): { base: string; addr: TacOperand } {
    const layout = irArrayLayout(this.symbols, reference);
    let addr: TacOperand | null = null;
    for (const [level, indexExpr] of reference.indices.entries()) {
      const index = this.expr(indexExpr);
      const width = layout.widths[level] as number;
      const type = layout.types[level] as string;
      const note = layout.notes[level] as string;
      const from = this.code.length;
      if (addr === null) {
        const offset = this.newTemp();
        this.emit({
          op: 'binary',
          dest: offset,
          operator: '*',
          left: index,
          right: { kind: 'const', value: width },
        });
        addr = { kind: 'temp', name: offset };
        this.step(
          `${reference.base}[${formatTacOperand(index)}]`,
          `${note} So far the offset is ${formatTacOperand(index)} × ${width}, in ${offset}, and the type left is ${type}.`,
          { ...indexExpr, kind: 'index' },
          "L → id [ E ] { L.array = top.get(id.lexeme); L.type = L.array.type.elem; L.addr = new Temp(); gen(L.addr '=' E.addr '*' L.type.width) }",
          from,
          addr,
        );
      } else {
        const scaled = this.newTemp();
        const sum = this.newTemp();
        this.emit({
          op: 'binary',
          dest: scaled,
          operator: '*',
          left: index,
          right: { kind: 'const', value: width },
        });
        this.emit({
          op: 'binary',
          dest: sum,
          operator: '+',
          left: addr,
          right: { kind: 'temp', name: scaled },
        });
        addr = { kind: 'temp', name: sum };
        this.step(
          `Next index ${formatTacOperand(index)}`,
          `${note} This adds ${formatTacOperand(index)} × ${width} to the offset, which is now in ${sum}, and the type left is ${type}.`,
          { ...indexExpr, kind: 'index' },
          "L → L1 [ E ] { L.array = L1.array; L.type = L1.type.elem; t = new Temp(); L.addr = new Temp(); gen(t '=' E.addr '*' L.type.width); gen(L.addr '=' L1.addr '+' t) }",
          from,
          addr,
        );
      }
    }
    // The parser only makes an index node with at least one index, so addr is set by now.
    return { base: reference.base, addr: addr as TacOperand };
  }

  private load(reference: IrIndexExpr): TacOperand {
    const { base, addr } = this.location(reference);
    const from = this.code.length;
    const temp = this.newTemp();
    this.emit({ op: 'load', dest: temp, base, index: addr });
    const result: TacOperand = { kind: 'temp', name: temp };
    this.step(
      `Read ${base}[${formatTacOperand(addr)}]`,
      `The element's offset from the start of ${base} is in ${formatTacOperand(addr)}. Reading it puts the value in ${temp}.`,
      reference,
      "E → L { E.addr = new Temp(); gen(E.addr '=' L.array.base '[' L.addr ']') }",
      from,
      result,
    );
    return result;
  }

  private call(expr: Extract<IrExpr, { kind: 'call' }>, wantsValue: boolean): TacOperand | null {
    const args = expr.args.map((arg) => this.expr(arg));
    const from = this.code.length;
    for (const arg of args) this.emit({ op: 'param', arg });
    const dest = wantsValue ? this.newTemp() : null;
    this.emit({ op: 'call', dest, name: expr.name, argCount: args.length });
    const addr: TacOperand | null = dest ? { kind: 'temp', name: dest } : null;
    this.step(
      `Call ${expr.name}`,
      `All the arguments are evaluated first, then each is passed with param, in order. Then the call runs${dest ? `, and its result goes in ${dest}` : ''}.`,
      expr,
      "E → id ( A ) { for each E in A: gen('param' E.addr); E.addr = new Temp(); gen(E.addr '=' 'call' id ',' n) }",
      from,
      addr,
    );
    return addr;
  }

  // ------ Boolean expressions, as jumps (figure 6.37) ------

  private condition(expr: IrExpr, trueLabel: string, falseLabel: string): void {
    const labels: IrTacLabel[] = [
      { name: 'B.true', label: trueLabel },
      { name: 'B.false', label: falseLabel },
    ];
    if (expr.kind === 'binary' && expr.op === '||') {
      const leftFalse = this.newLabel();
      this.step(
        'Short-circuit ||',
        `If the left side is true, the whole thing is true, so it jumps to ${trueLabel} with no need to test the right side. If it is false, control goes to a new label, ${leftFalse}, where the right side is tested.`,
        expr,
        'B → B1 || B2 { B1.true = B.true; B1.false = newlabel(); B2.true = B.true; B2.false = B.false }',
        this.code.length,
        null,
        [...labels, { name: 'B1.false', label: leftFalse }],
      );
      this.condition(expr.left, trueLabel, leftFalse);
      this.placeLabel(leftFalse, expr);
      this.condition(expr.right, trueLabel, falseLabel);
      return;
    }
    if (expr.kind === 'binary' && expr.op === '&&') {
      const leftTrue = this.newLabel();
      this.step(
        'Short-circuit &&',
        `If the left side is false, the whole thing is false, so it jumps to ${falseLabel} with no need to test the right side. If it is true, control goes to a new label, ${leftTrue}, where the right side is tested.`,
        expr,
        'B → B1 && B2 { B1.true = newlabel(); B1.false = B.false; B2.true = B.true; B2.false = B.false }',
        this.code.length,
        null,
        [...labels, { name: 'B1.true', label: leftTrue }],
      );
      this.condition(expr.left, leftTrue, falseLabel);
      this.placeLabel(leftTrue, expr);
      this.condition(expr.right, trueLabel, falseLabel);
      return;
    }
    if (expr.kind === 'unary' && expr.op === '!') {
      this.step(
        'Boolean not',
        `Not needs no code of its own. It swaps the two targets, so the inner expression jumps to ${falseLabel} when it is true and to ${trueLabel} when it is false.`,
        expr,
        'B → ! B1 { B1.true = B.false; B1.false = B.true }',
        this.code.length,
        null,
        labels,
      );
      this.condition(expr.arg, falseLabel, trueLabel);
      return;
    }
    if (expr.kind === 'bool') {
      const from = this.code.length;
      this.emit({ op: 'goto', target: expr.value ? trueLabel : falseLabel });
      this.step(
        `Constant ${expr.value}`,
        `The result is known, so this is one jump to ${expr.value ? trueLabel : falseLabel}.`,
        expr,
        expr.value ? "B → true { gen('goto' B.true) }" : "B → false { gen('goto' B.false) }",
        from,
        null,
        labels,
      );
      return;
    }
    if (expr.kind === 'binary' && isComparison(expr.op)) {
      const left = this.expr(expr.left);
      const right = this.expr(expr.right);
      const from = this.code.length;
      const temp = this.newTemp();
      this.emit({ op: 'binary', dest: temp, operator: expr.op, left, right });
      this.emit({ op: 'if', cond: { kind: 'temp', name: temp }, target: trueLabel });
      this.emit({ op: 'goto', target: falseLabel });
      this.step(
        `Comparison ${expr.op}`,
        `The book writes this as if ${formatTacOperand(left)} ${expr.op} ${formatTacOperand(right)} goto ${trueLabel}. This code form tests one value, so the comparison goes in ${temp} first. Either way it jumps to ${trueLabel} when true and to ${falseLabel} when false.`,
        expr,
        `B → E1 ${expr.op} E2 { gen('if' E1.addr '${expr.op}' E2.addr 'goto' B.true); gen('goto' B.false) }`,
        from,
        null,
        labels,
      );
      return;
    }
    const value = this.expr(expr);
    const from = this.code.length;
    this.emit({ op: 'if', cond: value, target: trueLabel });
    this.emit({ op: 'goto', target: falseLabel });
    this.step(
      'Test a value',
      `A plain value used as a condition counts as true when it is not zero. It jumps to ${trueLabel} when true and to ${falseLabel} when false.`,
      expr,
      "B → E { gen('if' E.addr 'goto' B.true); gen('goto' B.false) }",
      from,
      null,
      labels,
    );
  }

  private placeLabel(
    label: string,
    node: { id: number; kind: string; start: number; end: number },
  ): void {
    const from = this.code.length;
    this.emit({ op: 'label', name: label });
    this.step(
      `Place ${label}`,
      `${label} marks this spot, so jumps to it land here.`,
      node,
      'label(L)',
      from,
    );
  }

  // ------ Statements (figure 6.36) ------

  /**
   * The book gives every statement a next label. A plain assignment never jumps there, though, so a
   * label is only made for a statement that can use it. That leaves straight-line code unlabeled.
   */
  private statements(list: readonly IrStmt[], next: string | null): void {
    list.forEach((statement, index) => {
      if (!needsNext(statement)) {
        this.statement(statement, null);
      } else if (index === list.length - 1 && next !== null) {
        this.statement(statement, next);
      } else {
        const label = this.newLabel();
        this.statement(statement, label);
        this.placeLabel(label, statement);
      }
    });
  }

  private statement(statement: IrStmt, next: string | null): void {
    switch (statement.kind) {
      case 'decl':
        this.declaration(statement);
        return;
      case 'assign':
        this.assignment(statement);
        return;
      case 'expr':
        if (statement.expr.kind === 'call') this.call(statement.expr, false);
        else this.expr(statement.expr);
        return;
      case 'block':
        this.statements(statement.body, next);
        return;
      case 'if':
        this.ifStatement(statement, next as string);
        return;
      case 'while':
        this.whileStatement(statement, next as string);
        return;
      case 'switch':
        this.switchStatement(statement, next as string);
        return;
      case 'break': {
        const from = this.code.length;
        const target = this.breakTargets.at(-1) as string;
        this.emit({ op: 'goto', target });
        this.step(
          'break',
          `break leaves the enclosing statement, by jumping to ${target}.`,
          statement,
          "S → break { gen('goto' S.break) }",
          from,
        );
        return;
      }
      case 'return': {
        const value = statement.value ? this.expr(statement.value) : null;
        const from = this.code.length;
        this.emit({ op: 'return', value });
        this.step(
          'return',
          value
            ? `The function returns the value in ${formatTacOperand(value)}.`
            : 'The function returns, with no value.',
          statement,
          "S → return E ; { gen('return' E.addr) }",
          from,
          value,
        );
        return;
      }
    }
  }

  private declaration(statement: Extract<IrStmt, { kind: 'decl' }>): void {
    const symbol = irDeclareSymbol(this.symbols, statement, this.offset);
    const before = this.offset;
    this.offset += symbol.width;
    this.step(
      `Declare ${symbol.name}`,
      `${symbol.name} has type ${symbol.type}, which takes ${symbol.width} bytes. It goes at offset ${before}, and the next declaration goes at ${this.offset}. This emits no code.`,
      statement,
      'D → T id ; D1 { top.put(id.lexeme, T.type, offset); offset = offset + T.width }',
      this.code.length,
    );
  }

  private assignment(statement: Extract<IrStmt, { kind: 'assign' }>): void {
    const { target } = statement;
    if (target.kind === 'var') {
      const symbol = this.symbols.get(target.name);
      if (symbol && symbol.dims.length > 0) {
        throw new EngineError({
          code: 'ir_bad_array',
          message: `${target.name} is an array, so it cannot be assigned as a whole.`,
          hint: 'Assign each element, like this: a[0] = 1;',
          position: target.start,
          length: target.end - target.start,
        });
      }
      const value = this.expr(statement.value);
      const from = this.code.length;
      this.emit({ op: 'assign', dest: target.name, src: value });
      this.step(
        'Assignment',
        `The value is in ${formatTacOperand(value)}, so it is copied into ${target.name}.`,
        statement,
        "S → id = E ; { gen(top.get(id.lexeme) '=' E.addr) }",
        from,
      );
      return;
    }
    const { base, addr } = this.location(target);
    const value = this.expr(statement.value);
    const from = this.code.length;
    this.emit({ op: 'store', base, index: addr, src: value });
    this.step(
      'Assign to an element',
      `The element's offset is in ${formatTacOperand(addr)}, and the value is in ${formatTacOperand(value)}.`,
      statement,
      "S → L = E ; { gen(L.array.base '[' L.addr ']' '=' E.addr) }",
      from,
    );
  }

  private ifStatement(statement: Extract<IrStmt, { kind: 'if' }>, next: string): void {
    const trueLabel = this.newLabel();
    if (!statement.elseBranch) {
      this.step(
        'if statement',
        `A true condition goes to ${trueLabel}, the start of the body. A false one skips the body, to ${next}.`,
        statement,
        'S → if ( B ) S1 { B.true = newlabel(); B.false = S1.next = S.next; S.code = B.code || label(B.true) || S1.code }',
        this.code.length,
        null,
        [
          { name: 'B.true', label: trueLabel },
          { name: 'B.false', label: next },
          { name: 'S.next', label: next },
        ],
      );
      this.condition(statement.cond, trueLabel, next);
      this.placeLabel(trueLabel, statement);
      this.statement(statement.thenBranch, next);
      return;
    }
    const falseLabel = this.newLabel();
    this.step(
      'if-else statement',
      `A true condition goes to ${trueLabel}, and a false one to ${falseLabel}. After the first branch, a jump skips the second, to ${next}.`,
      statement,
      "S → if ( B ) S1 else S2 { B.true = newlabel(); B.false = newlabel(); S1.next = S2.next = S.next; S.code = B.code || label(B.true) || S1.code || gen('goto' S.next) || label(B.false) || S2.code }",
      this.code.length,
      null,
      [
        { name: 'B.true', label: trueLabel },
        { name: 'B.false', label: falseLabel },
        { name: 'S.next', label: next },
      ],
    );
    this.condition(statement.cond, trueLabel, falseLabel);
    this.placeLabel(trueLabel, statement);
    this.statement(statement.thenBranch, next);
    const from = this.code.length;
    this.emit({ op: 'goto', target: next });
    this.step(
      'Skip the else part',
      `The first branch is done, so it jumps past the second, to ${next}.`,
      statement,
      "gen('goto' S.next)",
      from,
    );
    this.placeLabel(falseLabel, statement);
    this.statement(statement.elseBranch, next);
  }

  private whileStatement(statement: Extract<IrStmt, { kind: 'while' }>, next: string): void {
    const begin = this.newLabel();
    const trueLabel = this.newLabel();
    this.step(
      'while statement',
      `${begin} marks the test, so the loop can come back to it. A true condition goes to ${trueLabel}, the body, and a false one leaves the loop, to ${next}.`,
      statement,
      "S → while ( B ) S1 { begin = newlabel(); B.true = newlabel(); B.false = S.next; S1.next = begin; S.code = label(begin) || B.code || label(B.true) || S1.code || gen('goto' begin) }",
      this.code.length,
      null,
      [
        { name: 'begin', label: begin },
        { name: 'B.true', label: trueLabel },
        { name: 'B.false', label: next },
        { name: 'S1.next', label: begin },
      ],
    );
    this.placeLabel(begin, statement);
    this.condition(statement.cond, trueLabel, next);
    this.placeLabel(trueLabel, statement);
    this.breakTargets.push(next);
    this.statement(statement.body, begin);
    this.breakTargets.pop();
    const from = this.code.length;
    this.emit({ op: 'goto', target: begin });
    this.step(
      'Back to the test',
      `The body is done, so it jumps back to ${begin} to test the condition again.`,
      statement,
      "gen('goto' begin)",
      from,
    );
  }

  /** Figure 6.49: bodies first, then a table of tests at the end, reached by one jump. */
  private switchStatement(statement: Extract<IrStmt, { kind: 'switch' }>, next: string): void {
    const subject = this.expr(statement.subject);
    const test = this.newLabel();
    const from = this.code.length;
    this.emit({ op: 'goto', target: test });
    this.step(
      'switch statement',
      `The value being tested is in ${formatTacOperand(subject)}. The tests come after all the bodies, so control jumps ahead to ${test}. A body ends by jumping to ${next}, so one case never runs into the next.`,
      statement,
      "S → switch ( E ) { cases } { test = newlabel(); next = S.next; gen('goto' test); each case: label(Li) || Si.code || gen('goto' next); label(test) || the tests }",
      from,
      subject,
      [
        { name: 'test', label: test },
        { name: 'S.next', label: next },
      ],
    );
    const labels = statement.cases.map(() => this.newLabel());
    this.breakTargets.push(next);
    statement.cases.forEach((item, index) => {
      const label = labels[index] as string;
      const caseNode = { id: statement.id, kind: 'case', start: item.start, end: item.end };
      this.placeLabel(label, caseNode);
      this.statements(item.body, next);
      if (item.body.at(-1)?.kind !== 'break') {
        const start = this.code.length;
        this.emit({ op: 'goto', target: next });
        this.step(
          'End of the case',
          `The case is done, so it jumps past the whole switch, to ${next}.`,
          caseNode,
          "gen('goto' next)",
          start,
        );
      }
    });
    this.breakTargets.pop();

    this.placeLabel(test, statement);
    statement.cases.forEach((item, index) => {
      if (item.value === null) return;
      const label = labels[index] as string;
      const start = this.code.length;
      const temp = this.newTemp();
      this.emit({
        op: 'binary',
        dest: temp,
        operator: '==',
        left: subject,
        right: { kind: 'const', value: item.value },
      });
      this.emit({ op: 'if', cond: { kind: 'temp', name: temp }, target: label });
      this.step(
        `Test case ${item.value}`,
        `If the value equals ${item.value}, it jumps to that case's body, ${label}. The book writes this as if t = ${item.value} goto ${label}.`,
        { id: statement.id, kind: 'case', start: item.start, end: item.end },
        "gen('if' t '=' Vi 'goto' Li)",
        start,
      );
    });
    const defaultIndex = statement.cases.findIndex((item) => item.value === null);
    const start = this.code.length;
    const fallback = defaultIndex >= 0 ? (labels[defaultIndex] as string) : next;
    this.emit({ op: 'goto', target: fallback });
    this.step(
      'No case matched',
      defaultIndex >= 0
        ? `No value matched, so it jumps to the default body, ${fallback}.`
        : `No value matched and there is no default, so it jumps past the switch, to ${fallback}.`,
      statement,
      "gen('goto' Ln)",
      start,
    );
  }
}

/** Translates an already parsed program to three-address code. */
export function irProgramToTac(program: IrProgram): IrTacResult {
  const generator = new TacGenerator(program);
  const trace = generator.run();
  return {
    program,
    code: generator.code,
    text: generator.text,
    symbols: [...generator.symbols.values()],
    trace,
  };
}

/** Parses source text and translates it to three-address code, with one step per node. */
export function irToTac(source: string): IrTacResult {
  return irProgramToTac(irParse(source));
}
