import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import type {
  TinyBaseType,
  TinyExpr,
  TinyFunction,
  TinyProgram,
  TinyReturnType,
  TinySpan,
  TinyStmt,
  TinyType,
} from './ast';

/** A function's locals share one stack frame, which has to stay well inside VM memory. */
const MAX_FRAME_ARRAY_CELLS = 16_384;

export interface TinySymbol {
  name: string;
  /** Unique within its function, because an inner block can shadow an outer name. */
  symbol: string;
  baseType: TinyBaseType;
  isArray: boolean;
  /** Null for scalars and for array parameters, whose size belongs to the caller. */
  arraySize: number | null;
  kind: 'param' | 'local';
  /** 0 is the function's parameters and top-level locals. */
  scopeDepth: number;
  position: number;
}

export interface TinyFunctionInfo {
  name: string;
  returnType: TinyReturnType;
  params: TinySymbol[];
  locals: TinySymbol[];
  position: number;
}

export interface TinySemanticState {
  function: string | null;
  /** What is in scope, innermost last. */
  scopes: { name: string; type: string; symbol: string }[][];
  /** The source range this step is about. */
  focus: TinySpan | null;
}

export interface TinySemanticResult {
  /** The tree with the type of each expression and the unique symbol of each name filled in. */
  ast: TinyProgram;
  functions: TinyFunctionInfo[];
  trace: Trace<TinySemanticState>;
}

function fail(message: string, hint: string, span: TinySpan): never {
  throw new EngineError({
    code: 'tinyc_semantic_error',
    message,
    hint,
    position: span.position,
    length: Math.max(span.length, 1),
  });
}

const typeOfSymbol = (symbol: TinySymbol): TinyType =>
  symbol.isArray ? (`${symbol.baseType}[]` as TinyType) : symbol.baseType;

const showType = (type: TinyType) => (type === 'void' ? 'no value' : `a value of type ${type}`);

/** Whether every path through this statement ends in a return. */
function alwaysReturns(statement: TinyStmt): boolean {
  switch (statement.kind) {
    case 'return':
      return true;
    case 'block':
      return statement.statements.some(alwaysReturns);
    case 'if':
      return (
        statement.otherwise !== null &&
        alwaysReturns(statement.then) &&
        alwaysReturns(statement.otherwise)
      );
    default:
      return false;
  }
}

class FunctionChecker {
  private readonly scopes: Map<string, TinySymbol>[] = [];
  private readonly nameCounts = new Map<string, number>();
  readonly params: TinySymbol[] = [];
  readonly locals: TinySymbol[] = [];
  private frameCells = 0;

  constructor(
    private readonly fn: TinyFunction,
    private readonly signatures: ReadonlyMap<string, TinyFunction>,
    private readonly recorder: TraceRecorder<TinySemanticState>,
  ) {}

  private record(title: string, explanation: string, focus: TinySpan | null): void {
    this.recorder.add(title, explanation, {
      function: this.fn.name,
      scopes: this.scopes.map((scope) =>
        [...scope.values()].map((symbol) => ({
          name: symbol.name,
          type: typeOfSymbol(symbol),
          symbol: symbol.symbol,
        })),
      ),
      focus,
    });
  }

  private lookup(name: string): TinySymbol | null {
    for (let depth = this.scopes.length - 1; depth >= 0; depth--) {
      const found = this.scopes[depth]?.get(name);
      if (found) return found;
    }
    return null;
  }

  private declare(
    name: string,
    baseType: TinyBaseType,
    isArray: boolean,
    arraySize: number | null,
    kind: TinySymbol['kind'],
    span: TinySpan,
  ): TinySymbol {
    const scope = this.scopes.at(-1) as Map<string, TinySymbol>;
    if (scope.has(name)) {
      fail(
        `${name} is already declared in this scope.`,
        'Use another name, or remove one of the declarations.',
        span,
      );
    }
    const count = this.nameCounts.get(name) ?? 0;
    this.nameCounts.set(name, count + 1);
    const symbol: TinySymbol = {
      name,
      symbol: count === 0 ? name : `${name}.${count}`,
      baseType,
      isArray,
      arraySize,
      kind,
      scopeDepth: this.scopes.length - 1,
      position: span.position,
    };
    scope.set(name, symbol);
    (kind === 'param' ? this.params : this.locals).push(symbol);
    return symbol;
  }

  run(): TinyFunction {
    const { fn } = this;
    this.scopes.push(new Map());
    this.record(
      `Check ${fn.name}`,
      `Open a new scope for ${fn.name}. Its parameters and top-level locals live here.`,
      fn,
    );
    for (const param of fn.params) {
      this.declare(param.name, param.baseType, param.isArray, null, 'param', param);
    }

    // The body shares the parameters' scope, so "int n" inside f(int n) is an error, as in C.
    const statements = fn.body.statements.map((statement) => this.checkStatement(statement));
    if (fn.returnType !== 'void' && !alwaysReturns(fn.body)) {
      fail(
        `${fn.name} must return ${fn.returnType === 'int' ? 'an int' : 'a bool'}, but some path through it reaches the end without a return.`,
        'Add a return at the end. A while loop does not count, because it might not run.',
        fn,
      );
    }
    this.scopes.pop();
    return { ...fn, body: { ...fn.body, statements } };
  }

  private withScope<T>(run: () => T): T {
    this.scopes.push(new Map());
    const result = run();
    this.scopes.pop();
    return result;
  }

  private checkBody(statement: TinyStmt): TinyStmt {
    if (statement.kind === 'decl') {
      fail(
        'A declaration cannot be the whole body of an if or while.',
        'Put it inside { }.',
        statement,
      );
    }
    return this.checkStatement(statement);
  }

  private requireType(expr: TinyExpr, expected: TinyType, context: string): void {
    const actual = expr.type as TinyType;
    if (actual === expected) return;
    const hint =
      actual === 'int[]' || actual === 'bool[]'
        ? 'Arrays cannot be used as values here. Use one cell, like a[i].'
        : expected === 'bool' && actual === 'int'
          ? 'TinyC keeps int and bool apart. To test an int, compare it, like x != 0.'
          : 'TinyC does not convert between types automatically.';
    fail(`${context} needs ${showType(expected)}, but this gives ${showType(actual)}.`, hint, expr);
  }

  private checkStatement(statement: TinyStmt): TinyStmt {
    switch (statement.kind) {
      case 'block':
        return this.withScope(() => {
          this.record(
            'Open a scope',
            'A block has its own scope. A name declared here can shadow an outer one, and it goes away at the closing brace.',
            statement,
          );
          return {
            ...statement,
            statements: statement.statements.map((inner) => this.checkStatement(inner)),
          };
        });
      case 'decl': {
        let init: TinyExpr | null = null;
        if (statement.init) {
          // The name is not in scope in its own initializer, the simplest rule that avoids reading it early.
          init = this.checkExpr(statement.init);
          this.requireType(init, statement.baseType, `The initial value of ${statement.name}`);
        }
        if (statement.arraySize !== null) {
          this.frameCells += statement.arraySize;
          if (this.frameCells > MAX_FRAME_ARRAY_CELLS) {
            fail(
              `${this.fn.name} declares more than ${MAX_FRAME_ARRAY_CELLS} array cells.`,
              'Use smaller arrays.',
              statement,
            );
          }
        }
        const symbol = this.declare(
          statement.name,
          statement.baseType,
          statement.arraySize !== null,
          statement.arraySize,
          'local',
          statement,
        );
        this.record(
          `Declare ${statement.name}`,
          `${statement.name} has type ${typeOfSymbol(symbol)}${symbol.symbol === symbol.name ? '' : `. An outer block already uses this name, so this one is called ${symbol.symbol} internally`}.`,
          statement,
        );
        return { ...statement, init, symbol: symbol.symbol };
      }
      case 'assign': {
        const symbol = this.lookup(statement.name);
        if (!symbol) {
          fail(
            `${statement.name} is not declared.`,
            `Declare it first, like: int ${statement.name};`,
            statement,
          );
        }
        let index: TinyExpr | null = null;
        if (statement.index) {
          if (!symbol.isArray) {
            fail(
              `${statement.name} is not an array, so it cannot be indexed.`,
              'Remove the [ ], or declare it as an array.',
              statement,
            );
          }
          index = this.checkExpr(statement.index);
          this.requireType(index, 'int', 'An array index');
        } else if (symbol.isArray) {
          fail(
            `${statement.name} is an array, so a whole array cannot be assigned.`,
            'Assign to one cell, like a[i] = 1;',
            statement,
          );
        }
        const value = this.checkExpr(statement.value);
        this.requireType(value, symbol.baseType, `Assigning to ${statement.name}`);
        this.record(
          `Assign to ${statement.name}`,
          `${statement.name} has type ${symbol.baseType}, and the right side matches.`,
          statement,
        );
        return { ...statement, index, value, symbol: symbol.symbol };
      }
      case 'if': {
        const cond = this.checkExpr(statement.cond);
        this.requireType(cond, 'bool', 'An if condition');
        this.record('Check an if', 'The condition is a bool, as it must be.', statement.cond);
        const then = this.withScope(() => this.checkBody(statement.then));
        const otherwise = statement.otherwise
          ? this.withScope(() => this.checkBody(statement.otherwise as TinyStmt))
          : null;
        return { ...statement, cond, then, otherwise };
      }
      case 'while': {
        const cond = this.checkExpr(statement.cond);
        this.requireType(cond, 'bool', 'A while condition');
        this.record('Check a while', 'The condition is a bool, as it must be.', statement.cond);
        const body = this.withScope(() => this.checkBody(statement.body));
        return { ...statement, cond, body };
      }
      case 'return': {
        const { returnType, name } = this.fn;
        if (statement.value === null) {
          if (returnType !== 'void') {
            fail(
              `${name} must return ${showType(returnType)}, but this return has no value.`,
              'Add a value after return.',
              statement,
            );
          }
          return statement;
        }
        if (returnType === 'void') {
          fail(
            `${name} is declared void, so it cannot return a value.`,
            'Remove the value, or change the return type.',
            statement,
          );
        }
        const value = this.checkExpr(statement.value);
        this.requireType(value, returnType, `Returning from ${name}`);
        this.record(
          'Check a return',
          `The value matches ${name}'s return type, ${returnType}.`,
          statement,
        );
        return { ...statement, value };
      }
      case 'print': {
        const value = this.checkExpr(statement.value);
        if (value.type !== 'int' && value.type !== 'bool') {
          fail(
            `print needs an int or a bool, but this gives ${showType(value.type as TinyType)}.`,
            'Print one array cell, like print(a[i]);',
            value,
          );
        }
        return { ...statement, value };
      }
      case 'expression':
        return { ...statement, value: this.checkExpr(statement.value) };
    }
  }

  private checkExpr(expr: TinyExpr): TinyExpr {
    switch (expr.kind) {
      case 'int':
        return { ...expr, type: 'int' };
      case 'bool':
        return { ...expr, type: 'bool' };
      case 'name': {
        const symbol = this.lookup(expr.name);
        if (!symbol) {
          fail(`${expr.name} is not declared.`, `Declare it first, like: int ${expr.name};`, expr);
        }
        return { ...expr, type: typeOfSymbol(symbol), symbol: symbol.symbol };
      }
      case 'index': {
        const symbol = this.lookup(expr.name);
        if (!symbol) {
          fail(
            `${expr.name} is not declared.`,
            `Declare it first, like: int ${expr.name}[10];`,
            expr,
          );
        }
        if (!symbol.isArray) {
          fail(
            `${expr.name} is not an array, so it cannot be indexed.`,
            'Remove the [ ], or declare it as an array.',
            expr,
          );
        }
        const index = this.checkExpr(expr.index);
        this.requireType(index, 'int', 'An array index');
        return { ...expr, index, type: symbol.baseType, symbol: symbol.symbol };
      }
      case 'unary': {
        const arg = this.checkExpr(expr.arg);
        const type: TinyBaseType = expr.operator === '-' ? 'int' : 'bool';
        this.requireType(arg, type, `The ${expr.operator} operator`);
        return { ...expr, arg, type };
      }
      case 'binary': {
        const left = this.checkExpr(expr.left);
        const right = this.checkExpr(expr.right);
        const { operator } = expr;
        if (operator === '&&' || operator === '||') {
          this.requireType(left, 'bool', `The left side of ${operator}`);
          this.requireType(right, 'bool', `The right side of ${operator}`);
          return { ...expr, left, right, type: 'bool' };
        }
        if (operator === '==' || operator === '!=') {
          if (left.type !== 'int' && left.type !== 'bool') {
            this.requireType(left, 'int', `The left side of ${operator}`);
          }
          this.requireType(right, left.type as TinyType, `The right side of ${operator}`);
          return { ...expr, left, right, type: 'bool' };
        }
        this.requireType(left, 'int', `The left side of ${operator}`);
        this.requireType(right, 'int', `The right side of ${operator}`);
        const comparison =
          operator === '<' || operator === '<=' || operator === '>' || operator === '>=';
        return { ...expr, left, right, type: comparison ? 'bool' : 'int' };
      }
      case 'call': {
        const callee = this.signatures.get(expr.name);
        if (!callee) {
          fail(
            `There is no function named ${expr.name}.`,
            'Check the spelling, or define the function.',
            expr,
          );
        }
        if (expr.args.length !== callee.params.length) {
          fail(
            `${expr.name} takes ${callee.params.length} argument${callee.params.length === 1 ? '' : 's'}, but this call passes ${expr.args.length}.`,
            'Match the call to the parameter list.',
            expr,
          );
        }
        const args = expr.args.map((arg, index) => {
          const checked = this.checkExpr(arg);
          const param = callee.params[index] as TinyFunction['params'][number];
          const expected = (param.isArray ? `${param.baseType}[]` : param.baseType) as TinyType;
          this.requireType(checked, expected, `Parameter ${param.name} of ${expr.name}`);
          return checked;
        });
        return { ...expr, args, type: callee.returnType };
      }
    }
  }
}

/** Stage 3: scopes and types. Throws an EngineError with a position on the first problem found. */
export function tinycCheck(program: TinyProgram): TinySemanticResult {
  const recorder = new TraceRecorder<TinySemanticState>();
  const signatures = new Map<string, TinyFunction>();
  for (const fn of program.functions) {
    if (signatures.has(fn.name)) {
      fail(`There are two functions named ${fn.name}.`, 'Give each function its own name.', fn);
    }
    if (fn.name === 'printb') {
      fail('printb is reserved for printing booleans.', 'Use another name.', fn);
    }
    signatures.set(fn.name, fn);
  }
  recorder.add(
    'Collect the functions',
    `Found ${program.functions.length} function${program.functions.length === 1 ? '' : 's'}. Collecting signatures first lets functions call each other in any order, and call themselves.`,
    { function: null, scopes: [], focus: null },
  );

  const main = signatures.get('main');
  if (!main) {
    throw new EngineError({
      code: 'tinyc_semantic_error',
      message: 'Every TinyC program needs a function named main.',
      hint: 'Add: int main() { return 0; }',
      position: 0,
      length: 1,
    });
  }
  if (main.params.length > 0) {
    fail(
      'main cannot take parameters, because nothing calls it with arguments.',
      'Write: int main() {',
      main,
    );
  }

  const functions: TinyFunctionInfo[] = [];
  const checked = program.functions.map((fn) => {
    const checker = new FunctionChecker(fn, signatures, recorder);
    const result = checker.run();
    functions.push({
      name: fn.name,
      returnType: fn.returnType,
      params: checker.params,
      locals: checker.locals,
      position: fn.position,
    });
    return result;
  });

  recorder.add(
    'Types are consistent',
    'Every name is declared before use, and every operation has operands of the right type.',
    { function: null, scopes: [], focus: null },
  );
  return { ast: { functions: checked }, functions, trace: recorder.finish() };
}
