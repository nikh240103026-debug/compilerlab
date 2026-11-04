import { formatTac, type TacInstr, type TacOperand } from '../ir/types';
import { optOperandOfName } from '../optimize/tac-text';
import type { TinyExpr, TinyFunction, TinyReturnType, TinySpan, TinyStmt } from './ast';
import type { TinyFunctionInfo, TinySemanticResult } from './semantic';

export interface TinyIrArray {
  symbol: string;
  /** Null for an array parameter, whose size belongs to the caller. */
  size: number | null;
}

export interface TinyIrFunction {
  name: string;
  returnType: TinyReturnType;
  /** Parameter symbols, in order. */
  params: string[];
  arrays: TinyIrArray[];
  instrs: TacInstr[];
  /** The source range each instruction came from. Empty after optimization, which reshapes code. */
  spans: TinySpan[];
  /** The instructions as text, one per entry. */
  text: string[];
}

export interface TinyIr {
  functions: TinyIrFunction[];
}

/** Names of the two print routines the code generator handles itself. */
export const TINYC_PRINT_INT = 'print';
export const TINYC_PRINT_BOOL = 'printb';

class FunctionBuilder {
  readonly instrs: TacInstr[] = [];
  readonly spans: TinySpan[] = [];
  private tempCount = 0;
  private labelCount = 0;

  constructor(private readonly taken: ReadonlySet<string>) {}

  emit(instr: TacInstr, span: TinySpan): void {
    this.instrs.push(instr);
    this.spans.push(span);
  }

  newTemp(): string {
    // A student could name a variable t1, so skip any name in use.
    let name: string;
    do {
      name = `t${++this.tempCount}`;
    } while (this.taken.has(name));
    return name;
  }

  newLabel(): string {
    return `L${++this.labelCount}`;
  }

  /** Short-circuit: the right side runs only when the left has not settled the answer. */
  private genLogical(expr: TinyExpr & { kind: 'binary' }): TacOperand {
    const temp = this.newTemp();
    const end = this.newLabel();
    this.emit({ op: 'assign', dest: temp, src: this.genExpr(expr.left) }, expr.left);
    const cond: TacOperand = { kind: 'temp', name: temp };
    this.emit(
      expr.operator === '&&'
        ? { op: 'if', cond, target: end, negate: true }
        : { op: 'if', cond, target: end },
      expr,
    );
    this.emit({ op: 'assign', dest: temp, src: this.genExpr(expr.right) }, expr.right);
    this.emit({ op: 'label', name: end }, expr);
    return cond;
  }

  /** Arguments are all evaluated before the first param, so a nested call cannot split them. */
  private genCall(expr: TinyExpr & { kind: 'call' }, dest: string | null): void {
    const args = expr.args.map((arg) => this.genExpr(arg));
    for (const arg of args) this.emit({ op: 'param', arg }, expr);
    this.emit({ op: 'call', dest, name: expr.name, argCount: args.length }, expr);
  }

  genExpr(expr: TinyExpr): TacOperand {
    switch (expr.kind) {
      case 'int':
        return { kind: 'const', value: expr.value };
      case 'bool':
        return { kind: 'const', value: expr.value ? 1 : 0 };
      case 'name':
        return optOperandOfName(expr.symbol as string);
      case 'unary':
        if (expr.operator === '-' && expr.arg.kind === 'int') {
          return { kind: 'const', value: -expr.arg.value };
        }
        break;
      case 'binary':
        if (expr.operator === '&&' || expr.operator === '||') return this.genLogical(expr);
        break;
      default:
        break;
    }
    const temp = this.newTemp();
    this.genInto(temp, expr);
    return { kind: 'temp', name: temp };
  }

  /** Puts an expression's value straight into dest, which avoids a temporary and a copy. */
  genInto(dest: string, expr: TinyExpr): void {
    switch (expr.kind) {
      case 'index': {
        const index = this.genExpr(expr.index);
        this.emit({ op: 'load', dest, base: expr.symbol as string, index }, expr);
        return;
      }
      case 'unary': {
        if (expr.operator === '-' && expr.arg.kind === 'int') break;
        const arg = this.genExpr(expr.arg);
        this.emit({ op: 'unary', dest, operator: expr.operator, arg }, expr);
        return;
      }
      case 'binary': {
        if (expr.operator === '&&' || expr.operator === '||') break;
        const left = this.genExpr(expr.left);
        const right = this.genExpr(expr.right);
        this.emit({ op: 'binary', dest, operator: expr.operator, left, right }, expr);
        return;
      }
      case 'call':
        this.genCall(expr, dest);
        return;
      default:
        break;
    }
    this.emit({ op: 'assign', dest, src: this.genExpr(expr) }, expr);
  }

  genStatement(statement: TinyStmt): void {
    switch (statement.kind) {
      case 'block':
        for (const inner of statement.statements) this.genStatement(inner);
        return;
      case 'decl':
        // Arrays need no code here. Entering the function clears the whole frame.
        if (statement.arraySize !== null) return;
        if (statement.init) {
          this.genInto(statement.symbol as string, statement.init);
        } else {
          // Resetting here keeps a declaration in a loop meaning the same on each trip.
          this.emit(
            { op: 'assign', dest: statement.symbol as string, src: { kind: 'const', value: 0 } },
            statement,
          );
        }
        return;
      case 'assign': {
        const symbol = statement.symbol as string;
        if (statement.index) {
          const index = this.genExpr(statement.index);
          const src = this.genExpr(statement.value);
          this.emit({ op: 'store', base: symbol, index, src }, statement);
        } else {
          this.genInto(symbol, statement.value);
        }
        return;
      }
      case 'if': {
        const otherwise = statement.otherwise;
        const elseLabel = this.newLabel();
        const cond = this.genExpr(statement.cond);
        this.emit({ op: 'if', cond, target: elseLabel, negate: true }, statement.cond);
        this.genStatement(statement.then);
        if (otherwise) {
          const end = this.newLabel();
          this.emit({ op: 'goto', target: end }, statement);
          this.emit({ op: 'label', name: elseLabel }, statement);
          this.genStatement(otherwise);
          this.emit({ op: 'label', name: end }, statement);
        } else {
          this.emit({ op: 'label', name: elseLabel }, statement);
        }
        return;
      }
      case 'while': {
        const start = this.newLabel();
        const end = this.newLabel();
        this.emit({ op: 'label', name: start }, statement);
        const cond = this.genExpr(statement.cond);
        this.emit({ op: 'if', cond, target: end, negate: true }, statement.cond);
        this.genStatement(statement.body);
        this.emit({ op: 'goto', target: start }, statement);
        this.emit({ op: 'label', name: end }, statement);
        return;
      }
      case 'return':
        this.emit(
          { op: 'return', value: statement.value ? this.genExpr(statement.value) : null },
          statement,
        );
        return;
      case 'print': {
        const arg = this.genExpr(statement.value);
        this.emit({ op: 'param', arg }, statement);
        this.emit(
          {
            op: 'call',
            dest: null,
            name: statement.value.type === 'bool' ? TINYC_PRINT_BOOL : TINYC_PRINT_INT,
            argCount: 1,
          },
          statement,
        );
        return;
      }
      case 'expression':
        if (statement.value.kind === 'call') this.genCall(statement.value, null);
        return;
    }
  }
}

function buildFunction(fn: TinyFunction, info: TinyFunctionInfo): TinyIrFunction {
  const symbols = [...info.params, ...info.locals];
  const builder = new FunctionBuilder(new Set(symbols.map((symbol) => symbol.symbol)));
  for (const statement of fn.body.statements) builder.genStatement(statement);
  return {
    name: fn.name,
    returnType: fn.returnType,
    params: info.params.map((param) => param.symbol),
    arrays: symbols
      .filter((symbol) => symbol.isArray)
      .map((symbol) => ({ symbol: symbol.symbol, size: symbol.arraySize })),
    instrs: builder.instrs,
    spans: builder.spans,
    text: builder.instrs.map(formatTac),
  };
}

/** Stage 4: three-address code, one instruction list per function. */
export function tinycGenerateIr(checked: TinySemanticResult): TinyIr {
  return {
    functions: checked.ast.functions.map((fn, index) =>
      buildFunction(fn, checked.functions[index] as TinyFunctionInfo),
    ),
  };
}
