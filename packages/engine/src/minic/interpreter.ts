import { EngineError } from '../core/result';
import type { CType, Declarator, Expr, FuncDef, Program, Scalar, Stmt } from './parser';
import { formatPrintf } from './printf';

/** A floating-point value. Plain numbers are integers, which keeps integer division right. */
export class Flt {
  constructor(readonly v: number) {}
}

export type CellKind = Scalar | 'ptr';

/** A place in memory: a cell array and an index into it. */
export class Ptr {
  constructor(
    readonly mem: Cell[],
    readonly off: number,
    readonly elem: CellKind,
  ) {}
}

export type Value = number | Flt | Ptr;
export type Cell = Value;

interface Variable {
  mem: Cell[];
  off: number;
  kind: CellKind;
  pointee: CellKind;
  isArray: boolean;
  byteSize: number;
  elementSize: number;
}

export class Scope {
  readonly vars = new Map<string, Variable>();
  ownedCells = 0;
  constructor(readonly parent: Scope | null) {}

  find(name: string): Variable | undefined {
    return this.vars.get(name) ?? this.parent?.find(name);
  }
}

/** How a statement ended. */
export type Signal =
  { kind: 'break' } | { kind: 'continue' } | { kind: 'return'; value: Value } | null;

/** exit(), or the end of main. */
export class ExitSignal {
  constructor(readonly code: number) {}
}

export type Step = Generator<void, Value, void>;
export type Builtin = (args: Value[], at: number) => Value | Step;

export type OutputStream = 'stdout' | 'stderr';

export interface InterpreterHost {
  write(stream: OutputStream, bytes: readonly number[]): void;
  /** The next byte of input, or -1 at the end. */
  readByte(): number;
}

const SIZES: Readonly<Record<CellKind, number>> = {
  char: 1,
  uchar: 1,
  short: 2,
  int: 4,
  uint: 4,
  long: 8,
  float: 4,
  double: 8,
  void: 1,
  ptr: 8,
};

const MAX_CALL_DEPTH = 200;
/** Stops a runaway program long before it can take the whole server's memory with it. */
const MAX_LIVE_CELLS = 8_000_000;

const NO_RETURN: Value = 0;

function isGenerator(value: unknown): value is Step {
  return typeof value === 'object' && value !== null && 'next' in value;
}

function kindOf(type: CType): CellKind {
  return type.pointers > 0 ? 'ptr' : type.scalar;
}

function pointeeOf(type: CType): CellKind {
  return type.pointers > 1 ? 'ptr' : type.scalar;
}

function isFloatKind(kind: CellKind): boolean {
  return kind === 'float' || kind === 'double';
}

export class Interpreter {
  readonly globals = new Scope(null);
  private depth = 0;
  private liveCells = 0;
  private readonly strings = new Map<Expr, Ptr>();
  private readonly builtins: Map<string, Builtin>;

  constructor(
    private readonly program: Program,
    private readonly host: InterpreterHost,
    extraBuiltins: Readonly<Record<string, Builtin>> = {},
  ) {
    this.builtins = new Map(Object.entries({ ...this.standardLibrary(), ...extraBuiltins }));
    this.defineConstant('NULL', 0);
    this.defineConstant('EOF', -1);
    this.defineConstant('stdin', 0);
    this.defineConstant('stdout', 1);
    this.defineConstant('stderr', 2);
    this.defineConstant('true', 1);
    this.defineConstant('false', 0);
    this.defineConstant('EXIT_SUCCESS', 0);
    this.defineConstant('EXIT_FAILURE', 1);
  }

  defineConstant(name: string, value: number): void {
    this.globals.vars.set(name, {
      mem: [value],
      off: 0,
      kind: 'int',
      pointee: 'int',
      isArray: false,
      byteSize: 4,
      elementSize: 4,
    });
  }

  /** A global the host reads and writes, like yytext and yyleng. */
  defineGlobal(name: string, kind: CellKind, value: Value, pointee: CellKind = 'int'): Variable {
    const variable: Variable = {
      mem: [value],
      off: 0,
      kind,
      pointee,
      isArray: false,
      byteSize: SIZES[kind],
      elementSize: SIZES[kind],
    };
    this.globals.vars.set(name, variable);
    return variable;
  }

  hasFunction(name: string): boolean {
    return this.program.functions.has(name);
  }

  *initializeGlobals(): Generator<void, void, void> {
    for (const statement of this.program.globals) {
      yield* this.exec(statement, this.globals);
    }
  }

  /** Calls a function the student wrote. */
  *callFunction(name: string, args: Value[], at: number): Step {
    return yield* this.call(this.program.functions.get(name) as FuncDef, args, at);
  }

  /** Runs statements that are not in a function, such as a flex action. */
  *runBody(body: readonly Stmt[], scope: Scope): Generator<void, Signal, void> {
    return yield* this.execList(body, new Scope(scope));
  }

  /** Runs statements directly in `scope`, so their declarations stay visible afterwards. */
  *runIn(body: readonly Stmt[], scope: Scope): Generator<void, Signal, void> {
    for (const statement of body) {
      const signal = yield* this.exec(statement, scope);
      if (signal) return signal;
    }
    return null;
  }

  fail(message: string, at: number, hint?: string): never {
    throw new EngineError({
      code: 'c_runtime',
      message,
      position: at,
      length: 1,
      ...(hint ? { hint } : {}),
    });
  }

  private *execList(body: readonly Stmt[], scope: Scope): Generator<void, Signal, void> {
    try {
      for (const statement of body) {
        const signal = yield* this.exec(statement, scope);
        if (signal) return signal;
      }
      return null;
    } finally {
      this.liveCells -= scope.ownedCells;
    }
  }

  private *exec(statement: Stmt, scope: Scope): Generator<void, Signal, void> {
    yield;
    switch (statement.kind) {
      case 'expr':
        yield* this.eval(statement.expr, scope);
        return null;
      case 'decl':
        for (const declarator of statement.declarators) yield* this.declare(declarator, scope);
        return null;
      case 'enum': {
        let next = 0;
        for (const item of statement.items) {
          if (item.value) next = this.toInt(yield* this.eval(item.value, scope), item.value.at);
          this.declareEnum(item.name, next, scope);
          next++;
        }
        return null;
      }
      case 'block':
        return yield* this.execList(statement.body, new Scope(scope));
      case 'group':
        return yield* this.runIn(statement.body, scope);
      case 'if': {
        const test = yield* this.eval(statement.test, scope);
        if (this.truthy(test)) return yield* this.exec(statement.yes, scope);
        return statement.no ? yield* this.exec(statement.no, scope) : null;
      }
      case 'while':
        while (this.truthy(yield* this.eval(statement.test, scope))) {
          const signal = yield* this.exec(statement.body, scope);
          if (signal?.kind === 'break') break;
          if (signal?.kind === 'return') return signal;
          yield;
        }
        return null;
      case 'do':
        do {
          const signal = yield* this.exec(statement.body, scope);
          if (signal?.kind === 'break') break;
          if (signal?.kind === 'return') return signal;
          yield;
        } while (this.truthy(yield* this.eval(statement.test, scope)));
        return null;
      case 'for': {
        const inner = new Scope(scope);
        try {
          if (statement.init) yield* this.exec(statement.init, inner);
          while (!statement.test || this.truthy(yield* this.eval(statement.test, inner))) {
            const signal = yield* this.exec(statement.body, inner);
            if (signal?.kind === 'break') break;
            if (signal?.kind === 'return') return signal;
            if (statement.update) yield* this.eval(statement.update, inner);
            yield;
          }
          return null;
        } finally {
          this.liveCells -= inner.ownedCells;
        }
      }
      case 'return':
        return {
          kind: 'return',
          value: statement.value ? yield* this.eval(statement.value, scope) : NO_RETURN,
        };
      case 'break':
        return { kind: 'break' };
      case 'continue':
        return { kind: 'continue' };
      case 'switch':
        return yield* this.execSwitch(statement, scope);
    }
  }

  private *execSwitch(
    statement: Extract<Stmt, { kind: 'switch' }>,
    scope: Scope,
  ): Generator<void, Signal, void> {
    const test = this.toInt(yield* this.eval(statement.test, scope), statement.at);
    let start = -1;
    let fallback = -1;
    for (const label of statement.labels) {
      if (label.value === null) {
        fallback = label.index;
      } else if (this.toInt(yield* this.eval(label.value, scope), label.value.at) === test) {
        start = label.index;
        break;
      }
    }
    if (start === -1) start = fallback;
    if (start === -1) return null;
    const inner = new Scope(scope);
    try {
      for (const body of statement.body.slice(start)) {
        const signal = yield* this.exec(body, inner);
        if (signal?.kind === 'break') return null;
        if (signal) return signal;
      }
      return null;
    } finally {
      this.liveCells -= inner.ownedCells;
    }
  }

  private declareEnum(name: string, value: number, scope: Scope): void {
    scope.vars.set(name, {
      mem: [value],
      off: 0,
      kind: 'int',
      pointee: 'int',
      isArray: false,
      byteSize: 4,
      elementSize: 4,
    });
  }

  private reserve(cells: number, at: number, scope: Scope | null): void {
    if (this.liveCells + cells > MAX_LIVE_CELLS) {
      this.fail(
        'This program asked for more memory than Simulated mode allows.',
        at,
        'Use smaller arrays. Real gcc has a much higher limit.',
      );
    }
    this.liveCells += cells;
    if (scope) scope.ownedCells += cells;
  }

  private zeroFor(kind: CellKind): Value {
    return isFloatKind(kind) ? new Flt(0) : 0;
  }

  /** Builds an array. A 2-D array is an array of pointers to its rows. */
  private allocateArray(
    sizes: readonly number[],
    kind: CellKind,
    at: number,
    scope: Scope | null,
  ): Ptr {
    const [size = 0, ...rest] = sizes;
    this.reserve(size, at, scope);
    if (rest.length === 0) {
      const zero = this.zeroFor(kind);
      return new Ptr(new Array<Cell>(size).fill(zero), 0, kind);
    }
    const rows: Cell[] = [];
    for (let i = 0; i < size; i++) rows.push(this.allocateArray(rest, kind, at, scope));
    return new Ptr(rows, 0, 'ptr');
  }

  private *declare(declarator: Declarator, scope: Scope): Generator<void, void, void> {
    const { name, type, dims, init, at } = declarator;
    const elementKind = kindOf(type);
    if (dims.length === 0) {
      if (type.pointers === 0 && type.scalar === 'void') {
        this.fail(`The variable ${name} cannot have type void.`, at, 'Use a type like int.');
      }
      let value = this.zeroFor(elementKind);
      if (init) {
        if (init.kind === 'list') this.fail(`The variable ${name} is not an array.`, init.at);
        value = this.coerce(yield* this.eval(init, scope), elementKind, pointeeOf(type), at);
      }
      scope.vars.set(name, {
        mem: [value],
        off: 0,
        kind: elementKind,
        pointee: pointeeOf(type),
        isArray: false,
        byteSize: SIZES[elementKind],
        elementSize: SIZES[elementKind],
      });
      return;
    }

    const sizes: number[] = [];
    for (let i = 0; i < dims.length; i++) {
      const dim = dims[i] as Expr | null;
      if (dim) {
        const size = this.toInt(yield* this.eval(dim, scope), dim.at);
        if (size <= 0) this.fail(`The array ${name} needs a size of at least 1.`, dim.at);
        sizes.push(size);
      } else if (i === 0 && init?.kind === 'string') {
        sizes.push(init.bytes.length + 1);
      } else if (i === 0 && init?.kind === 'list') {
        sizes.push(init.items.length);
      } else {
        this.fail(
          `The array ${name} needs a size.`,
          at,
          'Give it a size, or an initializer so C can work it out.',
        );
      }
    }
    const array = this.allocateArray(sizes, elementKind, at, scope === this.globals ? null : scope);
    if (init) yield* this.initializeArray(array, init, sizes, elementKind, type, scope, name);
    const totalCells = sizes.reduce((total, size) => total * size, 1);
    const innerCells = sizes.slice(1).reduce((total, size) => total * size, 1);
    scope.vars.set(name, {
      mem: [array],
      off: 0,
      kind: 'ptr',
      pointee: array.elem,
      isArray: true,
      byteSize: totalCells * SIZES[elementKind],
      elementSize: innerCells * SIZES[elementKind],
    });
  }

  private *initializeArray(
    array: Ptr,
    init: Expr,
    sizes: readonly number[],
    kind: CellKind,
    type: CType,
    scope: Scope,
    name: string,
  ): Generator<void, void, void> {
    const size = sizes[0] as number;
    if (init.kind === 'string' && sizes.length === 1 && (kind === 'char' || kind === 'uchar')) {
      if (init.bytes.length >= size + 1) {
        this.fail(`The text for ${name} does not fit in the array.`, init.at, 'Make it larger.');
      }
      init.bytes.forEach((byte, index) => {
        array.mem[index] = (byte << 24) >> 24;
      });
      return;
    }
    if (init.kind !== 'list') {
      this.fail(`The array ${name} needs a { ... } initializer.`, init.at);
    }
    if (init.items.length > size) {
      this.fail(`The array ${name} has more initial values than places.`, init.at);
    }
    for (let i = 0; i < init.items.length; i++) {
      const item = init.items[i] as Expr;
      if (sizes.length > 1) {
        const row = array.mem[i] as Ptr;
        yield* this.initializeArray(row, item, sizes.slice(1), kind, type, scope, name);
      } else {
        const value = yield* this.eval(item, scope);
        array.mem[i] = this.coerce(value, kind, pointeeOf(type), item.at);
      }
    }
  }

  truthy(value: Value): boolean {
    if (value instanceof Flt) return value.v !== 0;
    if (value instanceof Ptr) return true;
    return value !== 0;
  }

  toInt(value: Value, at: number): number {
    if (value instanceof Flt) return Math.trunc(value.v);
    if (value instanceof Ptr) {
      this.fail('A pointer was used where a whole number is needed.', at);
    }
    return value;
  }

  private toNumber(value: Value, at: number): number {
    return value instanceof Flt ? value.v : this.toInt(value, at);
  }

  private coerce(value: Value, kind: CellKind, pointee: CellKind, at: number): Value {
    switch (kind) {
      case 'ptr':
        if (value instanceof Flt) this.fail('A decimal number cannot be stored in a pointer.', at);
        if (value instanceof Ptr && value.elem !== pointee && pointee !== 'void') {
          return new Ptr(value.mem, value.off, pointee);
        }
        return value;
      case 'float':
      case 'double':
        return value instanceof Flt ? value : new Flt(this.toNumber(value, at));
      case 'char':
        return (this.toInt(value, at) << 24) >> 24;
      case 'uchar':
        return this.toInt(value, at) & 0xff;
      case 'short':
        return (this.toInt(value, at) << 16) >> 16;
      case 'int':
        return this.toInt(value, at) | 0;
      case 'uint':
        return this.toInt(value, at) >>> 0;
      case 'long':
        return Math.trunc(this.toInt(value, at));
      case 'void':
        return value;
    }
  }

  /** A place a value can be stored. */
  private *locate(
    expr: Expr,
    scope: Scope,
  ): Generator<void, { mem: Cell[]; off: number; kind: CellKind; pointee: CellKind }, void> {
    switch (expr.kind) {
      case 'name': {
        const variable = scope.find(expr.name);
        if (!variable) this.undeclared(expr.name, expr.at);
        if (variable.isArray) {
          this.fail(
            `The array ${expr.name} cannot be assigned to.`,
            expr.at,
            'Copy it with strcpy.',
          );
        }
        return variable;
      }
      case 'index': {
        const base = yield* this.eval(expr.base, scope);
        const index = this.toInt(yield* this.eval(expr.index, scope), expr.index.at);
        if (!(base instanceof Ptr)) this.nullAccess(base, expr.at);
        return this.place(base, base.off + index, expr.at);
      }
      case 'deref': {
        const base = yield* this.eval(expr.operand, scope);
        if (!(base instanceof Ptr)) this.nullAccess(base, expr.at);
        return this.place(base, base.off, expr.at);
      }
      default:
        return this.fail(
          'This cannot be assigned to.',
          expr.at,
          'The left side of = must be a variable, an array element or *pointer.',
        );
    }
  }

  private place(pointer: Ptr, off: number, at: number) {
    if (off < 0 || off >= pointer.mem.length) this.outOfBounds(off, pointer.mem.length, at);
    return { mem: pointer.mem, off, kind: pointer.elem, pointee: 'void' as CellKind };
  }

  private undeclared(name: string, at: number): never {
    return this.fail(
      `${name} is used here, but it is not declared.`,
      at,
      `Declare it first, as in: int ${name};`,
    );
  }

  private nullAccess(value: Value, at: number): never {
    return this.fail(
      value === 0
        ? 'This reads through a null pointer, which would be a segmentation fault in real C.'
        : 'This treats a value that is not a pointer as if it were one.',
      at,
      'Check that the pointer was set before using it.',
    );
  }

  private outOfBounds(index: number, length: number, at: number): never {
    return this.fail(
      `This reaches position ${index} of an array with ${length} places. Real C would not stop you, but the program would misbehave.`,
      at,
      'Check the loop bounds and array sizes.',
    );
  }

  private *eval(expr: Expr, scope: Scope): Step {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'float':
        return new Flt(expr.value);
      case 'string':
        return this.stringLiteral(expr);
      case 'name': {
        const variable = scope.find(expr.name);
        if (!variable) this.undeclared(expr.name, expr.at);
        return variable.mem[variable.off] as Value;
      }
      case 'assign':
        return yield* this.evalAssign(expr, scope);
      case 'unary':
        return this.evalUnary(expr.op, yield* this.eval(expr.operand, scope), expr.at);
      case 'incdec': {
        const place = yield* this.locate(expr.target, scope);
        const old = place.mem[place.off] as Value;
        const step = expr.op === '++' ? 1 : -1;
        const updated =
          old instanceof Ptr
            ? new Ptr(old.mem, old.off + step, old.elem)
            : this.coerce(
                this.arithmetic('+', old, step, expr.at),
                place.kind,
                place.pointee,
                expr.at,
              );
        place.mem[place.off] = updated;
        return expr.prefix ? updated : old;
      }
      case 'binary': {
        const left = yield* this.eval(expr.left, scope);
        const right = yield* this.eval(expr.right, scope);
        return this.arithmetic(expr.op, left, right, expr.at);
      }
      case 'logical': {
        const left = this.truthy(yield* this.eval(expr.left, scope));
        if (expr.op === '&&' && !left) return 0;
        if (expr.op === '||' && left) return 1;
        return this.truthy(yield* this.eval(expr.right, scope)) ? 1 : 0;
      }
      case 'cond':
        return this.truthy(yield* this.eval(expr.test, scope))
          ? yield* this.eval(expr.yes, scope)
          : yield* this.eval(expr.no, scope);
      case 'call':
        return yield* this.evalCall(expr, scope);
      case 'index':
        return yield* this.readIndex(expr, scope);
      case 'deref': {
        const pointer = yield* this.eval(expr.operand, scope);
        if (!(pointer instanceof Ptr)) this.nullAccess(pointer, expr.at);
        return this.read(pointer, pointer.off, expr.at);
      }
      case 'addr':
        return yield* this.evalAddress(expr, scope);
      case 'comma':
        yield* this.eval(expr.left, scope);
        return yield* this.eval(expr.right, scope);
      case 'cast':
        return this.evalCast(expr.type, yield* this.eval(expr.operand, scope), expr.at);
      case 'sizeof-type':
        return SIZES[kindOf(expr.type)];
      case 'sizeof-expr':
        return this.sizeOf(expr.operand, scope);
      case 'list':
        return this.fail('A { ... } list can only initialize an array.', expr.at);
    }
  }

  private read(pointer: Ptr, off: number, at: number): Value {
    if (off < 0 || off >= pointer.mem.length) this.outOfBounds(off, pointer.mem.length, at);
    return pointer.mem[off] as Value;
  }

  private *readIndex(expr: Extract<Expr, { kind: 'index' }>, scope: Scope): Step {
    const base = yield* this.eval(expr.base, scope);
    const index = this.toInt(yield* this.eval(expr.index, scope), expr.index.at);
    if (!(base instanceof Ptr)) this.nullAccess(base, expr.at);
    return this.read(base, base.off + index, expr.at);
  }

  private *evalAddress(expr: Extract<Expr, { kind: 'addr' }>, scope: Scope): Step {
    const operand = expr.operand;
    if (operand.kind === 'name') {
      const variable = scope.find(operand.name);
      if (!variable) this.undeclared(operand.name, operand.at);
      if (variable.isArray) return variable.mem[variable.off] as Value;
      return new Ptr(variable.mem, variable.off, variable.kind);
    }
    if (operand.kind === 'index' || operand.kind === 'deref') {
      const place = yield* this.locate(operand, scope);
      return new Ptr(place.mem, place.off, place.kind);
    }
    return this.fail('This has no address.', expr.at, 'Use & on a variable or array element.');
  }

  private evalCast(type: CType, value: Value, at: number): Value {
    if (type.pointers === 0 && type.scalar === 'void') return 0;
    return this.coerce(value, kindOf(type), pointeeOf(type), at);
  }

  private sizeOf(operand: Expr, scope: Scope): number {
    if (operand.kind === 'name') {
      const variable = scope.find(operand.name);
      if (!variable) this.undeclared(operand.name, operand.at);
      return variable.byteSize;
    }
    if (operand.kind === 'index' && operand.base.kind === 'name') {
      const variable = scope.find(operand.base.name);
      if (!variable) this.undeclared(operand.base.name, operand.base.at);
      return variable.elementSize;
    }
    if (operand.kind === 'string') return operand.bytes.length + 1;
    return 4;
  }

  private stringLiteral(expr: Extract<Expr, { kind: 'string' }>): Ptr {
    let found = this.strings.get(expr);
    if (!found) {
      found = new Ptr([...expr.bytes.map((byte) => (byte << 24) >> 24), 0], 0, 'char');
      this.strings.set(expr, found);
    }
    return found;
  }

  private *evalAssign(expr: Extract<Expr, { kind: 'assign' }>, scope: Scope): Step {
    const place = yield* this.locate(expr.target, scope);
    let value = yield* this.eval(expr.value, scope);
    if (expr.op !== '=') {
      value = this.arithmetic(expr.op.slice(0, -1), place.mem[place.off] as Value, value, expr.at);
    }
    const stored = this.coerce(value, place.kind, place.pointee, expr.at);
    place.mem[place.off] = stored;
    return stored;
  }

  private evalUnary(op: string, value: Value, at: number): Value {
    switch (op) {
      case '-':
        return value instanceof Flt ? new Flt(-value.v) : -this.toInt(value, at);
      case '+':
        return value;
      case '!':
        return this.truthy(value) ? 0 : 1;
      default:
        return ~this.toInt(value, at);
    }
  }

  private arithmetic(op: string, left: Value, right: Value, at: number): Value {
    if (left instanceof Ptr || right instanceof Ptr) return this.pointerMath(op, left, right, at);
    if (left instanceof Flt || right instanceof Flt) {
      return this.floatMath(op, this.toNumber(left, at), this.toNumber(right, at), at);
    }
    switch (op) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) this.divideByZero(at);
        return Math.trunc(left / right);
      case '%':
        if (right === 0) this.divideByZero(at);
        return left % right;
      case '==':
        return left === right ? 1 : 0;
      case '!=':
        return left !== right ? 1 : 0;
      case '<':
        return left < right ? 1 : 0;
      case '>':
        return left > right ? 1 : 0;
      case '<=':
        return left <= right ? 1 : 0;
      case '>=':
        return left >= right ? 1 : 0;
      case '&':
        return left & right;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      case '<<':
        return left << right;
      default:
        return left >> right;
    }
  }

  private divideByZero(at: number): never {
    return this.fail(
      'This divides by zero, which would crash a real program.',
      at,
      'Check the divisor before dividing.',
    );
  }

  private floatMath(op: string, left: number, right: number, at: number): Value {
    switch (op) {
      case '+':
        return new Flt(left + right);
      case '-':
        return new Flt(left - right);
      case '*':
        return new Flt(left * right);
      case '/':
        return new Flt(left / right);
      case '==':
        return left === right ? 1 : 0;
      case '!=':
        return left !== right ? 1 : 0;
      case '<':
        return left < right ? 1 : 0;
      case '>':
        return left > right ? 1 : 0;
      case '<=':
        return left <= right ? 1 : 0;
      case '>=':
        return left >= right ? 1 : 0;
      default:
        return this.fail(`The ${op} operator needs whole numbers, not decimals.`, at);
    }
  }

  private pointerMath(op: string, left: Value, right: Value, at: number): Value {
    if (left instanceof Ptr && right instanceof Ptr) {
      if (op === '==' || op === '!=') {
        const same = left.mem === right.mem && left.off === right.off;
        return (op === '==') === same ? 1 : 0;
      }
      if (left.mem !== right.mem) {
        this.fail('These two pointers point into different arrays.', at);
      }
      switch (op) {
        case '-':
          return left.off - right.off;
        case '<':
          return left.off < right.off ? 1 : 0;
        case '>':
          return left.off > right.off ? 1 : 0;
        case '<=':
          return left.off <= right.off ? 1 : 0;
        case '>=':
          return left.off >= right.off ? 1 : 0;
        default:
          return this.fail(`The ${op} operator does not work on two pointers.`, at);
      }
    }
    // Comparing a pointer with 0 is how C spells a null check.
    if (op === '==' || op === '!=') {
      const zero = left instanceof Ptr ? right === 0 : left === 0;
      if (zero) return op === '==' ? 0 : 1;
      this.fail('A pointer can only be compared with another pointer, or with NULL.', at);
    }
    if (left instanceof Ptr && (op === '+' || op === '-')) {
      const distance = this.toInt(right, at);
      return new Ptr(left.mem, left.off + (op === '+' ? distance : -distance), left.elem);
    }
    if (right instanceof Ptr && op === '+') {
      return new Ptr(right.mem, right.off + this.toInt(left, at), right.elem);
    }
    return this.fail(`The ${op} operator does not work on a pointer.`, at);
  }

  private *evalCall(expr: Extract<Expr, { kind: 'call' }>, scope: Scope): Step {
    const args: Value[] = [];
    for (const arg of expr.args) args.push(yield* this.eval(arg, scope));
    const defined = this.program.functions.get(expr.callee);
    if (defined) return yield* this.call(defined, args, expr.at);
    const builtin = this.builtins.get(expr.callee);
    if (!builtin) {
      return this.fail(
        `Simulated mode has no function named ${expr.callee}.`,
        expr.at,
        'Define it yourself, or install flex and gcc to use the full C library.',
      );
    }
    const result = builtin(args, expr.at);
    return isGenerator(result) ? yield* result : result;
  }

  private *call(func: FuncDef, args: Value[], at: number): Step {
    if (args.length !== func.params.length) {
      this.fail(
        `${func.name} takes ${func.params.length} argument${func.params.length === 1 ? '' : 's'}, but this call passes ${args.length}.`,
        at,
      );
    }
    if (this.depth >= MAX_CALL_DEPTH) {
      this.fail(
        `Function calls went more than ${MAX_CALL_DEPTH} levels deep. This is usually recursion that never stops.`,
        at,
        'Check the base case of the recursive function.',
      );
    }
    const scope = new Scope(this.globals);
    func.params.forEach((param, index) => {
      const kind = kindOf(param.type);
      scope.vars.set(param.name, {
        mem: [this.coerce(args[index] as Value, kind, pointeeOf(param.type), at)],
        off: 0,
        kind,
        pointee: pointeeOf(param.type),
        isArray: false,
        byteSize: SIZES[kind],
        elementSize: SIZES[kind],
      });
    });
    this.depth++;
    try {
      const signal = yield* this.execList(func.body, scope);
      if (signal?.kind === 'return') {
        const kind = kindOf(func.returns);
        return kind === 'void' ? 0 : this.coerce(signal.value, kind, pointeeOf(func.returns), at);
      }
      return NO_RETURN;
    } finally {
      this.depth--;
    }
  }

  /** The bytes of the C string at this pointer, without the terminator. */
  stringAt(value: Value, at: number): number[] {
    if (!(value instanceof Ptr)) this.nullAccess(value, at);
    const bytes: number[] = [];
    for (let i = value.off; ; i++) {
      if (i < 0 || i >= value.mem.length) {
        this.fail(
          'This string has no terminating zero byte, so C would keep reading past its end.',
          at,
          'Make the array one place longer, and end the text with \\0.',
        );
      }
      const cell = value.mem[i] as Value;
      const byte = this.toInt(cell, at);
      if (byte === 0) return bytes;
      bytes.push(byte & 0xff);
    }
  }

  private writeString(target: Value, bytes: readonly number[], at: number): void {
    if (!(target instanceof Ptr)) this.nullAccess(target, at);
    if (target.off + bytes.length >= target.mem.length) {
      this.fail(
        `This copies ${bytes.length + 1} bytes into a space of ${target.mem.length - target.off}, which would overrun it in real C.`,
        at,
        'Make the destination array larger.',
      );
    }
    bytes.forEach((byte, index) => {
      target.mem[target.off + index] = (byte << 24) >> 24;
    });
    target.mem[target.off + bytes.length] = 0;
  }

  private printfArgs(args: readonly Value[], first: number, at: number) {
    let next = first;
    const take = (): Value => {
      if (next >= args.length) {
        this.fail('This printf has more % conversions than values.', at, 'Add the missing value.');
      }
      return args[next++] as Value;
    };
    return {
      int: () => {
        const value = take();
        return value instanceof Flt ? Math.trunc(value.v) : this.pointerAsInt(value);
      },
      float: () => {
        const value = take();
        return value instanceof Flt ? value.v : this.pointerAsInt(value);
      },
      text: () => this.stringAt(take(), at),
      pointer: () => {
        const value = take();
        return value instanceof Ptr ? `0x${(value.off + 0x1000).toString(16)}` : '(nil)';
      },
    };
  }

  private pointerAsInt(value: Value): number {
    return value instanceof Ptr ? value.off : (value as number);
  }

  private streamOf(value: Value, at: number): OutputStream {
    if (value === 2) return 'stderr';
    if (value === 1) return 'stdout';
    return this.fail(
      'Simulated mode can only write to stdout and stderr.',
      at,
      'Install flex and gcc to work with files.',
    );
  }

  private formatted(args: readonly Value[], formatIndex: number, at: number): number[] {
    const format = args[formatIndex];
    if (format === undefined) this.fail('This call needs a format string.', at);
    return formatPrintf(this.stringAt(format, at), this.printfArgs(args, formatIndex + 1, at));
  }

  private characterClass(test: (code: number) => boolean): Builtin {
    return (args, at) => (test(this.toInt(args[0] as Value, at) & 0xff) ? 1 : 0);
  }

  private standardLibrary(): Record<string, Builtin> {
    const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
    const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
    const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
    const isAlpha = (c: number) => isUpper(c) || isLower(c);
    const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
    const compare = (a: readonly number[], b: readonly number[]) => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
      }
      return 0;
    };
    const text = (bytes: readonly number[]) => String.fromCharCode(...bytes);
    return {
      printf: (args, at) => {
        const bytes = this.formatted(args, 0, at);
        this.host.write('stdout', bytes);
        return bytes.length;
      },
      fprintf: (args, at) => {
        const bytes = this.formatted(args, 1, at);
        this.host.write(this.streamOf(args[0] as Value, at), bytes);
        return bytes.length;
      },
      sprintf: (args, at) => {
        const bytes = this.formatted(args, 1, at);
        this.writeString(args[0] as Value, bytes, at);
        return bytes.length;
      },
      puts: (args, at) => {
        this.host.write('stdout', [...this.stringAt(args[0] as Value, at), 0x0a]);
        return 1;
      },
      fputs: (args, at) => {
        this.host.write(this.streamOf(args[1] as Value, at), this.stringAt(args[0] as Value, at));
        return 1;
      },
      putchar: (args, at) => {
        const byte = this.toInt(args[0] as Value, at) & 0xff;
        this.host.write('stdout', [byte]);
        return byte;
      },
      putc: (args, at) => {
        const byte = this.toInt(args[0] as Value, at) & 0xff;
        this.host.write(this.streamOf(args[1] as Value, at), [byte]);
        return byte;
      },
      fputc: (args, at) => {
        const byte = this.toInt(args[0] as Value, at) & 0xff;
        this.host.write(this.streamOf(args[1] as Value, at), [byte]);
        return byte;
      },
      getchar: () => this.host.readByte(),
      strlen: (args, at) => this.stringAt(args[0] as Value, at).length,
      strcmp: (args, at) =>
        compare(this.stringAt(args[0] as Value, at), this.stringAt(args[1] as Value, at)),
      strncmp: (args, at) => {
        const limit = this.toInt(args[2] as Value, at);
        return compare(
          this.stringAt(args[0] as Value, at).slice(0, limit),
          this.stringAt(args[1] as Value, at).slice(0, limit),
        );
      },
      strcpy: (args, at) => {
        this.writeString(args[0] as Value, this.stringAt(args[1] as Value, at), at);
        return args[0] as Value;
      },
      strncpy: (args, at) => {
        const limit = this.toInt(args[2] as Value, at);
        const bytes = this.stringAt(args[1] as Value, at).slice(0, limit);
        const target = args[0] as Value;
        if (!(target instanceof Ptr)) this.nullAccess(target, at);
        if (target.off + limit > target.mem.length) {
          this.fail('This strncpy would write past the end of the destination.', at);
        }
        for (let i = 0; i < limit; i++)
          target.mem[target.off + i] = i < bytes.length ? (bytes[i] as number) : 0;
        return target;
      },
      strcat: (args, at) => {
        const start = this.stringAt(args[0] as Value, at);
        const addition = this.stringAt(args[1] as Value, at);
        this.writeString(args[0] as Value, [...start, ...addition], at);
        return args[0] as Value;
      },
      strchr: (args, at) => {
        const source = args[0] as Value;
        const wanted = this.toInt(args[1] as Value, at) & 0xff;
        const bytes = this.stringAt(source, at);
        const found = wanted === 0 ? bytes.length : bytes.indexOf(wanted);
        if (found === -1) return 0;
        const pointer = source as Ptr;
        return new Ptr(pointer.mem, pointer.off + found, pointer.elem);
      },
      strstr: (args, at) => {
        const source = args[0] as Value;
        const found = text(this.stringAt(source, at)).indexOf(
          text(this.stringAt(args[1] as Value, at)),
        );
        if (found === -1) return 0;
        const pointer = source as Ptr;
        return new Ptr(pointer.mem, pointer.off + found, pointer.elem);
      },
      strdup: (args, at) => {
        const bytes = this.stringAt(args[0] as Value, at);
        this.reserve(bytes.length + 1, at, null);
        return new Ptr([...bytes.map((byte) => (byte << 24) >> 24), 0], 0, 'char');
      },
      malloc: (args, at) => {
        const size = this.toInt(args[0] as Value, at);
        if (size <= 0) return 0;
        this.reserve(size, at, null);
        return new Ptr(new Array<Cell>(size).fill(0), 0, 'char');
      },
      calloc: (args, at) => {
        const size = this.toInt(args[0] as Value, at) * this.toInt(args[1] as Value, at);
        if (size <= 0) return 0;
        this.reserve(size, at, null);
        return new Ptr(new Array<Cell>(size).fill(0), 0, 'char');
      },
      free: (args) => {
        const pointer = args[0];
        if (pointer instanceof Ptr) this.liveCells -= pointer.mem.length;
        return 0;
      },
      atoi: (args, at) => {
        const parsed = parseInt(text(this.stringAt(args[0] as Value, at)), 10);
        return Number.isNaN(parsed) ? 0 : parsed | 0;
      },
      atof: (args, at) => {
        const parsed = parseFloat(text(this.stringAt(args[0] as Value, at)));
        return new Flt(Number.isNaN(parsed) ? 0 : parsed);
      },
      abs: (args, at) => Math.abs(this.toInt(args[0] as Value, at)),
      isdigit: this.characterClass(isDigit),
      isalpha: this.characterClass(isAlpha),
      isalnum: this.characterClass((c) => isAlpha(c) || isDigit(c)),
      isspace: this.characterClass(isSpace),
      isupper: this.characterClass(isUpper),
      islower: this.characterClass(isLower),
      ispunct: this.characterClass((c) => c > 0x20 && c < 0x7f && !isAlpha(c) && !isDigit(c)),
      isxdigit: this.characterClass(
        (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
      ),
      toupper: (args, at) => {
        const code = this.toInt(args[0] as Value, at);
        return isLower(code) ? code - 32 : code;
      },
      tolower: (args, at) => {
        const code = this.toInt(args[0] as Value, at);
        return isUpper(code) ? code + 32 : code;
      },
      exit: (args, at) => {
        throw new ExitSignal(this.toInt(args[0] as Value, at));
      },
    };
  }
}
