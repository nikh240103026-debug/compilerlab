import { EngineError } from '../core/result';
import type {
  TinyBaseType,
  TinyBinaryOp,
  TinyExpr,
  TinyFunction,
  TinyParam,
  TinyProgram,
  TinyReturnType,
  TinySpan,
  TinyStmt,
} from './ast';
import { tinycLex, type TinyToken } from './lexer';

export const TINYC_MAX_NESTING = 64;
export const TINYC_MAX_ARRAY_SIZE = 4096;
/** Later stages recurse down expressions, so a huge one must stop here with a readable error. */
export const TINYC_MAX_EXPRESSION_NODES = 500;

/** Lowest precedence first, as in C. */
const BINARY_LEVELS: readonly (readonly TinyBinaryOp[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

/** Recursive descent, one method per grammar rule. The grammar is at the top of tinyc/index.ts. */
class Parser {
  private index = 0;
  private depth = 0;
  private expressionNodes = 0;

  constructor(private readonly tokens: readonly TinyToken[]) {}

  private get current(): TinyToken {
    return this.tokens[this.index] as TinyToken;
  }

  private peek(ahead: number): TinyToken | undefined {
    return this.tokens[this.index + ahead];
  }

  private advance(): TinyToken {
    const token = this.current;
    if (token.kind !== 'eof') this.index++;
    return token;
  }

  private describe(token: TinyToken): string {
    return token.kind === 'eof' ? 'the end of the program' : `"${token.text}"`;
  }

  private fail(message: string, hint: string, token: TinyToken = this.current): never {
    throw new EngineError({
      code: 'tinyc_syntax_error',
      message: `Line ${token.line}: ${message}`,
      hint,
      position: token.position,
      length: Math.max(token.length, 1),
    });
  }

  private is(text: string): boolean {
    const { kind, text: tokenText } = this.current;
    return kind !== 'name' && kind !== 'int' && kind !== 'eof' && tokenText === text;
  }

  private match(text: string): boolean {
    if (!this.is(text)) return false;
    this.advance();
    return true;
  }

  private expect(text: string, hint: string): TinyToken {
    if (!this.is(text)) {
      this.fail(`Expected "${text}" here, but found ${this.describe(this.current)}.`, hint);
    }
    return this.advance();
  }

  private expectName(what: string): TinyToken {
    if (this.current.kind !== 'name') {
      const keyword = this.current.kind === 'keyword';
      this.fail(
        `Expected ${what} here, but found ${this.describe(this.current)}.`,
        keyword
          ? `"${this.current.text}" is a keyword in TinyC, so it cannot be a name.`
          : 'A name starts with a letter or underscore.',
      );
    }
    return this.advance();
  }

  private isBaseType(): boolean {
    return this.is('int') || this.is('bool');
  }

  private span(start: TinySpan): TinySpan {
    const previous = this.tokens[this.index - 1] as TinyToken;
    return {
      position: start.position,
      length: previous.position + previous.length - start.position,
    };
  }

  private enter(): void {
    if (++this.depth > TINYC_MAX_NESTING) {
      this.fail(
        `This code nests more than ${TINYC_MAX_NESTING} levels deep.`,
        'Split it into smaller functions.',
      );
    }
  }

  parseProgram(): TinyProgram {
    const functions: TinyFunction[] = [];
    while (this.current.kind !== 'eof') {
      functions.push(this.parseFunction());
    }
    return { functions };
  }

  private parseFunction(): TinyFunction {
    const start = this.current;
    if (!this.isBaseType() && !this.is('void')) {
      this.fail(
        `A program is a list of functions, so a function's return type must come here, not ${this.describe(start)}.`,
        'Start a function like: int main() {',
      );
    }
    const returnType = this.advance().text as TinyReturnType;
    const name = this.expectName('a function name');
    this.expect('(', 'A function needs a parameter list, even an empty one: ()');
    const params: TinyParam[] = [];
    if (!this.is(')')) {
      do {
        params.push(this.parseParam());
      } while (this.match(','));
    }
    this.expect(')', 'Close the parameter list with ).');
    const body = this.parseBlock();
    return { name: name.text, returnType, params, body, ...this.span(start) };
  }

  private parseParam(): TinyParam {
    const start = this.current;
    if (!this.isBaseType()) {
      this.fail('Expected a parameter type here.', 'Write a parameter like: int n   or   int a[]');
    }
    const baseType = this.advance().text as TinyBaseType;
    const name = this.expectName('a parameter name');
    let isArray = false;
    if (this.match('[')) {
      this.expect(']', 'An array parameter has empty brackets: int a[]');
      isArray = true;
    }
    return { name: name.text, baseType, isArray, ...this.span(start) };
  }

  private parseBlock(): TinyStmt & { kind: 'block' } {
    const start = this.expect('{', 'Start this block with {');
    this.enter();
    const statements: TinyStmt[] = [];
    while (!this.is('}')) {
      if (this.current.kind === 'eof') {
        this.fail('This block is never closed.', 'Add the missing }');
      }
      statements.push(this.parseStatement());
    }
    this.advance();
    this.depth--;
    return { kind: 'block', statements, ...this.span(start) };
  }

  private countExpressionNode(): void {
    if (++this.expressionNodes > TINYC_MAX_EXPRESSION_NODES) {
      this.fail(
        `This statement has more than ${TINYC_MAX_EXPRESSION_NODES} operations.`,
        'Split it into several statements.',
      );
    }
  }

  private parseStatement(): TinyStmt {
    const start = this.current;
    this.expressionNodes = 0;
    if (this.is('{')) return this.parseBlock();
    if (this.isBaseType()) return this.parseDeclaration();

    if (this.match('if')) {
      this.expect('(', 'An if needs its condition in parentheses.');
      const cond = this.parseExpression();
      this.expect(')', 'Close the condition with ).');
      this.enter();
      const then = this.parseStatement();
      const otherwise = this.match('else') ? this.parseStatement() : null;
      this.depth--;
      return { kind: 'if', cond, then, otherwise, ...this.span(start) };
    }

    if (this.match('while')) {
      this.expect('(', 'A while needs its condition in parentheses.');
      const cond = this.parseExpression();
      this.expect(')', 'Close the condition with ).');
      this.enter();
      const body = this.parseStatement();
      this.depth--;
      return { kind: 'while', cond, body, ...this.span(start) };
    }

    if (this.match('return')) {
      const value = this.is(';') ? null : this.parseExpression();
      this.expect(';', 'End the statement with ;');
      return { kind: 'return', value, ...this.span(start) };
    }

    if (this.match('print')) {
      this.expect('(', 'print needs its value in parentheses: print(x);');
      const value = this.parseExpression();
      this.expect(')', 'Close the call with ).');
      this.expect(';', 'End the statement with ;');
      return { kind: 'print', value, ...this.span(start) };
    }

    if (this.current.kind === 'name') {
      const next = this.peek(1);
      if (next?.text === '=' || next?.text === '[') return this.parseAssignment();
      if (next?.text === '(') {
        const value = this.parseExpression();
        this.expect(';', 'End the statement with ;');
        return { kind: 'expression', value, ...this.span(start) };
      }
    }

    this.fail(
      `A statement cannot start with ${this.describe(start)}.`,
      'Statements are declarations, assignments, if, while, return, print, and calls.',
    );
  }

  private parseDeclaration(): TinyStmt {
    const start = this.current;
    const baseType = this.advance().text as TinyBaseType;
    const name = this.expectName('a variable name');
    let arraySize: number | null = null;
    if (this.match('[')) {
      const size = this.current;
      if (size.kind !== 'int') {
        this.fail('An array size must be a whole number.', 'Write it like: int a[10];');
      }
      if ((size.value as number) < 1 || (size.value as number) > TINYC_MAX_ARRAY_SIZE) {
        this.fail(
          `An array must have between 1 and ${TINYC_MAX_ARRAY_SIZE} cells.`,
          'Use a size in that range.',
        );
      }
      arraySize = size.value;
      this.advance();
      this.expect(']', 'Close the array size with ].');
    }
    let init: TinyExpr | null = null;
    if (this.is('=')) {
      if (arraySize !== null) {
        this.fail(
          'An array cannot have an initial value here.',
          'Assign to its cells one at a time.',
        );
      }
      this.advance();
      init = this.parseExpression();
    }
    this.expect(';', 'End the declaration with ;');
    return { kind: 'decl', name: name.text, baseType, arraySize, init, ...this.span(start) };
  }

  private parseAssignment(): TinyStmt {
    const start = this.current;
    const name = this.advance();
    let index: TinyExpr | null = null;
    if (this.match('[')) {
      index = this.parseExpression();
      this.expect(']', 'Close the index with ].');
    }
    this.expect('=', 'An assignment looks like: x = 1;');
    const value = this.parseExpression();
    this.expect(';', 'End the statement with ;');
    return { kind: 'assign', name: name.text, index, value, ...this.span(start) };
  }

  private parseExpression(level = 0): TinyExpr {
    const operators = BINARY_LEVELS[level];
    if (!operators) return this.parseUnary();
    const start = this.current;
    let left = this.parseExpression(level + 1);
    while (
      this.current.kind === 'operator' &&
      operators.includes(this.current.text as TinyBinaryOp)
    ) {
      this.countExpressionNode();
      const operator = this.advance().text as TinyBinaryOp;
      const right = this.parseExpression(level + 1);
      left = { kind: 'binary', operator, left, right, ...this.span(start) };
    }
    return left;
  }

  private parseUnary(): TinyExpr {
    const start = this.current;
    if (this.is('-') || this.is('!')) {
      const operator = this.advance().text as '-' | '!';
      this.enter();
      const arg = this.parseUnary();
      this.depth--;
      return { kind: 'unary', operator, arg, ...this.span(start) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): TinyExpr {
    const start = this.current;
    if (start.kind === 'int') {
      this.advance();
      return {
        kind: 'int',
        value: start.value as number,
        position: start.position,
        length: start.length,
      };
    }
    if (this.is('true') || this.is('false')) {
      this.advance();
      return {
        kind: 'bool',
        value: start.text === 'true',
        position: start.position,
        length: start.length,
      };
    }
    if (this.match('(')) {
      this.enter();
      const inner = this.parseExpression();
      this.depth--;
      this.expect(')', 'A ) is missing here.');
      return inner;
    }
    if (start.kind === 'name') {
      this.advance();
      if (this.match('(')) {
        const args: TinyExpr[] = [];
        if (!this.is(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.match(','));
        }
        this.expect(')', 'Close the argument list with ).');
        return { kind: 'call', name: start.text, args, ...this.span(start) };
      }
      if (this.match('[')) {
        const index = this.parseExpression();
        this.expect(']', 'Close the index with ].');
        return { kind: 'index', name: start.text, index, ...this.span(start) };
      }
      return { kind: 'name', name: start.text, position: start.position, length: start.length };
    }
    this.fail(
      `An expression cannot start with ${this.describe(start)}.`,
      'An expression starts with a name, a number, true, false, -, ! or (.',
    );
  }
}

/** Stage 2: builds the syntax tree. Takes the tokens from tinycLex, or source text directly. */
export function tinycParse(input: string | readonly TinyToken[]): TinyProgram {
  const tokens = typeof input === 'string' ? tinycLex(input) : input;
  return new Parser(tokens).parseProgram();
}
