import { EngineError } from '../core/result';
import { scanSource, type ScanToken } from './scan';
import type { TypeExpr } from './type-expr';

// The mini-language the type checker works on. It looks like a small C: declarations, expressions,
// assignments, if, while, functions and structs. Assignment is a statement here, which keeps the
// checker's rules simple to read.

export const MAX_TC_SOURCE_LENGTH = 8000;
const MAX_DEPTH = 100;

export interface TcNodeBase {
  id: number;
  start: number;
  end: number;
}

export type TcBinaryOp =
  '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export type TcExpr =
  | (TcNodeBase & { kind: 'int'; value: number })
  | (TcNodeBase & { kind: 'float'; value: number })
  | (TcNodeBase & { kind: 'char'; value: number })
  | (TcNodeBase & { kind: 'bool'; value: boolean })
  | (TcNodeBase & { kind: 'name'; name: string })
  | (TcNodeBase & { kind: 'unary'; op: '-' | '!' | '*' | '&'; arg: TcExpr })
  | (TcNodeBase & { kind: 'binary'; op: TcBinaryOp; left: TcExpr; right: TcExpr })
  | (TcNodeBase & { kind: 'index'; base: TcExpr; index: TcExpr })
  | (TcNodeBase & { kind: 'field'; base: TcExpr; field: string })
  | (TcNodeBase & { kind: 'call'; callee: string; args: TcExpr[] });

/** A function parameter or a struct field. */
export interface TcTypedName {
  name: string;
  type: TypeExpr;
  start: number;
  end: number;
}

export type TcStmt =
  | (TcNodeBase & { kind: 'decl'; name: string; type: TypeExpr; init: TcExpr | null })
  | (TcNodeBase & { kind: 'assign'; target: TcExpr; value: TcExpr })
  | (TcNodeBase & { kind: 'expr'; expr: TcExpr })
  | (TcNodeBase & {
      kind: 'if';
      cond: TcExpr;
      thenBranch: TcStmt;
      elseBranch: TcStmt | null;
    })
  | (TcNodeBase & { kind: 'while'; cond: TcExpr; body: TcStmt })
  | (TcNodeBase & { kind: 'return'; value: TcExpr | null })
  | (TcNodeBase & { kind: 'block'; body: TcStmt[] })
  | (TcNodeBase & {
      kind: 'function';
      name: string;
      params: TcTypedName[];
      result: TypeExpr;
      body: TcStmt[];
    })
  | (TcNodeBase & { kind: 'struct'; name: string; fields: TcTypedName[] });

export interface TcProgram {
  source: string;
  body: TcStmt[];
}

const BASIC_TYPES = new Set([
  'int',
  'float',
  'char',
  'bool',
  'void',
  'double',
  'long',
  'short',
  'byte',
]);
const KEYWORDS = new Set([
  ...BASIC_TYPES,
  'if',
  'else',
  'while',
  'return',
  'struct',
  'true',
  'false',
]);
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', ...'=+-*/%<>!&()[]{},;.'];
const BINARY_LEVELS: readonly (readonly TcBinaryOp[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

class TcParser {
  private at = 0;
  private nextId = 0;
  private depth = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: ScanToken[],
  ) {}

  private peek(distance = 0): ScanToken {
    return this.tokens[Math.min(this.at + distance, this.tokens.length - 1)] as ScanToken;
  }

  private id(): number {
    return this.nextId++;
  }

  private fail(message: string, hint: string, token: ScanToken = this.peek()): never {
    throw new EngineError({
      code: 'tc_syntax',
      message,
      hint,
      position: token.start,
      length: Math.max(1, token.end - token.start),
    });
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.text === text;
  }

  private isKeyword(text: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.text === text;
  }

  private eatOp(text: string): boolean {
    if (!this.isOp(text)) return false;
    this.at++;
    return true;
  }

  private eatKeyword(text: string): boolean {
    if (!this.isKeyword(text)) return false;
    this.at++;
    return true;
  }

  private expectOp(text: string, where: string): ScanToken {
    const token = this.peek();
    if (!this.eatOp(text)) {
      const found = token.kind === 'eof' ? 'the end of the program' : `"${token.text}"`;
      this.fail(`Expected ${text} ${where}, but found ${found}.`, `Add ${text} here.`);
    }
    return token;
  }

  private name(what: string): ScanToken {
    const token = this.peek();
    if (token.kind !== 'name' || KEYWORDS.has(token.text)) {
      this.fail(
        token.kind === 'name'
          ? `${token.text} is a keyword, so it cannot be ${what}.`
          : `Expected ${what} here.`,
        'Use a plain name, like x or total.',
      );
    }
    this.at++;
    return token;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) {
      this.fail('This program is nested too deeply.', 'Split it into smaller pieces.');
    }
  }

  private previousEnd(): number {
    return (this.tokens[this.at - 1] as ScanToken).end;
  }

  /** A semicolon may be left off at the very end, so short examples stay short. */
  private endStatement(): void {
    if (this.eatOp(';') || this.isOp('}') || this.peek().kind === 'eof') return;
    this.fail('A statement must end with ; here.', 'Add a ; at the end of the statement.');
  }

  program(): TcProgram {
    const body: TcStmt[] = [];
    while (this.peek().kind !== 'eof') body.push(...this.topLevel());
    return { source: this.source, body };
  }

  private isTypeStart(): boolean {
    const token = this.peek();
    return token.kind === 'name' && (BASIC_TYPES.has(token.text) || token.text === 'struct');
  }

  private topLevel(): TcStmt[] {
    if (this.isKeyword('struct') && this.peek(2).kind === 'op' && this.peek(2).text === '{') {
      return [this.structDeclaration()];
    }
    if (this.isTypeStart()) {
      // A name then ( after the type means a function.
      let ahead = 1;
      if (this.isKeyword('struct')) ahead = 2;
      while (this.peek(ahead).kind === 'op' && this.peek(ahead).text === '*') ahead++;
      const name = this.peek(ahead);
      const after = this.peek(ahead + 1);
      if (name.kind === 'name' && after.kind === 'op' && after.text === '(') {
        return [this.functionDeclaration()];
      }
    }
    return this.statementOrDeclaration();
  }

  private baseType(): TypeExpr {
    const token = this.peek();
    if (this.eatKeyword('struct')) {
      const name = this.name('a struct name');
      return { kind: 'named', name: name.text };
    }
    if (token.kind !== 'name' || !BASIC_TYPES.has(token.text)) {
      this.fail(
        'A type is expected here.',
        'Types are int, float, char, bool, void, or struct Name.',
      );
    }
    this.at++;
    return { kind: 'basic', name: token.text };
  }

  private stars(base: TypeExpr): TypeExpr {
    let type = base;
    while (this.eatOp('*')) type = { kind: 'pointer', target: type };
    return type;
  }

  /** int a[2][3] is an array of 2 arrays of 3 ints, so the sizes fold up from the right. */
  private arraySuffix(element: TypeExpr, allowUnsized: boolean): TypeExpr {
    const sizes: (number | null)[] = [];
    while (this.isOp('[')) {
      this.at++;
      const size = this.peek();
      if (allowUnsized && sizes.length === 0 && this.isOp(']')) {
        sizes.push(null);
      } else {
        if (size.kind !== 'number' || !Number.isInteger(size.value)) {
          this.fail('An array size must be a whole number.', 'Write it like this: int a[10];');
        }
        if (size.value <= 0) {
          this.fail('An array needs at least one element.', 'Use a size of 1 or more.', size);
        }
        this.at++;
        sizes.push(size.value);
      }
      this.expectOp(']', 'after the array size');
    }
    return sizes.reduceRight<TypeExpr>(
      (inner, size) => ({ kind: 'array', size, element: inner }),
      element,
    );
  }

  private structDeclaration(): TcStmt {
    const start = this.peek().start;
    const id = this.id();
    this.at++;
    const name = this.name('a struct name');
    this.expectOp('{', 'to open the struct');
    const fields: TcTypedName[] = [];
    while (!this.isOp('}')) {
      if (this.peek().kind === 'eof') this.fail('This struct is never closed.', 'Add the }.');
      const base = this.baseType();
      for (;;) {
        const type = this.stars(base);
        const field = this.name('a field name');
        fields.push({
          name: field.text,
          type: this.arraySuffix(type, false),
          start: field.start,
          end: this.previousEnd(),
        });
        if (!this.eatOp(',')) break;
      }
      this.expectOp(';', 'after a field');
    }
    this.at++;
    this.endStatement();
    return { id, start, end: this.previousEnd(), kind: 'struct', name: name.text, fields };
  }

  private functionDeclaration(): TcStmt {
    const start = this.peek().start;
    const id = this.id();
    const result = this.stars(this.baseType());
    const name = this.name('a function name');
    this.expectOp('(', 'after the function name');
    const params: TcTypedName[] = [];
    // f(void) is the C way of saying there are no parameters.
    if (this.isKeyword('void') && this.peek(1).text === ')') this.at++;
    if (!this.isOp(')')) {
      for (;;) {
        const paramStart = this.peek().start;
        const type = this.stars(this.baseType());
        const param = this.name('a parameter name');
        params.push({
          name: param.text,
          type: this.arraySuffix(type, true),
          start: paramStart,
          end: this.previousEnd(),
        });
        if (!this.eatOp(',')) break;
      }
    }
    this.expectOp(')', 'after the parameters');
    this.expectOp('{', 'to open the function body');
    const body = this.statementList();
    this.expectOp('}', 'to close the function body');
    return {
      id,
      start,
      end: this.previousEnd(),
      kind: 'function',
      name: name.text,
      params,
      result,
      body,
    };
  }

  private statementList(): TcStmt[] {
    const body: TcStmt[] = [];
    while (!this.isOp('}') && this.peek().kind !== 'eof') {
      body.push(...this.statementOrDeclaration());
    }
    return body;
  }

  /** A declaration like int x = 1, y; becomes one node per name. */
  private statementOrDeclaration(): TcStmt[] {
    if (!this.isTypeStart()) return [this.statement()];
    const start = this.peek().start;
    const base = this.baseType();
    const declarations: TcStmt[] = [];
    for (;;) {
      const id = this.id();
      const type = this.stars(base);
      const name = this.name('a variable name');
      if (this.isOp('(')) {
        this.fail(
          'Functions can only be declared at the top level.',
          'Move this function outside any block.',
        );
      }
      const declared = this.arraySuffix(type, false);
      const init = this.eatOp('=') ? this.expression() : null;
      declarations.push({
        id,
        start,
        end: this.previousEnd(),
        kind: 'decl',
        name: name.text,
        type: declared,
        init,
      });
      if (!this.eatOp(',')) break;
    }
    this.endStatement();
    return declarations;
  }

  private statement(): TcStmt {
    this.enter();
    const statement = this.statementInner();
    this.depth--;
    return statement;
  }

  private statementInner(): TcStmt {
    const token = this.peek();
    if (this.isOp('{')) {
      const id = this.id();
      this.at++;
      const body = this.statementList();
      this.expectOp('}', 'to close this block');
      return { id, start: token.start, end: this.previousEnd(), kind: 'block', body };
    }
    if (this.isKeyword('if')) {
      const id = this.id();
      this.at++;
      this.expectOp('(', 'after if');
      const cond = this.expression();
      this.expectOp(')', 'after the condition');
      const thenBranch = this.statement();
      const elseBranch = this.eatKeyword('else') ? this.statement() : null;
      return {
        id,
        start: token.start,
        end: this.previousEnd(),
        kind: 'if',
        cond,
        thenBranch,
        elseBranch,
      };
    }
    if (this.isKeyword('while')) {
      const id = this.id();
      this.at++;
      this.expectOp('(', 'after while');
      const cond = this.expression();
      this.expectOp(')', 'after the condition');
      const body = this.statement();
      return { id, start: token.start, end: this.previousEnd(), kind: 'while', cond, body };
    }
    if (this.isKeyword('return')) {
      const id = this.id();
      this.at++;
      const value =
        this.isOp(';') || this.isOp('}') || this.peek().kind === 'eof' ? null : this.expression();
      const end = this.previousEnd();
      this.endStatement();
      return { id, start: token.start, end, kind: 'return', value };
    }
    if (this.isTypeStart()) {
      this.fail('A declaration cannot be the whole body of if or while.', 'Put it inside { and }.');
    }
    const id = this.id();
    const expr = this.expression();
    if (this.eatOp('=')) {
      const value = this.expression();
      const end = this.previousEnd();
      this.endStatement();
      return { id, start: token.start, end, kind: 'assign', target: expr, value };
    }
    const end = this.previousEnd();
    this.endStatement();
    return { id, start: token.start, end, kind: 'expr', expr };
  }

  private expression(): TcExpr {
    this.enter();
    const expr = this.binary(0);
    this.depth--;
    return expr;
  }

  private binary(level: number): TcExpr {
    const operators = BINARY_LEVELS[level];
    if (!operators) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      const op = token.kind === 'op' ? operators.find((text) => text === token.text) : undefined;
      if (!op) return left;
      this.at++;
      const right = this.binary(level + 1);
      left = { id: this.id(), start: left.start, end: right.end, kind: 'binary', op, left, right };
    }
  }

  private unary(): TcExpr {
    const token = this.peek();
    if (token.kind === 'op' && ['-', '!', '*', '&'].includes(token.text)) {
      this.at++;
      this.enter();
      const arg = this.unary();
      this.depth--;
      return {
        id: this.id(),
        start: token.start,
        end: arg.end,
        kind: 'unary',
        op: token.text as '-' | '!' | '*' | '&',
        arg,
      };
    }
    return this.postfix();
  }

  private postfix(): TcExpr {
    let expr = this.primary();
    for (;;) {
      if (this.eatOp('[')) {
        const index = this.expression();
        this.expectOp(']', 'after the index');
        expr = {
          id: this.id(),
          start: expr.start,
          end: this.previousEnd(),
          kind: 'index',
          base: expr,
          index,
        };
      } else if (this.eatOp('.')) {
        const field = this.name('a field name');
        expr = {
          id: this.id(),
          start: expr.start,
          end: field.end,
          kind: 'field',
          base: expr,
          field: field.text,
        };
      } else {
        return expr;
      }
    }
  }

  private primary(): TcExpr {
    const token = this.peek();
    if (token.kind === 'number') {
      this.at++;
      const isInt = /^[0-9]+$/.test(token.text);
      return {
        id: this.id(),
        start: token.start,
        end: token.end,
        kind: isInt ? 'int' : 'float',
        value: token.value,
      };
    }
    if (token.kind === 'char') {
      this.at++;
      return {
        id: this.id(),
        start: token.start,
        end: token.end,
        kind: 'char',
        value: token.value,
      };
    }
    if (this.isOp('(')) {
      this.at++;
      const inner = this.expression();
      const close = this.expectOp(')', 'to match the (');
      // The span grows to cover the parentheses, so highlighting a node looks right.
      return { ...inner, start: token.start, end: close.end };
    }
    if (this.isKeyword('true') || this.isKeyword('false')) {
      this.at++;
      return {
        id: this.id(),
        start: token.start,
        end: token.end,
        kind: 'bool',
        value: token.text === 'true',
      };
    }
    if (token.kind === 'name' && !KEYWORDS.has(token.text)) {
      this.at++;
      if (!this.eatOp('(')) {
        return {
          id: this.id(),
          start: token.start,
          end: token.end,
          kind: 'name',
          name: token.text,
        };
      }
      const args: TcExpr[] = [];
      if (!this.isOp(')')) {
        for (;;) {
          args.push(this.expression());
          if (!this.eatOp(',')) break;
        }
      }
      const close = this.expectOp(')', 'after the arguments');
      return {
        id: this.id(),
        start: token.start,
        end: close.end,
        kind: 'call',
        callee: token.text,
        args,
      };
    }
    this.fail(
      token.kind === 'eof'
        ? 'The program ends in the middle of an expression.'
        : `"${token.text}" cannot start an expression.`,
      'An expression starts with a number, a name, or a (.',
    );
  }
}

/** Parses the type checker's mini-language into a plain AST. */
export function tcParse(source: string): TcProgram {
  const tokens = scanSource(source, {
    operators: OPERATORS,
    codePrefix: 'tc',
    language: 'this language',
    maxLength: MAX_TC_SOURCE_LENGTH,
  });
  return new TcParser(source, tokens).program();
}
