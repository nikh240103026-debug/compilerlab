import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { irParse, type IrExpr, type IrIndexExpr, type IrProgram, type IrStmt } from './parser';
import { irArrayLayout, irDeclareSymbol, type IrSymbol } from './symbols';

// Backpatching, by the book's schemes: figure 6.43 for boolean expressions and figure 6.46 for
// statements. One pass emits numbered instructions and leaves each unknown jump target blank. The
// blanks are collected in lists, and a list is filled in as soon as its target is known.
//
// Each rule's actions run when the parser would reduce by it. Here that is a postorder walk of the
// AST, with M → ε and N → ε appearing as steps at the points their markers would be reduced.
//
// Instructions here keep the book's form, like if a < b goto 104, so they are not TacInstr.

export interface IrJumpInstr {
  number: number;
  kind: 'plain' | 'jump';
  /** The instruction without its target, like: if a < b goto */
  body: string;
  /** The target, once known. Always null for a plain instruction. */
  target: number | null;
  /** The instruction as printed, with _ for a blank target. */
  text: string;
}

export type IrBackpatchOperation =
  'start' | 'marker' | 'makelist' | 'merge' | 'backpatch' | 'emit' | 'attribute' | 'finished';

/** The lists attached to one AST node, as figure 6.45 annotates its tree. */
export interface IrBackpatchAttributes {
  node: number;
  text: string;
  start: number;
  end: number;
  truelist: number[] | null;
  falselist: number[] | null;
  nextlist: number[] | null;
}

export interface IrBackpatchState {
  operation: IrBackpatchOperation;
  /** The call in the book's notation, like backpatch({102}, 104). */
  call: string;
  /** The grammar rule whose action this is, like B → B1 || M B2. */
  production: string;
  text: string;
  start: number;
  end: number;
  instructions: IrJumpInstr[];
  nextinstr: number;
  /** The list this step made, used, or patched. */
  list: number[];
  /** The target given to the list, in a backpatch, or the instruction number in a marker. */
  target: number | null;
  /** The instructions this step created or filled in. */
  changed: number[];
  attributes: IrBackpatchAttributes[];
}

export interface IrBackpatchResult {
  program: IrProgram;
  /** boolean: the whole input is one boolean expression, whose lists stay open, as in the book. */
  mode: 'boolean' | 'statements';
  instructions: IrJumpInstr[];
  /** Lists still open at the end, for a lone boolean expression. */
  truelist: number[];
  falselist: number[];
  symbols: IrSymbol[];
  trace: Trace<IrBackpatchState>;
}

interface BooleanLists {
  truelist: number[];
  falselist: number[];
}

type NodeSpan = { id: number; start: number; end: number };

export const IR_BACKPATCH_START = 100;
const MAX_INSTRUCTIONS = 3000;

function showList(list: readonly number[]): string {
  return list.length > 0 ? `{${list.join(', ')}}` : '{}';
}

function isComparison(op: string): boolean {
  return ['<', '<=', '>', '>=', '==', '!='].includes(op);
}

function isBooleanExpr(expr: IrExpr): boolean {
  if (expr.kind === 'bool') return true;
  if (expr.kind === 'unary') return expr.op === '!';
  return expr.kind === 'binary' && (expr.op === '&&' || expr.op === '||' || isComparison(expr.op));
}

class Backpatcher {
  readonly instructions: IrJumpInstr[] = [];
  readonly symbols = new Map<string, IrSymbol>();
  nextinstr: number;
  private attributes: IrBackpatchAttributes[] = [];
  private readonly recorder = new TraceRecorder<IrBackpatchState>();
  private readonly taken: Set<string>;
  private readonly breakLists: number[][] = [];
  private tempCount = 0;
  private offset = 0;

  constructor(
    private readonly program: IrProgram,
    private readonly first: number,
  ) {
    this.nextinstr = first;
    this.taken = new Set(program.names);
  }

  private newTemp(): string {
    let name: string;
    do {
      name = `t${++this.tempCount}`;
    } while (this.taken.has(name));
    return name;
  }

  private textOf(node: NodeSpan): string {
    return this.program.source.slice(node.start, node.end);
  }

  private add(
    title: string,
    explanation: string,
    operation: IrBackpatchOperation,
    production: string,
    node: { start: number; end: number } | null,
    fields: { call?: string; list?: number[]; target?: number | null; changed?: number[] } = {},
  ): void {
    this.recorder.add(title, explanation, {
      operation,
      call: fields.call ?? '',
      production,
      text: node ? this.program.source.slice(node.start, node.end) : '',
      start: node ? node.start : 0,
      end: node ? node.end : 0,
      instructions: this.instructions.slice(),
      nextinstr: this.nextinstr,
      list: fields.list ?? [],
      target: fields.target ?? null,
      changed: fields.changed ?? [],
      attributes: this.attributes,
    });
  }

  private attach(
    node: NodeSpan,
    lists: Partial<Pick<IrBackpatchAttributes, 'truelist' | 'falselist' | 'nextlist'>>,
  ): void {
    const known = this.attributes.find((item) => item.node === node.id);
    const updated: IrBackpatchAttributes = {
      node: node.id,
      text: this.textOf(node),
      start: node.start,
      end: node.end,
      truelist: lists.truelist ?? known?.truelist ?? null,
      falselist: lists.falselist ?? known?.falselist ?? null,
      nextlist: lists.nextlist ?? known?.nextlist ?? null,
    };
    this.attributes = known
      ? this.attributes.map((item) => (item === known ? updated : item))
      : [...this.attributes, updated];
  }

  // ------ The three list operations, which the lesson is about ------

  private makelist(number: number, name: string, production: string, node: NodeSpan): number[] {
    const list = [number];
    this.add(
      `${name} = makelist(${number})`,
      `A new list holds just instruction ${number}, whose target is not known yet. It becomes ${name}.`,
      'makelist',
      production,
      node,
      { call: `makelist(${number})`, list },
    );
    return list;
  }

  private merge(
    a: number[],
    b: number[],
    name: string,
    production: string,
    node: NodeSpan,
  ): number[] {
    const list = [...a, ...b];
    const call = `merge(${showList(a)}, ${showList(b)})`;
    this.add(
      `${name} = ${call}`,
      `All these instructions will jump to the same place, so their lists join into one, ${showList(list)}. That is ${name}.`,
      'merge',
      production,
      node,
      { call, list },
    );
    return list;
  }

  private backpatch(
    list: number[],
    target: number,
    why: string,
    production: string,
    node: { start: number; end: number } | null,
  ): void {
    for (const number of list) {
      const index = number - this.first;
      const instr = this.instructions[index] as IrJumpInstr;
      this.instructions[index] = { ...instr, target, text: `${instr.body} ${target}` };
    }
    const call = `backpatch(${showList(list)}, ${target})`;
    this.add(
      call,
      list.length > 0
        ? `${why} So the blank in ${list.length === 1 ? 'instruction' : 'instructions'} ${list.join(', ')} becomes ${target}.`
        : `${why} The list is empty, so nothing changes.`,
      'backpatch',
      production,
      node,
      { call, list, target, changed: list },
    );
  }

  private emitInstr(
    kind: IrJumpInstr['kind'],
    body: string,
    target: number | null,
    production: string,
    node: { start: number; end: number } | null,
    why: string,
  ): number {
    if (this.instructions.length >= MAX_INSTRUCTIONS) {
      throw new EngineError({
        code: 'ir_too_long',
        message: `This program needs more than ${MAX_INSTRUCTIONS} instructions.`,
        hint: 'Try a shorter program.',
      });
    }
    const number = this.nextinstr;
    const text = kind === 'plain' ? body : `${body} ${target === null ? '_' : target}`;
    this.instructions.push({ number, kind, body, target, text });
    this.nextinstr++;
    this.add(
      `${number}: ${text}`,
      `${why} Instruction ${number} is emitted, and nextinstr becomes ${this.nextinstr}.`,
      'emit',
      production,
      node,
      {
        call: `emit('${text}')`,
        changed: [number],
      },
    );
    return number;
  }

  private marker(name: string, production: string, node: NodeSpan): number {
    const instr = this.nextinstr;
    this.add(
      `${name}.instr = ${instr}`,
      `The marker ${name} → ε remembers the number of the next instruction, ${instr}. A list can jump here when its target becomes known.`,
      'marker',
      production,
      node,
      { call: `${name}.instr = nextinstr`, target: instr },
    );
    return instr;
  }

  // ------ Expressions used for their values ------

  private value(expr: IrExpr): string {
    switch (expr.kind) {
      case 'num':
        return String(expr.value);
      case 'bool':
        return String(expr.value);
      case 'var':
        return expr.name;
      case 'index':
        return this.loadElement(expr);
      case 'call':
        return this.callExpr(expr, true) as string;
      case 'unary':
        if (expr.op === '!') return this.booleanValue(expr);
        return this.compute(expr, () => `-${this.value(expr.arg)}`, 'E → - E1');
      case 'binary':
        if (isBooleanExpr(expr)) return this.booleanValue(expr);
        return this.compute(
          expr,
          () => {
            const left = this.value(expr.left);
            const right = this.value(expr.right);
            return `${left} ${expr.op} ${right}`;
          },
          `E → E1 ${expr.op} E2`,
        );
    }
  }

  private compute(expr: IrExpr, operands: () => string, production: string): string {
    const body = operands();
    const temp = this.newTemp();
    this.emitInstr(
      'plain',
      `${temp} = ${body}`,
      null,
      production,
      expr,
      'This expression computes a value, so it needs ordinary code.',
    );
    return temp;
  }

  private location(reference: IrIndexExpr): string {
    const layout = irArrayLayout(this.symbols, reference);
    const production = 'L → L1 [ E ]';
    let addr = '';
    for (const [level, indexExpr] of reference.indices.entries()) {
      const index = this.value(indexExpr);
      const width = layout.widths[level] as number;
      const note = layout.notes[level] as string;
      if (level === 0) {
        addr = this.newTemp();
        this.emitInstr('plain', `${addr} = ${index} * ${width}`, null, production, reference, note);
      } else {
        const scaled = this.newTemp();
        const sum = this.newTemp();
        this.emitInstr(
          'plain',
          `${scaled} = ${index} * ${width}`,
          null,
          production,
          reference,
          note,
        );
        this.emitInstr(
          'plain',
          `${sum} = ${addr} + ${scaled}`,
          null,
          production,
          reference,
          'This adds the step for this index to the offset so far.',
        );
        addr = sum;
      }
    }
    return addr;
  }

  private loadElement(reference: IrIndexExpr): string {
    const addr = this.location(reference);
    const temp = this.newTemp();
    this.emitInstr(
      'plain',
      `${temp} = ${reference.base}[${addr}]`,
      null,
      'E → L',
      reference,
      'The offset is known, so the element can be read.',
    );
    return temp;
  }

  private callExpr(expr: Extract<IrExpr, { kind: 'call' }>, wantsValue: boolean): string | null {
    const production = 'E → id ( A )';
    const args = expr.args.map((arg) => this.value(arg));
    for (const arg of args) {
      this.emitInstr(
        'plain',
        `param ${arg}`,
        null,
        production,
        expr,
        'Each argument is passed in order.',
      );
    }
    const temp = wantsValue ? this.newTemp() : null;
    this.emitInstr(
      'plain',
      `${temp ? `${temp} = ` : ''}call ${expr.name}, ${args.length}`,
      null,
      production,
      expr,
      'All the arguments are passed, so the call can run.',
    );
    return temp;
  }

  /** A boolean expression used as a value: both lists land on code that sets the answer. */
  private booleanValue(expr: IrExpr): string {
    const production = 'E → B';
    const lists = this.boolean(expr);
    const temp = this.newTemp();
    this.backpatch(
      lists.truelist,
      this.nextinstr,
      'The true exits should set the value to true, which happens at the next instruction.',
      production,
      expr,
    );
    this.emitInstr(
      'plain',
      `${temp} = true`,
      null,
      production,
      expr,
      'This is where the true exits arrive.',
    );
    this.emitInstr(
      'jump',
      'goto',
      this.nextinstr + 2,
      production,
      expr,
      'This skips the instruction that sets false, so its target is already known.',
    );
    this.backpatch(
      lists.falselist,
      this.nextinstr,
      'The false exits should set the value to false, which happens at the next instruction.',
      production,
      expr,
    );
    this.emitInstr(
      'plain',
      `${temp} = false`,
      null,
      production,
      expr,
      'This is where the false exits arrive.',
    );
    return temp;
  }

  // ------ Boolean expressions (figure 6.43) ------

  private boolean(expr: IrExpr): BooleanLists {
    if (expr.kind === 'binary' && expr.op === '||') {
      const production = 'B → B1 || M B2';
      const b1 = this.boolean(expr.left);
      const m = this.marker('M', production, expr);
      const b2 = this.boolean(expr.right);
      this.backpatch(
        b1.falselist,
        m,
        `If B1 is false, B2 decides the answer, and B2 starts at M.instr = ${m}.`,
        production,
        expr,
      );
      const truelist = this.merge(b1.truelist, b2.truelist, 'B.truelist', production, expr);
      return this.finishBoolean(
        expr,
        truelist,
        b2.falselist,
        production,
        'B.falselist = B2.falselist. The whole expression is false only when B2 is false.',
      );
    }
    if (expr.kind === 'binary' && expr.op === '&&') {
      const production = 'B → B1 && M B2';
      const b1 = this.boolean(expr.left);
      const m = this.marker('M', production, expr);
      const b2 = this.boolean(expr.right);
      this.backpatch(
        b1.truelist,
        m,
        `If B1 is true, B2 decides the answer, and B2 starts at M.instr = ${m}.`,
        production,
        expr,
      );
      const falselist = this.merge(b1.falselist, b2.falselist, 'B.falselist', production, expr);
      return this.finishBoolean(
        expr,
        b2.truelist,
        falselist,
        production,
        'B.truelist = B2.truelist. The whole expression is true only when B2 is true.',
      );
    }
    if (expr.kind === 'unary' && expr.op === '!') {
      const production = 'B → ! B1';
      const b1 = this.boolean(expr.arg);
      return this.finishBoolean(
        expr,
        b1.falselist,
        b1.truelist,
        production,
        'Not emits no code. It swaps the two lists: B.truelist = B1.falselist and B.falselist = B1.truelist.',
      );
    }
    if (expr.kind === 'bool') {
      const production = expr.value ? 'B → true' : 'B → false';
      const number = this.nextinstr;
      const list = this.makelist(
        number,
        expr.value ? 'B.truelist' : 'B.falselist',
        production,
        expr,
      );
      this.emitInstr(
        'jump',
        'goto',
        null,
        production,
        expr,
        'The result is known, so this is one jump. Its target is still blank.',
      );
      return this.finishBoolean(
        expr,
        expr.value ? list : [],
        expr.value ? [] : list,
        production,
        `The other list is empty, because this expression is always ${expr.value}.`,
      );
    }
    if (expr.kind === 'binary' && isComparison(expr.op)) {
      const production = 'B → E1 rel E2';
      const left = this.value(expr.left);
      const right = this.value(expr.right);
      const truelist = this.makelist(this.nextinstr, 'B.truelist', production, expr);
      const falselist = this.makelist(this.nextinstr + 1, 'B.falselist', production, expr);
      this.emitInstr(
        'jump',
        `if ${left} ${expr.op} ${right} goto`,
        null,
        production,
        expr,
        'The true exit jumps to a place nobody knows yet, so its target stays blank.',
      );
      this.emitInstr(
        'jump',
        'goto',
        null,
        production,
        expr,
        'The false exit is the same: a jump with a blank target.',
      );
      return this.finishBoolean(
        expr,
        truelist,
        falselist,
        production,
        `B.truelist = ${showList(truelist)} and B.falselist = ${showList(falselist)}.`,
      );
    }
    // Any other value, like a plain variable, counts as true when it is not zero.
    const production = 'B → E';
    const value = this.value(expr);
    const truelist = this.makelist(this.nextinstr, 'B.truelist', production, expr);
    const falselist = this.makelist(this.nextinstr + 1, 'B.falselist', production, expr);
    this.emitInstr(
      'jump',
      `if ${value} goto`,
      null,
      production,
      expr,
      'The true exit has a blank target.',
    );
    this.emitInstr('jump', 'goto', null, production, expr, 'The false exit has a blank target.');
    return this.finishBoolean(
      expr,
      truelist,
      falselist,
      production,
      `B.truelist = ${showList(truelist)} and B.falselist = ${showList(falselist)}.`,
    );
  }

  private finishBoolean(
    expr: IrExpr,
    truelist: number[],
    falselist: number[],
    production: string,
    explanation: string,
  ): BooleanLists {
    this.attach(expr, { truelist, falselist });
    this.add(
      `B: ${this.textOf(expr)}`,
      `${explanation} This node now has truelist ${showList(truelist)} and falselist ${showList(falselist)}.`,
      'attribute',
      production,
      expr,
    );
    return { truelist, falselist };
  }

  // ------ Statements (figure 6.46) ------

  private finishStatement(node: NodeSpan, nextlist: number[], production: string): number[] {
    this.attach(node, { nextlist });
    this.add(
      `S: ${this.textOf(node)}`,
      `This statement's nextlist is ${showList(nextlist)}: the jumps that must land on whatever follows it.`,
      'attribute',
      production,
      node,
    );
    return nextlist;
  }

  /** L → L1 M S: each statement's exits land on the start of the statement after it. */
  private statementList(list: readonly IrStmt[], node: NodeSpan): number[] {
    let next: number[] = [];
    let seenStatement = false;
    for (const statement of list) {
      if (statement.kind === 'decl') {
        this.declare(statement);
        continue;
      }
      if (!seenStatement) {
        next = this.statement(statement);
        seenStatement = true;
        continue;
      }
      const production = 'L → L1 M S';
      const m = this.marker('M', production, node);
      const after = this.statement(statement);
      this.backpatch(
        next,
        m,
        `The statements before this one finish by going to the start of this one, M.instr = ${m}.`,
        production,
        statement,
      );
      next = after;
    }
    return next;
  }

  private declare(statement: Extract<IrStmt, { kind: 'decl' }>): void {
    const symbol = irDeclareSymbol(this.symbols, statement, this.offset);
    this.offset += symbol.width;
  }

  private statement(statement: IrStmt): number[] {
    switch (statement.kind) {
      case 'decl':
        this.declare(statement);
        return [];
      case 'assign': {
        const production = 'S → A ;';
        const { target } = statement;
        if (target.kind === 'var') {
          const value = this.value(statement.value);
          this.emitInstr(
            'plain',
            `${target.name} = ${value}`,
            null,
            production,
            statement,
            'This assignment always continues to the next instruction.',
          );
        } else {
          const addr = this.location(target);
          const value = this.value(statement.value);
          this.emitInstr(
            'plain',
            `${target.base}[${addr}] = ${value}`,
            null,
            production,
            statement,
            'This assignment always continues to the next instruction.',
          );
        }
        return this.finishStatement(statement, [], production);
      }
      case 'expr': {
        const production = 'S → E ;';
        if (statement.expr.kind === 'call') this.callExpr(statement.expr, false);
        else this.value(statement.expr);
        return this.finishStatement(statement, [], production);
      }
      case 'block':
        return this.finishStatement(
          statement,
          this.statementList(statement.body, statement),
          'S → { L }',
        );
      case 'if':
        return statement.elseBranch
          ? this.ifElseStatement(statement, statement.elseBranch)
          : this.ifStatement(statement);
      case 'while':
        return this.whileStatement(statement);
      case 'switch':
        return this.switchStatement(statement);
      case 'break': {
        const production = 'S → break ;';
        const number = this.nextinstr;
        const list = this.breakLists.at(-1) as number[];
        list.push(number);
        this.emitInstr(
          'jump',
          'goto',
          null,
          production,
          statement,
          'break leaves the enclosing statement. Where that ends is not known yet, so this joins its list of exits.',
        );
        return [];
      }
      case 'return': {
        const production = 'S → return E ;';
        const value = statement.value ? this.value(statement.value) : null;
        this.emitInstr(
          'plain',
          value ? `return ${value}` : 'return',
          null,
          production,
          statement,
          'Control leaves the function here.',
        );
        return this.finishStatement(statement, [], production);
      }
    }
  }

  private ifStatement(statement: Extract<IrStmt, { kind: 'if' }>): number[] {
    const production = 'S → if ( B ) M S1';
    const b = this.boolean(statement.cond);
    const m = this.marker('M', production, statement);
    const s1 = this.statement(statement.thenBranch);
    this.backpatch(
      b.truelist,
      m,
      `A true condition goes to the body, which starts at M.instr = ${m}.`,
      production,
      statement,
    );
    const nextlist = this.merge(b.falselist, s1, 'S.nextlist', production, statement);
    return this.finishStatement(statement, nextlist, production);
  }

  private ifElseStatement(
    statement: Extract<IrStmt, { kind: 'if' }>,
    elseBranch: IrStmt,
  ): number[] {
    const production = 'S → if ( B ) M1 S1 N else M2 S2';
    const b = this.boolean(statement.cond);
    const m1 = this.marker('M1', production, statement);
    const s1 = this.statement(statement.thenBranch);
    const n = this.makelist(this.nextinstr, 'N.nextlist', production, statement);
    this.emitInstr(
      'jump',
      'goto',
      null,
      production,
      statement,
      'N → ε: the first branch must skip the second. Where the whole statement ends is not known yet, so the target is blank.',
    );
    const m2 = this.marker('M2', production, statement);
    const s2 = this.statement(elseBranch);
    this.backpatch(
      b.truelist,
      m1,
      `A true condition goes to the first branch, at M1.instr = ${m1}.`,
      production,
      statement,
    );
    this.backpatch(
      b.falselist,
      m2,
      `A false condition goes to the second branch, at M2.instr = ${m2}.`,
      production,
      statement,
    );
    const temp = this.merge(s1, n, 'temp', production, statement);
    const nextlist = this.merge(temp, s2, 'S.nextlist', production, statement);
    return this.finishStatement(statement, nextlist, production);
  }

  private whileStatement(statement: Extract<IrStmt, { kind: 'while' }>): number[] {
    const production = 'S → while M1 ( B ) M2 S1';
    const m1 = this.marker('M1', production, statement);
    const b = this.boolean(statement.cond);
    const m2 = this.marker('M2', production, statement);
    this.breakLists.push([]);
    const s1 = this.statement(statement.body);
    const breaks = this.breakLists.pop() as number[];
    this.backpatch(
      s1,
      m1,
      `After the body, control goes back to the test, at M1.instr = ${m1}.`,
      production,
      statement,
    );
    this.backpatch(
      b.truelist,
      m2,
      `A true condition goes to the body, at M2.instr = ${m2}.`,
      production,
      statement,
    );
    this.emitInstr(
      'jump',
      'goto',
      m1,
      production,
      statement,
      `The body falls into a jump back to the test, ${m1}, which is already known.`,
    );
    const nextlist =
      breaks.length > 0
        ? this.merge(b.falselist, breaks, 'S.nextlist', production, statement)
        : b.falselist;
    return this.finishStatement(statement, nextlist, production);
  }

  /** The layout of figure 6.49. Each case's start is known by the time the tests are emitted. */
  private switchStatement(statement: Extract<IrStmt, { kind: 'switch' }>): number[] {
    const production = 'S → switch ( E ) { cases }';
    const subject = this.value(statement.subject);
    const toTests = this.makelist(this.nextinstr, 'test jump', production, statement);
    this.emitInstr(
      'jump',
      'goto',
      null,
      production,
      statement,
      'The tests come after all the bodies, and where they start is not known yet.',
    );
    const starts: number[] = [];
    let nextlist: number[] = [];
    this.breakLists.push([]);
    for (const item of statement.cases) {
      starts.push(this.nextinstr);
      const caseNode = { id: statement.id, start: item.start, end: item.end };
      const inner = this.statementList(item.body, caseNode);
      nextlist = [...nextlist, ...inner];
      if (item.body.at(-1)?.kind !== 'break') {
        nextlist = [...nextlist, this.nextinstr];
        this.emitInstr(
          'jump',
          'goto',
          null,
          production,
          caseNode,
          'The case is done, so it jumps past the whole switch, which has a blank target for now.',
        );
      }
    }
    nextlist = [...nextlist, ...(this.breakLists.pop() as number[])];
    this.backpatch(
      toTests,
      this.nextinstr,
      'All the bodies are emitted, so the tests start at the next instruction.',
      production,
      statement,
    );
    statement.cases.forEach((item, index) => {
      if (item.value === null) return;
      this.emitInstr(
        'jump',
        `if ${subject} == ${item.value} goto`,
        starts[index] as number,
        production,
        { start: item.start, end: item.end },
        `This case's body is at ${starts[index]}, which is already known.`,
      );
    });
    const defaultIndex = statement.cases.findIndex((item) => item.value === null);
    if (defaultIndex >= 0) {
      this.emitInstr(
        'jump',
        'goto',
        starts[defaultIndex] as number,
        production,
        statement,
        'No value matched, so it goes to the default body.',
      );
    } else {
      nextlist = [...nextlist, this.nextinstr];
      this.emitInstr(
        'jump',
        'goto',
        null,
        production,
        statement,
        'No value matched and there is no default, so it leaves the switch.',
      );
    }
    return this.finishStatement(statement, nextlist, production);
  }

  run(): IrBackpatchResult {
    const { body } = this.program;
    this.add(
      'Start',
      `Instructions are numbered from ${this.first}, and nextinstr says what the next one will be. A jump whose target is not known yet gets a blank, written _.`,
      'start',
      '',
      null,
    );
    const only = body[0];
    if (body.length === 1 && only?.kind === 'expr' && isBooleanExpr(only.expr)) {
      const lists = this.boolean(only.expr);
      this.add(
        'Finished',
        `The expression is translated. Its truelist is ${showList(lists.truelist)} and its falselist is ${showList(lists.falselist)}. Those blanks stay open until the statement around this expression says where true and false should go.`,
        'finished',
        '',
        null,
        { list: [...lists.truelist, ...lists.falselist] },
      );
      return this.result('boolean', lists);
    }
    const nextlist = this.statementList(body, {
      id: -1,
      start: 0,
      end: this.program.source.length,
    });
    this.backpatch(
      nextlist,
      this.nextinstr,
      'The program is over, so any exit left over goes to whatever comes after the last instruction.',
      'P → L',
      null,
    );
    this.add(
      'Finished',
      `The program is translated into ${this.instructions.length} instruction${this.instructions.length === 1 ? '' : 's'}, with no blanks left.`,
      'finished',
      '',
      null,
    );
    return this.result('statements', { truelist: [], falselist: [] });
  }

  private result(mode: IrBackpatchResult['mode'], lists: BooleanLists): IrBackpatchResult {
    return {
      program: this.program,
      mode,
      instructions: this.instructions,
      truelist: lists.truelist,
      falselist: lists.falselist,
      symbols: [...this.symbols.values()],
      trace: this.recorder.finish(),
    };
  }
}

/**
 * Translates with backpatching. A lone boolean expression, like a < b or c < d and e < f, keeps its
 * lists open as in the book. Anything else is translated as statements.
 */
export function irBackpatch(
  source: string,
  firstInstruction: number = IR_BACKPATCH_START,
): IrBackpatchResult {
  return new Backpatcher(irParse(source), firstInstruction).run();
}
