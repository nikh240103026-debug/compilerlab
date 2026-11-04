import { EngineError } from '../core/result';
import { scanSource, type ScanToken } from '../semantic/scan';
import type { TacBinaryOp } from './types';

// The small language the IR phase translates, and its AST. Everything in chapter 6's examples can
// be written in it, from a = b*-c + b*-c to switch statements. A statement's closing semicolon may
// be left off at the very end, so a lone expression like a < b or c < d is a valid program.

export const MAX_IR_SOURCE_LENGTH = 6000;
const MAX_DEPTH = 100;

export interface IrNodeBase {
  id: number;
  start: number;
  end: number;
}

export type IrExpr =
  | (IrNodeBase & { kind: 'num'; value: number })
  | (IrNodeBase & { kind: 'bool'; value: boolean })
  | (IrNodeBase & { kind: 'var'; name: string })
  | (IrNodeBase & { kind: 'unary'; op: '-' | '!'; arg: IrExpr })
  | (IrNodeBase & { kind: 'binary'; op: TacBinaryOp; left: IrExpr; right: IrExpr })
  /** a[i][j]: the array's name, then one expression per dimension. */
  | (IrNodeBase & { kind: 'index'; base: string; indices: IrExpr[] })
  | (IrNodeBase & { kind: 'call'; name: string; args: IrExpr[] });

export type IrIndexExpr = Extract<IrExpr, { kind: 'index' }>;

export interface IrSwitchCase {
  /** The case value. null for default. */
  value: number | null;
  body: IrStmt[];
  start: number;
  end: number;
}

export type IrStmt =
  /** int a[2][3]; dims is empty for a scalar. */
  | (IrNodeBase & { kind: 'decl'; base: string; name: string; dims: number[] })
  | (IrNodeBase & {
      kind: 'assign';
      target: Extract<IrExpr, { kind: 'var' | 'index' }>;
      value: IrExpr;
    })
  | (IrNodeBase & { kind: 'expr'; expr: IrExpr })
  | (IrNodeBase & {
      kind: 'if';
      cond: IrExpr;
      thenBranch: IrStmt;
      elseBranch: IrStmt | null;
    })
  | (IrNodeBase & { kind: 'while'; cond: IrExpr; body: IrStmt })
  | (IrNodeBase & { kind: 'switch'; subject: IrExpr; cases: IrSwitchCase[] })
  | (IrNodeBase & { kind: 'block'; body: IrStmt[] })
  | (IrNodeBase & { kind: 'break' })
  | (IrNodeBase & { kind: 'return'; value: IrExpr | null });

export interface IrProgram {
  source: string;
  body: IrStmt[];
  /** Every identifier in the program, so generated temporaries can avoid them. */
  names: string[];
}

export const IR_BASE_TYPES: readonly string[] = ['int', 'float', 'char', 'bool', 'double'];
const KEYWORDS = new Set([
  ...IR_BASE_TYPES,
  'if',
  'else',
  'while',
  'switch',
  'case',
  'default',
  'break',
  'return',
  'true',
  'false',
]);
/** The book writes these as words in some examples, so they work as well as the symbols. */
const WORD_OPERATORS = new Map([
  ['or', '||'],
  ['and', '&&'],
  ['not', '!'],
]);
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', ...'=+-*/%<>!()[]{},;:'];
const BINARY_LEVELS: readonly (readonly TacBinaryOp[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

class IrParser {
  private at = 0;
  private nextId = 0;
  private depth = 0;
  private breakables = 0;
  private readonly names = new Set<string>();

  constructor(
    private readonly source: string,
    private readonly tokens: ScanToken[],
  ) {}

  private peek(): ScanToken {
    return this.tokens[Math.min(this.at, this.tokens.length - 1)] as ScanToken;
  }

  private fail(message: string, hint: string, token: ScanToken = this.peek()): never {
    throw new EngineError({
      code: 'ir_syntax',
      message,
      hint,
      position: token.start,
      length: Math.max(1, token.end - token.start),
    });
  }

  private id(): number {
    return this.nextId++;
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.text === text;
  }

  private isWord(text: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.text === text;
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
    this.names.add(token.text);
    return token;
  }

  private previousEnd(): number {
    return (this.tokens[this.at - 1] as ScanToken).end;
  }

  private endStatement(): void {
    if (this.eatOp(';') || this.isOp('}') || this.peek().kind === 'eof') return;
    this.fail('A statement must end with ; here.', 'Add a ; at the end of the statement.');
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) {
      this.fail('This program is nested too deeply.', 'Split it into simpler statements.');
    }
  }

  program(): IrProgram {
    const body = this.list(() => this.peek().kind === 'eof');
    return { source: this.source, body, names: [...this.names] };
  }

  private list(done: () => boolean): IrStmt[] {
    const body: IrStmt[] = [];
    while (!done()) {
      if (this.peek().kind === 'eof') break;
      if (this.eatOp(';')) continue;
      if (this.isOp('}')) this.fail('This } has no matching {.', 'Remove it, or add the {.');
      if (this.isDeclaration()) body.push(...this.declaration());
      else body.push(this.statement());
    }
    return body;
  }

  private isDeclaration(): boolean {
    const token = this.peek();
    return token.kind === 'name' && IR_BASE_TYPES.includes(token.text);
  }

  private declaration(): IrStmt[] {
    const start = this.peek().start;
    const base = this.peek().text;
    this.at++;
    const statements: IrStmt[] = [];
    for (;;) {
      const nameToken = this.name('a variable name');
      const dims: number[] = [];
      while (this.eatOp('[')) {
        const size = this.peek();
        if (size.kind !== 'number' || !Number.isInteger(size.value) || size.value <= 0) {
          this.fail(
            'An array size must be a whole number of at least 1.',
            'Write it like this: int a[2][3];',
          );
        }
        this.at++;
        dims.push(size.value);
        this.expectOp(']', 'after the array size');
      }
      statements.push({
        id: this.id(),
        start,
        end: this.previousEnd(),
        kind: 'decl',
        base,
        name: nameToken.text,
        dims,
      });
      // An initializer is just an assignment that happens right after the declaration.
      if (this.eatOp('=')) {
        if (dims.length > 0) {
          this.fail('An array cannot have an initializer here.', 'Assign each element separately.');
        }
        const value = this.expression();
        const target: Extract<IrExpr, { kind: 'var' }> = {
          id: this.id(),
          start: nameToken.start,
          end: nameToken.end,
          kind: 'var',
          name: nameToken.text,
        };
        statements.push({
          id: this.id(),
          start: nameToken.start,
          end: value.end,
          kind: 'assign',
          target,
          value,
        });
      }
      if (!this.eatOp(',')) break;
    }
    this.endStatement();
    return statements;
  }

  private statement(): IrStmt {
    this.enter();
    const statement = this.statementInner();
    this.depth--;
    return statement;
  }

  private statementInner(): IrStmt {
    const token = this.peek();
    if (this.eatOp('{')) {
      const body = this.list(() => this.isOp('}'));
      this.expectOp('}', 'to close this block');
      return { id: this.id(), start: token.start, end: this.previousEnd(), kind: 'block', body };
    }
    if (this.eatWord('if')) {
      this.expectOp('(', 'after if');
      const cond = this.expression();
      this.expectOp(')', 'after the condition');
      const thenBranch = this.nestedStatement();
      const elseBranch = this.eatWord('else') ? this.nestedStatement() : null;
      return {
        id: this.id(),
        start: token.start,
        end: this.previousEnd(),
        kind: 'if',
        cond,
        thenBranch,
        elseBranch,
      };
    }
    if (this.eatWord('while')) {
      this.expectOp('(', 'after while');
      const cond = this.expression();
      this.expectOp(')', 'after the condition');
      this.breakables++;
      const body = this.nestedStatement();
      this.breakables--;
      return {
        id: this.id(),
        start: token.start,
        end: this.previousEnd(),
        kind: 'while',
        cond,
        body,
      };
    }
    if (this.eatWord('switch')) return this.switchStatement(token);
    if (this.eatWord('break')) {
      if (this.breakables === 0) {
        this.fail(
          'break only makes sense inside while or switch.',
          'Remove it, or move it into a loop.',
          token,
        );
      }
      this.endStatement();
      return { id: this.id(), start: token.start, end: token.end, kind: 'break' };
    }
    if (this.eatWord('return')) {
      const value =
        this.isOp(';') || this.isOp('}') || this.peek().kind === 'eof' ? null : this.expression();
      const end = this.previousEnd();
      this.endStatement();
      return { id: this.id(), start: token.start, end, kind: 'return', value };
    }
    const expr = this.expression();
    if (this.isOp('=')) {
      if (expr.kind !== 'var' && expr.kind !== 'index') {
        this.fail(
          'The left side of = must be a variable or an array element.',
          'Write it like this: x = y + 1;',
        );
      }
      this.at++;
      const value = this.expression();
      const end = value.end;
      this.endStatement();
      return { id: this.id(), start: token.start, end, kind: 'assign', target: expr, value };
    }
    const end = expr.end;
    this.endStatement();
    return { id: this.id(), start: token.start, end, kind: 'expr', expr };
  }

  private nestedStatement(): IrStmt {
    if (this.isDeclaration()) {
      this.fail('A declaration cannot be the whole body of if or while.', 'Put it inside { and }.');
    }
    return this.statement();
  }

  private switchStatement(token: ScanToken): IrStmt {
    this.expectOp('(', 'after switch');
    const subject = this.expression();
    this.expectOp(')', 'after the switch expression');
    this.expectOp('{', 'to open the cases');
    const cases: IrSwitchCase[] = [];
    const seen = new Set<number>();
    let hasDefault = false;
    this.breakables++;
    while (!this.isOp('}')) {
      const start = this.peek();
      let value: number | null = null;
      if (this.eatWord('case')) {
        const negative = this.eatOp('-');
        const number = this.peek();
        if (number.kind !== 'number' || !Number.isInteger(number.value)) {
          this.fail('A case value must be a whole number.', 'Write it like this: case 1:');
        }
        this.at++;
        value = negative ? -number.value : number.value;
        if (seen.has(value)) {
          this.fail(`case ${value} appears twice.`, 'Give each case its own value.', number);
        }
        seen.add(value);
      } else if (this.eatWord('default')) {
        if (hasDefault) {
          this.fail('A switch can only have one default.', 'Remove one of them.', start);
        }
        hasDefault = true;
      } else {
        this.fail(
          this.peek().kind === 'eof'
            ? 'This switch is never closed.'
            : 'Inside a switch, statements go after case or default.',
          'Write it like this: switch (x) { case 1: y = 2; default: y = 3; }',
        );
      }
      this.expectOp(':', 'after the case');
      const body = this.list(() => this.isOp('}') || this.isWord('case') || this.isWord('default'));
      cases.push({ value, body, start: start.start, end: this.previousEnd() });
    }
    this.breakables--;
    if (cases.length === 0) {
      this.fail('A switch needs at least one case.', 'Add a case or a default.', token);
    }
    this.at++;
    return {
      id: this.id(),
      start: token.start,
      end: this.previousEnd(),
      kind: 'switch',
      subject,
      cases,
    };
  }

  private expression(): IrExpr {
    this.enter();
    const expr = this.binary(0);
    this.depth--;
    return expr;
  }

  private binary(level: number): IrExpr {
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

  private unary(): IrExpr {
    const token = this.peek();
    if (token.kind === 'op' && (token.text === '-' || token.text === '!')) {
      this.at++;
      this.enter();
      const arg = this.unary();
      this.depth--;
      // -1 is a constant, as in the book's x = -1. Only a name or a larger expression needs code.
      if (token.text === '-' && arg.kind === 'num') {
        return { ...arg, value: -arg.value, start: token.start };
      }
      return {
        id: this.id(),
        start: token.start,
        end: arg.end,
        kind: 'unary',
        op: token.text,
        arg,
      };
    }
    return this.primary();
  }

  private primary(): IrExpr {
    const token = this.peek();
    if (token.kind === 'number' || token.kind === 'char') {
      this.at++;
      return { id: this.id(), start: token.start, end: token.end, kind: 'num', value: token.value };
    }
    if (this.isOp('(')) {
      this.at++;
      const inner = this.expression();
      const close = this.expectOp(')', 'to match the (');
      // The span grows to cover the parentheses, so highlighting a node looks right.
      return { ...inner, start: token.start, end: close.end };
    }
    if (this.isWord('true') || this.isWord('false')) {
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
      this.names.add(token.text);
      if (this.eatOp('(')) {
        const args: IrExpr[] = [];
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
          name: token.text,
          args,
        };
      }
      if (this.isOp('[')) {
        const indices: IrExpr[] = [];
        while (this.eatOp('[')) {
          indices.push(this.expression());
          this.expectOp(']', 'after the index');
        }
        return {
          id: this.id(),
          start: token.start,
          end: this.previousEnd(),
          kind: 'index',
          base: token.text,
          indices,
        };
      }
      return { id: this.id(), start: token.start, end: token.end, kind: 'var', name: token.text };
    }
    this.fail(
      token.kind === 'eof'
        ? 'The program ends in the middle of an expression.'
        : token.kind === 'name'
          ? `${token.text} is a keyword, so it cannot start an expression.`
          : `"${token.text}" cannot start an expression.`,
      'An expression starts with a number, a name, or a (.',
    );
  }
}

/** Parses source text into the plain-data AST. Bad syntax throws an EngineError with a position. */
export function irParse(source: string): IrProgram {
  const tokens = scanSource(source, {
    operators: OPERATORS,
    codePrefix: 'ir',
    language: 'this language',
    maxLength: MAX_IR_SOURCE_LENGTH,
  }).map((token): ScanToken => {
    const operator = token.kind === 'name' ? WORD_OPERATORS.get(token.text) : undefined;
    return operator ? { ...token, kind: 'op', text: operator } : token;
  });
  return new IrParser(source, tokens).program();
}
