import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { locateOffset } from '../flex/spec';
import { scanSource, type ScanToken } from './scan';
import { typeExprFormat, typeExprParse, TYPE_BOOL, TYPE_INT, type TypeExpr } from './type-expr';
import { TypeUnifier, type TypeBinding, type TypeUnifyStep } from './unify';

// Type inference by unification, in the style of section 6.5.4. It works on a small functional
// language, because that is where inference has real work to do:
//
//   fun length(x) = if null(x) then 0 else length(tl(x)) + 1
//
// The result is the book's answer, length : ∀α. list(α) → int, and the rows of the trace follow its
// table: each line gives an expression, its type so far, and what was unified.

export const MAX_INFERENCE_SOURCE_LENGTH = 4000;
const MAX_DEPTH = 100;

interface InfBase {
  start: number;
  end: number;
}

type InfExpr =
  | (InfBase & { kind: 'int'; value: number })
  | (InfBase & { kind: 'bool'; value: boolean })
  | (InfBase & { kind: 'nil' })
  | (InfBase & { kind: 'name'; name: string })
  | (InfBase & { kind: 'call'; callee: InfExpr; args: InfExpr[] })
  | (InfBase & { kind: 'if'; cond: InfExpr; thenPart: InfExpr; elsePart: InfExpr })
  | (InfBase & { kind: 'let'; name: string; value: InfExpr; body: InfExpr })
  | (InfBase & { kind: 'lambda'; params: string[]; body: InfExpr })
  | (InfBase & { kind: 'binary'; op: string; left: InfExpr; right: InfExpr })
  | (InfBase & { kind: 'unary'; op: string; arg: InfExpr });

type InfItem =
  | (InfBase & { kind: 'fun'; name: string; params: string[]; body: InfExpr })
  | (InfBase & { kind: 'define'; name: string; value: InfExpr })
  | (InfBase & { kind: 'expression'; expr: InfExpr });

const KEYWORDS = new Set(['fun', 'fn', 'let', 'in', 'if', 'then', 'else', 'true', 'false']);
const OPERATORS = ['=>', '==', '!=', '<=', '>=', '&&', '||', ...'=+-*/%<>!(),;[]'];
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

class InfParser {
  private at = 0;
  private depth = 0;

  constructor(private readonly tokens: ScanToken[]) {}

  private peek(): ScanToken {
    return this.tokens[Math.min(this.at, this.tokens.length - 1)] as ScanToken;
  }

  private fail(message: string, hint: string): never {
    const token = this.peek();
    throw new EngineError({
      code: 'inference_syntax',
      message,
      hint,
      position: token.start,
      length: Math.max(1, token.end - token.start),
    });
  }

  private isOp(text: string): boolean {
    return this.peek().kind === 'op' && this.peek().text === text;
  }

  private isWord(text: string): boolean {
    return this.peek().kind === 'name' && this.peek().text === text;
  }

  private eatOp(text: string): boolean {
    if (!this.isOp(text)) return false;
    this.at++;
    return true;
  }

  private eatWord(text: string): boolean {
    if (!this.isWord(text)) return false;
    this.at++;
    return true;
  }

  private expectOp(text: string, where: string): void {
    if (!this.eatOp(text)) this.fail(`Expected ${text} ${where}.`, `Add ${text} here.`);
  }

  private expectWord(text: string, where: string): void {
    if (!this.eatWord(text)) this.fail(`Expected ${text} ${where}.`, `Add ${text} here.`);
  }

  private name(what: string): ScanToken {
    const token = this.peek();
    if (token.kind !== 'name' || KEYWORDS.has(token.text)) {
      this.fail(`Expected ${what} here.`, 'Use a plain name, like x or length.');
    }
    this.at++;
    return token;
  }

  private previousEnd(): number {
    return (this.tokens[this.at - 1] as ScanToken).end;
  }

  private params(): string[] {
    this.expectOp('(', 'before the parameters');
    const params: string[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        const name = this.name('a parameter name').text;
        if (params.includes(name)) {
          this.fail(`The parameter ${name} appears twice.`, 'Give each parameter its own name.');
        }
        params.push(name);
        if (!this.eatOp(',')) break;
      }
    }
    this.expectOp(')', 'after the parameters');
    return params;
  }

  program(): InfItem[] {
    const items: InfItem[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.eatOp(';')) continue;
      const start = this.peek().start;
      if (this.eatWord('fun')) {
        const name = this.name('a function name').text;
        const params = this.params();
        this.expectOp('=', 'before the function body');
        const body = this.expression();
        items.push({ kind: 'fun', name, params, body, start, end: this.previousEnd() });
      } else if (this.isWord('let')) {
        items.push(this.letItem());
      } else {
        const expr = this.expression();
        items.push({ kind: 'expression', expr, start, end: expr.end });
      }
    }
    return items;
  }

  /** At the top level, let may be a definition, or a let ... in expression. */
  private letItem(): InfItem {
    const start = this.peek().start;
    this.at++;
    const name = this.name('a name').text;
    this.expectOp('=', 'after the name');
    const value = this.expression();
    if (this.eatWord('in')) {
      const body = this.expression();
      const expr: InfExpr = { kind: 'let', name, value, body, start, end: body.end };
      return { kind: 'expression', expr, start, end: body.end };
    }
    return { kind: 'define', name, value, start, end: value.end };
  }

  private expression(): InfExpr {
    if (++this.depth > MAX_DEPTH) {
      this.fail('This expression is nested too deeply.', 'Split it into smaller definitions.');
    }
    const expr = this.expressionInner();
    this.depth--;
    return expr;
  }

  private expressionInner(): InfExpr {
    const start = this.peek().start;
    if (this.eatWord('if')) {
      const cond = this.expression();
      this.expectWord('then', 'after the condition');
      const thenPart = this.expression();
      this.expectWord('else', 'after the then part');
      const elsePart = this.expression();
      return { kind: 'if', cond, thenPart, elsePart, start, end: elsePart.end };
    }
    if (this.eatWord('let')) {
      const name = this.name('a name').text;
      this.expectOp('=', 'after the name');
      const value = this.expression();
      this.expectWord('in', 'after the value of let');
      const body = this.expression();
      return { kind: 'let', name, value, body, start, end: body.end };
    }
    if (this.eatWord('fn')) {
      const params = this.params();
      this.expectOp('=>', 'after the parameters');
      const body = this.expression();
      return { kind: 'lambda', params, body, start, end: body.end };
    }
    return this.binary(0);
  }

  private binary(level: number): InfExpr {
    const operators = BINARY_LEVELS[level];
    if (!operators) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !operators.includes(token.text)) return left;
      this.at++;
      const right = this.binary(level + 1);
      left = { kind: 'binary', op: token.text, left, right, start: left.start, end: right.end };
    }
  }

  private unary(): InfExpr {
    const token = this.peek();
    if (token.kind === 'op' && (token.text === '-' || token.text === '!')) {
      this.at++;
      if (++this.depth > MAX_DEPTH) {
        this.fail('This expression is nested too deeply.', 'Split it into smaller definitions.');
      }
      const arg = this.unary();
      this.depth--;
      return { kind: 'unary', op: token.text, arg, start: token.start, end: arg.end };
    }
    let expr = this.primary();
    while (this.isOp('(')) {
      this.at++;
      const args: InfExpr[] = [];
      if (!this.isOp(')')) {
        for (;;) {
          args.push(this.expression());
          if (!this.eatOp(',')) break;
        }
      }
      this.expectOp(')', 'after the arguments');
      expr = { kind: 'call', callee: expr, args, start: expr.start, end: this.previousEnd() };
    }
    return expr;
  }

  private primary(): InfExpr {
    const token = this.peek();
    if (token.kind === 'number') {
      if (!/^[0-9]+$/.test(token.text)) {
        this.fail('Inference here works on whole numbers only.', 'Use a number like 3.');
      }
      this.at++;
      return { kind: 'int', value: token.value, start: token.start, end: token.end };
    }
    if (this.eatWord('true') || this.eatWord('false')) {
      return { kind: 'bool', value: token.text === 'true', start: token.start, end: token.end };
    }
    if (this.eatOp('[')) {
      this.expectOp(']', 'to make the empty list []');
      return { kind: 'nil', start: token.start, end: this.previousEnd() };
    }
    if (this.eatOp('(')) {
      const inner = this.expression();
      this.expectOp(')', 'to match the (');
      return { ...inner, start: token.start, end: this.previousEnd() };
    }
    if (token.kind === 'name' && !KEYWORDS.has(token.text)) {
      this.at++;
      return { kind: 'name', name: token.text, start: token.start, end: token.end };
    }
    this.fail(
      token.kind === 'eof'
        ? 'The text ends in the middle of an expression.'
        : `"${token.text}" cannot start an expression.`,
      'An expression starts with a number, a name, or a (.',
    );
  }
}

/** One line of the book's table. */
export interface TypeInferenceRow {
  expression: string;
  type: string;
  /** What was unified on this line, like list(α) = β, or null. */
  unify: string | null;
  start: number;
  end: number;
}

export interface TypeInferenceError {
  message: string;
  hint: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface TypeInferenceState {
  /** rows[0..rowCount) exist at this step. */
  rowCount: number;
  row: TypeInferenceRow;
  /** The rule used, like f(x) : s' when f : s → s' and x : s. */
  rule: string;
  /** What unification did on this step. */
  unifications: TypeUnifyStep[];
  /** The substitution so far. */
  bindings: TypeBinding[];
  /** Names in scope, not counting the predefined ones. */
  environment: { name: string; type: string }[];
  error: TypeInferenceError | null;
}

export interface TypeInferenceResult {
  ok: boolean;
  rows: TypeInferenceRow[];
  /** The final type of each definition, with type variables named α, β and so on. */
  definitions: { name: string; type: string }[];
  /** The type of each stand-alone expression. */
  expressions: { text: string; type: string }[];
  error: TypeInferenceError | null;
  trace: Trace<TypeInferenceState>;
}

interface Scheme {
  /** Type variables each use gets fresh copies of. */
  variables: string[];
  type: TypeExpr;
}

const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';

function greekName(index: number): string {
  const letter = GREEK[index % GREEK.length] as string;
  const round = Math.floor(index / GREEK.length);
  return round === 0 ? letter : `${letter}${round}`;
}

/** The predefined names, as in the book's example. */
const PREDEFINED: readonly [string, string][] = [
  ['null', 'list(α) → bool'],
  ['tl', 'list(α) → list(α)'],
  ['hd', 'list(α) → α'],
  ['cons', 'α × list(α) → list(α)'],
  ['nil', 'list(α)'],
];

function collectVariables(type: TypeExpr, into: string[]): void {
  switch (type.kind) {
    case 'variable':
      if (!into.includes(type.name)) into.push(type.name);
      return;
    case 'array':
      collectVariables(type.element, into);
      return;
    case 'pointer':
      collectVariables(type.target, into);
      return;
    case 'function':
      for (const param of type.params) collectVariables(param, into);
      collectVariables(type.result, into);
      return;
    case 'record':
      for (const field of type.fields) collectVariables(field.type, into);
      return;
    case 'constructed':
      for (const arg of type.args) collectVariables(arg, into);
      return;
    default:
      return;
  }
}

function replaceVariables(type: TypeExpr, map: ReadonlyMap<string, TypeExpr>): TypeExpr {
  const go = (current: TypeExpr): TypeExpr => {
    switch (current.kind) {
      case 'variable':
        return map.get(current.name) ?? current;
      case 'array':
        return { ...current, element: go(current.element) };
      case 'pointer':
        return { ...current, target: go(current.target) };
      case 'function':
        return { kind: 'function', params: current.params.map(go), result: go(current.result) };
      case 'record':
        return {
          kind: 'record',
          fields: current.fields.map((field) => ({ name: field.name, type: go(field.type) })),
        };
      case 'constructed':
        return { kind: 'constructed', name: current.name, args: current.args.map(go) };
      default:
        return current;
    }
  };
  return go(type);
}

const BINARY_RULES = new Map<string, string>([
  ...['+', '-', '*', '/', '%'].map((op): [string, string] => [op, 'int × int → int']),
  ...['<', '<=', '>', '>='].map((op): [string, string] => [op, 'int × int → bool']),
  ['==', 'α × α → bool'],
  ['!=', 'α × α → bool'],
  ['&&', 'bool × bool → bool'],
  ['||', 'bool × bool → bool'],
]);

/** Thrown to abandon inference at the first type error. It never leaves this module. */
class InferenceStop extends Error {}

interface Unified {
  /** Like list(α) = β. */
  text: string;
  steps: TypeUnifyStep[];
  alreadyEqual: boolean;
}

class Inferer {
  private readonly unifier = new TypeUnifier();
  private readonly recorder = new TraceRecorder<TypeInferenceState>();
  private readonly env: { name: string; scheme: Scheme; predefined: boolean }[] = [];
  private readonly rows: TypeInferenceRow[] = [];
  private nextVariable = 0;
  error: TypeInferenceError | null = null;

  constructor(private readonly source: string) {
    for (const [name, text] of PREDEFINED) {
      const type = typeExprParse(text);
      const variables: string[] = [];
      collectVariables(type, variables);
      this.env.push({ name, scheme: { variables, type }, predefined: true });
    }
  }

  private fresh(): TypeExpr {
    return { kind: 'variable', name: `t${++this.nextVariable}` };
  }

  private textOf(node: InfBase): string {
    const text = this.source.slice(node.start, node.end);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }

  /**
   * Type variables print as α, β and so on, in the order they first appear. The real names are
   * t1, t2, ... which cannot clash with the letters in a predefined scheme.
   */
  private readonly letters = new Map<string, string>();

  private letter(name: string): string {
    let letter = this.letters.get(name);
    if (!letter) {
      letter = greekName(this.letters.size);
      this.letters.set(name, letter);
    }
    return letter;
  }

  private show(type: TypeExpr): string {
    const resolved = this.unifier.resolve(type);
    const variables: string[] = [];
    collectVariables(resolved, variables);
    const map = new Map<string, TypeExpr>(
      variables.map((name) => [name, { kind: 'variable', name: this.letter(name) }]),
    );
    return typeExprFormat(replaceVariables(resolved, map));
  }

  private renameStep(step: TypeUnifyStep): TypeUnifyStep {
    const rename = (text: string): string =>
      text.replace(/\bt[0-9]+\b/g, (name) => this.letter(name));
    return {
      action: step.action,
      left: rename(step.left),
      right: rename(step.right),
      detail: rename(step.detail),
    };
  }

  private environmentView(): { name: string; type: string }[] {
    return this.env
      .filter((item) => !item.predefined)
      .map((item) => ({ name: item.name, type: this.showScheme(item.scheme) }));
  }

  private showScheme(scheme: Scheme): string {
    const type = this.show(scheme.type);
    if (scheme.variables.length === 0) return type;
    const letters = scheme.variables.map((name) => this.letter(name));
    return `∀${letters.join(', ')}. ${type}`;
  }

  private addRow(
    node: InfBase,
    expression: string,
    type: TypeExpr,
    unify: string | null,
    rule: string,
    explanation: string,
    unifications: TypeUnifyStep[] = [],
  ): void {
    const row: TypeInferenceRow = {
      expression,
      type: this.show(type),
      unify,
      start: node.start,
      end: node.end,
    };
    this.rows.push(row);
    this.recorder.add(expression, explanation, {
      rowCount: this.rows.length,
      row,
      rule,
      unifications,
      bindings: this.bindingsView(),
      environment: this.environmentView(),
      error: null,
    });
  }

  private bindingsView(): TypeBinding[] {
    return this.unifier.bindings().map((binding) => ({
      variable: this.letter(binding.variable),
      type: binding.type.replace(/\bt[0-9]+\b/g, (name) => this.letter(name)),
    }));
  }

  /** Unifies two types. If that fails, it records the error and stops the run. */
  private unifyAt(node: InfBase, left: TypeExpr, right: TypeExpr, explain: string): Unified {
    const leftText = this.show(left);
    const rightText = this.show(right);
    const text = `${leftText} = ${rightText}`;
    const ok = this.unifier.unify(left, right);
    const steps = this.unifier.takeSteps().map((step) => this.renameStep(step));
    if (!ok) {
      const { line, column } = locateOffset(this.source, node.start);
      const reason = (this.unifier.failure ?? '').replace(/\bt[0-9]+\b/g, (name) =>
        this.letter(name),
      );
      const error: TypeInferenceError = {
        message: `${explain} needs ${text}, and that cannot work. ${reason}`,
        hint: 'Check how this expression is used against what it is.',
        start: node.start,
        end: node.end,
        line,
        column,
      };
      this.error = error;
      const row: TypeInferenceRow = {
        expression: this.textOf(node),
        type: 'error',
        unify: text,
        start: node.start,
        end: node.end,
      };
      this.rows.push(row);
      this.recorder.add(`Type error: ${this.textOf(node)}`, error.message, {
        rowCount: this.rows.length,
        row,
        rule: 'unification failed',
        unifications: steps,
        bindings: this.bindingsView(),
        environment: this.environmentView(),
        error,
      });
      throw new InferenceStop();
    }
    return { text, steps, alreadyEqual: leftText === rightText };
  }

  private lookup(name: string): Scheme | null {
    for (let i = this.env.length - 1; i >= 0; i--) {
      const entry = this.env[i] as { name: string; scheme: Scheme };
      if (entry.name === name) return entry.scheme;
    }
    return null;
  }

  private instantiate(scheme: Scheme): TypeExpr {
    if (scheme.variables.length === 0) return scheme.type;
    const map = new Map(scheme.variables.map((name): [string, TypeExpr] => [name, this.fresh()]));
    return replaceVariables(scheme.type, map);
  }

  /** Quantifies the variables no enclosing binding can still change. */
  private generalize(type: TypeExpr): Scheme {
    const resolved = this.unifier.resolve(type);
    const free: string[] = [];
    collectVariables(resolved, free);
    const fixed: string[] = [];
    for (const item of this.env) {
      if (item.scheme.variables.length === 0) {
        collectVariables(this.unifier.resolve(item.scheme.type), fixed);
      }
    }
    return { variables: free.filter((name) => !fixed.includes(name)), type: resolved };
  }

  private predefinedType(text: string): TypeExpr {
    const type = typeExprParse(text);
    const variables: string[] = [];
    collectVariables(type, variables);
    return this.instantiate({ variables, type });
  }

  private infer(expr: InfExpr): TypeExpr {
    switch (expr.kind) {
      case 'int':
        this.addRow(
          expr,
          String(expr.value),
          TYPE_INT,
          null,
          'num : int',
          `${expr.value} is a number, so it has type int.`,
        );
        return TYPE_INT;
      case 'bool':
        this.addRow(
          expr,
          String(expr.value),
          TYPE_BOOL,
          null,
          'true, false : bool',
          `${expr.value} has type bool.`,
        );
        return TYPE_BOOL;
      case 'nil': {
        const type = this.instantiate(this.lookup('nil') as Scheme);
        this.addRow(
          expr,
          '[]',
          type,
          null,
          '[] : list(α), with a fresh α',
          'The empty list can be a list of anything, so its element type is a new variable.',
        );
        return type;
      }
      case 'name':
        return this.inferName(expr);
      case 'call':
        return this.inferCall(expr);
      case 'if':
        return this.inferIf(expr);
      case 'let':
        return this.inferLet(expr);
      case 'lambda':
        return this.inferLambda(expr);
      case 'binary':
        return this.inferOperator(expr, expr.op, BINARY_RULES.get(expr.op) as string, [
          expr.left,
          expr.right,
        ]);
      case 'unary':
        return this.inferOperator(expr, expr.op, expr.op === '!' ? 'bool → bool' : 'int → int', [
          expr.arg,
        ]);
    }
  }

  private inferName(expr: Extract<InfExpr, { kind: 'name' }>): TypeExpr {
    const scheme = this.lookup(expr.name);
    if (!scheme) {
      const { line, column } = locateOffset(this.source, expr.start);
      const error: TypeInferenceError = {
        message: `${expr.name} is not defined.`,
        hint: `Define ${expr.name} first. The predefined names are ${PREDEFINED.map(([name]) => name).join(', ')}.`,
        start: expr.start,
        end: expr.end,
        line,
        column,
      };
      this.error = error;
      const row: TypeInferenceRow = {
        expression: expr.name,
        type: 'error',
        unify: null,
        start: expr.start,
        end: expr.end,
      };
      this.rows.push(row);
      this.recorder.add(`Unknown name ${expr.name}`, error.message, {
        rowCount: this.rows.length,
        row,
        rule: 'Γ(x) must exist',
        unifications: [],
        bindings: this.bindingsView(),
        environment: this.environmentView(),
        error,
      });
      throw new InferenceStop();
    }
    const type = this.instantiate(scheme);
    const polymorphic = scheme.variables.length > 0;
    this.addRow(
      expr,
      expr.name,
      type,
      null,
      polymorphic ? 'x : ∀α. s, so use s with a fresh α' : 'Γ(x) = t, so x : t',
      polymorphic
        ? `${expr.name} is polymorphic, so this use gets its own new type variables. That lets each use pick different types.`
        : `${expr.name} has type ${this.show(type)} so far.`,
    );
    return type;
  }

  private inferCall(expr: Extract<InfExpr, { kind: 'call' }>): TypeExpr {
    const callee = this.infer(expr.callee);
    const args = expr.args.map((arg) => this.infer(arg));
    const result = this.fresh();
    const wanted: TypeExpr = { kind: 'function', params: args, result };
    const { text, steps } = this.unifyAt(
      expr,
      callee,
      wanted,
      `Calling ${this.textOf(expr.callee)} here`,
    );
    this.addRow(
      expr,
      this.textOf(expr),
      result,
      text,
      "f(x) : s' when f : s → s' and x : s",
      `A function of type s → s' applied to x works when x has type s, so unify the function's type with the arguments' types. The call has the result type.`,
      steps,
    );
    return result;
  }

  private inferIf(expr: Extract<InfExpr, { kind: 'if' }>): TypeExpr {
    const result = this.fresh();
    this.addRow(
      expr,
      'if',
      { kind: 'function', params: [TYPE_BOOL, result, result], result },
      null,
      'if : bool × α × α → α',
      'The book treats if as a function. The condition must be bool, and both branches must have one type, which is the type of the whole expression.',
    );
    const cond = this.infer(expr.cond);
    const condition = this.unifyAt(expr.cond, cond, TYPE_BOOL, 'The condition of if');
    this.note(expr.cond, cond, condition, 'The condition of if must be bool.');
    const thenType = this.infer(expr.thenPart);
    const thenUnify = this.unifyAt(expr.thenPart, thenType, result, 'The then part of if');
    this.note(expr.thenPart, thenType, thenUnify, 'The then part gives if its type.');
    const elseType = this.infer(expr.elsePart);
    const elseUnify = this.unifyAt(expr.elsePart, elseType, result, 'The else part of if');
    this.note(
      expr.elsePart,
      elseType,
      elseUnify,
      'The else part must have the same type as the then part.',
    );
    this.addRow(
      expr,
      this.textOf(expr),
      result,
      null,
      'if : bool × α × α → α',
      `The whole if has type ${this.show(result)}.`,
    );
    return result;
  }

  /** A row that only records a unification. Nothing new is learned if both sides already match. */
  private note(node: InfBase, type: TypeExpr, unified: Unified, explanation: string): void {
    if (unified.alreadyEqual) return;
    this.addRow(node, this.textOf(node), type, unified.text, 'unify', explanation, unified.steps);
  }

  private inferLet(expr: Extract<InfExpr, { kind: 'let' }>): TypeExpr {
    const value = this.infer(expr.value);
    const mark = this.env.length;
    const scheme = this.generalize(value);
    this.env.push({ name: expr.name, scheme, predefined: false });
    this.addRow(
      expr,
      expr.name,
      scheme.type,
      null,
      'let x = E1 in E2 : quantify what E1 leaves free',
      `${expr.name} has type ${this.showScheme(scheme)}.`,
    );
    const body = this.infer(expr.body);
    this.env.length = mark;
    return body;
  }

  private inferLambda(expr: Extract<InfExpr, { kind: 'lambda' }>): TypeExpr {
    const mark = this.env.length;
    const params = expr.params.map((name) => {
      const type = this.fresh();
      this.env.push({ name, scheme: { variables: [], type }, predefined: false });
      this.addRow(
        expr,
        name,
        type,
        null,
        'parameter : a new type variable',
        `Nothing is known yet about the parameter ${name}, so it gets a new type variable.`,
      );
      return type;
    });
    const body = this.infer(expr.body);
    this.env.length = mark;
    const type: TypeExpr = { kind: 'function', params, result: body };
    this.addRow(
      expr,
      this.textOf(expr),
      type,
      null,
      'fn(x) => E : t → s when x : t and E : s',
      'The function maps its parameter types to the type of its body.',
    );
    return type;
  }

  private inferOperator(
    node: InfBase,
    op: string,
    typeText: string,
    operands: InfExpr[],
  ): TypeExpr {
    const type = this.predefinedType(typeText) as Extract<TypeExpr, { kind: 'function' }>;
    this.addRow(
      node,
      op,
      type,
      null,
      `${op} : ${typeText}`,
      `The operator ${op} has type ${typeText}. There is no overloading here, which keeps every type the inference finds exact.`,
    );
    operands.forEach((operand, index) => {
      const operandType = this.infer(operand);
      const unified = this.unifyAt(
        operand,
        operandType,
        type.params[index] as TypeExpr,
        `The operand of ${op}`,
      );
      this.note(operand, operandType, unified, `The operand of ${op} must fit its parameter type.`);
    });
    this.addRow(
      node,
      this.textOf(node),
      type.result,
      null,
      `${op} : ${typeText}`,
      `The result of ${op} has type ${this.show(type.result)}.`,
    );
    return type.result;
  }

  private inferFunction(item: Extract<InfItem, { kind: 'fun' }>): Scheme {
    const params = item.params.map(() => this.fresh());
    const result = this.fresh();
    const type: TypeExpr = { kind: 'function', params, result };
    const mark = this.env.length;
    // The function can call itself, but inside its own body it has a single type.
    this.env.push({ name: item.name, scheme: { variables: [], type }, predefined: false });
    this.addRow(
      item,
      item.name,
      type,
      null,
      'fun f(x) : f : t → s with new t and s',
      `Nothing is known yet about ${item.name}, so its parameters and result each get a new type variable.`,
    );
    item.params.forEach((name, index) => {
      const paramType = params[index] as TypeExpr;
      this.env.push({ name, scheme: { variables: [], type: paramType }, predefined: false });
      this.addRow(
        item,
        name,
        paramType,
        null,
        'parameter : a new type variable',
        `The parameter ${name} has type ${this.show(paramType)} for now.`,
      );
    });
    const body = this.infer(item.body);
    const unified = this.unifyAt(item.body, body, result, `The body of ${item.name}`);
    this.env.length = mark;
    const scheme = this.generalize(type);
    this.addRow(
      item,
      item.name,
      type,
      unified.text,
      'fun f(x) = E : quantify what stays free',
      `The body's type becomes the result type. What stays free can be anything, so ${item.name} has type ${this.showScheme(scheme)}.`,
      unified.steps,
    );
    return scheme;
  }

  run(items: InfItem[]): TypeInferenceResult {
    const definitions: { name: string; scheme: Scheme }[] = [];
    const expressions: { text: string; type: TypeExpr }[] = [];
    try {
      for (const item of items) {
        if (item.kind === 'fun') {
          const scheme = this.inferFunction(item);
          this.env.push({ name: item.name, scheme, predefined: false });
          definitions.push({ name: item.name, scheme });
        } else if (item.kind === 'define') {
          const scheme = this.generalize(this.infer(item.value));
          this.env.push({ name: item.name, scheme, predefined: false });
          definitions.push({ name: item.name, scheme });
          this.addRow(
            item,
            item.name,
            scheme.type,
            null,
            'let x = E : quantify what stays free',
            `${item.name} has type ${this.showScheme(scheme)}.`,
          );
        } else {
          const type = this.infer(item.expr);
          expressions.push({ text: this.textOf(item.expr), type });
        }
      }
    } catch (error) {
      if (!(error instanceof InferenceStop)) throw error;
    }
    return {
      ok: this.error === null,
      rows: this.rows,
      definitions: definitions.map(({ name, scheme }) => ({
        name,
        type: canonicalScheme(this.unifier, scheme),
      })),
      expressions: expressions.map(({ text, type }) => ({
        text,
        type: canonicalType(this.unifier, type),
      })),
      error: this.error,
      trace: this.recorder.finish(),
    };
  }
}

/** Renames a final type's variables to α, β, ... from the start, the way a book would print it. */
function canonicalParts(unifier: TypeUnifier, type: TypeExpr): { names: string[]; text: string } {
  const resolved = unifier.resolve(type);
  const variables: string[] = [];
  collectVariables(resolved, variables);
  const names = variables.map((_, index) => greekName(index));
  const map = new Map<string, TypeExpr>(
    variables.map((name, index) => [name, { kind: 'variable', name: names[index] as string }]),
  );
  return { names, text: typeExprFormat(replaceVariables(resolved, map)) };
}

function canonicalType(unifier: TypeUnifier, type: TypeExpr): string {
  return canonicalParts(unifier, type).text;
}

function canonicalScheme(unifier: TypeUnifier, scheme: Scheme): string {
  const { names, text } = canonicalParts(unifier, scheme.type);
  return scheme.variables.length > 0 ? `∀${names.join(', ')}. ${text}` : text;
}

/**
 * Infers types by unification. Bad syntax throws an EngineError. A type error is a normal result,
 * with ok false, because finding those is the whole point.
 */
export function typeInfer(source: string): TypeInferenceResult {
  const tokens = scanSource(source, {
    operators: OPERATORS,
    codePrefix: 'inference',
    language: 'this language',
    maxLength: MAX_INFERENCE_SOURCE_LENGTH,
  });
  const items = new InfParser(tokens).program();
  return new Inferer(source).run(items);
}
