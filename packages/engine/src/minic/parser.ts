import { EngineError } from '../core/result';
import type { CToken } from './tokens';

export type Scalar =
  'char' | 'uchar' | 'short' | 'int' | 'uint' | 'long' | 'float' | 'double' | 'void';

export interface CType {
  scalar: Scalar;
  pointers: number;
}

export interface Declarator {
  name: string;
  type: CType;
  /** Array sizes, outermost first. A null size comes from the initializer, as in int a[]. */
  dims: (Expr | null)[];
  init: Expr | null;
  at: number;
}

export type Expr =
  | { kind: 'num'; value: number; at: number }
  | { kind: 'float'; value: number; at: number }
  | { kind: 'string'; bytes: number[]; at: number }
  | { kind: 'name'; name: string; at: number }
  | { kind: 'assign'; op: string; target: Expr; value: Expr; at: number }
  | { kind: 'unary'; op: string; operand: Expr; at: number }
  | { kind: 'incdec'; op: '++' | '--'; prefix: boolean; target: Expr; at: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; at: number }
  | { kind: 'logical'; op: '&&' | '||'; left: Expr; right: Expr; at: number }
  | { kind: 'cond'; test: Expr; yes: Expr; no: Expr; at: number }
  | { kind: 'call'; callee: string; args: Expr[]; at: number }
  | { kind: 'index'; base: Expr; index: Expr; at: number }
  | { kind: 'deref'; operand: Expr; at: number }
  | { kind: 'addr'; operand: Expr; at: number }
  | { kind: 'comma'; left: Expr; right: Expr; at: number }
  | { kind: 'cast'; type: CType; operand: Expr; at: number }
  | { kind: 'sizeof-type'; type: CType; at: number }
  | { kind: 'sizeof-expr'; operand: Expr; at: number }
  | { kind: 'list'; items: Expr[]; at: number };

export type Stmt =
  | { kind: 'expr'; expr: Expr; at: number }
  | { kind: 'decl'; declarators: Declarator[]; at: number }
  | { kind: 'enum'; items: { name: string; value: Expr | null }[]; at: number }
  | { kind: 'block'; body: Stmt[]; at: number }
  /** Several statements from one declaration, which share the scope around them. */
  | { kind: 'group'; body: Stmt[]; at: number }
  | { kind: 'if'; test: Expr; yes: Stmt; no: Stmt | null; at: number }
  | { kind: 'while'; test: Expr; body: Stmt; at: number }
  | { kind: 'do'; test: Expr; body: Stmt; at: number }
  | {
      kind: 'for';
      init: Stmt | null;
      test: Expr | null;
      update: Expr | null;
      body: Stmt;
      at: number;
    }
  | { kind: 'return'; value: Expr | null; at: number }
  | { kind: 'break'; at: number }
  | { kind: 'continue'; at: number }
  | {
      kind: 'switch';
      test: Expr;
      /** Where each case label jumps to, as an index into body. A null value is default. */
      labels: { value: Expr | null; index: number }[];
      body: Stmt[];
      at: number;
    };

export interface FuncDef {
  name: string;
  returns: CType;
  params: { name: string; type: CType }[];
  body: Stmt[];
  at: number;
}

export interface Program {
  globals: Stmt[];
  functions: Map<string, FuncDef>;
}

const QUALIFIERS = new Set([
  'const',
  'static',
  'extern',
  'register',
  'volatile',
  'auto',
  'inline',
  'restrict',
]);
const TYPE_WORDS = new Set([
  'unsigned',
  'signed',
  'short',
  'long',
  'int',
  'char',
  'float',
  'double',
  'void',
  'size_t',
  'FILE',
  'bool',
  '_Bool',
  'enum',
]);
const UNSUPPORTED = new Set(['struct', 'union', 'typedef', 'goto']);

const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];
const ASSIGNMENT_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

const UNSUPPORTED_HINT = 'Simulated mode runs a small part of C. Install flex and gcc to use this.';

class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly CToken[]) {}

  private get token(): CToken {
    return this.tokens[this.at] as CToken;
  }

  private peek(distance = 1): CToken | undefined {
    return this.tokens[this.at + distance];
  }

  private isPunct(text: string): boolean {
    return this.token.kind === 'punct' && this.token.text === text;
  }

  private isWord(text: string): boolean {
    return this.token.kind === 'name' && this.token.text === text;
  }

  private accept(text: string): boolean {
    if (!this.isPunct(text)) return false;
    this.at++;
    return true;
  }

  private shown(): string {
    return this.token.kind === 'eof' ? 'the end of the code' : `"${this.token.text}"`;
  }

  private fail(message: string, hint: string, token: CToken = this.token): never {
    throw new EngineError({
      code: 'c_syntax',
      message,
      hint,
      position: token.offset,
      length: Math.max(1, token.length),
    });
  }

  private unsupported(what: string, token: CToken = this.token): never {
    throw new EngineError({
      code: 'c_unsupported',
      message: `Simulated mode does not support ${what}.`,
      hint: UNSUPPORTED_HINT,
      position: token.offset,
      length: Math.max(1, token.length),
    });
  }

  private expect(text: string, why: string): void {
    if (!this.accept(text)) {
      const previous = this.tokens[this.at - 1];
      this.fail(
        `Expected "${text}" ${why}, but found ${this.shown()}.`,
        text === ';'
          ? 'Every C statement ends with a semicolon. Check the end of the previous line.'
          : `Add the missing "${text}".`,
        text === ';' && previous ? previous : this.token,
      );
    }
  }

  private expectName(what: string): CToken {
    if (this.token.kind !== 'name') {
      this.fail(`Expected ${what}, but found ${this.shown()}.`, `Add ${what} here.`);
    }
    const token = this.token;
    this.at++;
    return token;
  }

  private startsType(): boolean {
    if (this.token.kind !== 'name') return false;
    const word = this.token.text;
    if (UNSUPPORTED.has(word)) this.unsupported(word === 'goto' ? 'goto' : `${word} types`);
    return TYPE_WORDS.has(word) || QUALIFIERS.has(word);
  }

  private parseSpecifiers(enums: Stmt[]): Scalar {
    const words: string[] = [];
    while (this.token.kind === 'name') {
      const word = this.token.text;
      if (UNSUPPORTED.has(word)) this.unsupported(word === 'goto' ? 'goto' : `${word} types`);
      if (QUALIFIERS.has(word)) {
        this.at++;
      } else if (word === 'enum') {
        this.at++;
        this.parseEnum(enums);
        words.push('int');
      } else if (TYPE_WORDS.has(word)) {
        this.at++;
        words.push(word);
      } else {
        break;
      }
    }
    return scalarFrom(words);
  }

  private parseEnum(enums: Stmt[]): void {
    const at = this.token.offset;
    if (this.token.kind === 'name') this.at++;
    if (!this.accept('{')) return;
    const items: { name: string; value: Expr | null }[] = [];
    while (!this.isPunct('}')) {
      const name = this.expectName('a name for this enum constant').text;
      const value = this.accept('=') ? this.parseConditional() : null;
      items.push({ name, value });
      if (!this.accept(',')) break;
    }
    this.expect('}', 'to close the enum');
    enums.push({ kind: 'enum', items, at });
  }

  private parsePointers(): number {
    let pointers = 0;
    for (;;) {
      if (this.accept('*')) pointers++;
      else if (this.isWord('const') || this.isWord('restrict')) this.at++;
      else return pointers;
    }
  }

  private parseDims(): (Expr | null)[] {
    const dims: (Expr | null)[] = [];
    while (this.accept('[')) {
      if (this.accept(']')) {
        dims.push(null);
      } else {
        dims.push(this.parseConditional());
        this.expect(']', 'to close the array size');
      }
    }
    return dims;
  }

  /** Parses one declaration after its specifiers. Returns the statement. */
  private parseDeclarators(scalar: Scalar, at: number, enums: Stmt[]): Stmt {
    const declarators: Declarator[] = [];
    do {
      const pointers = this.parsePointers();
      if (this.isPunct('(')) this.unsupported('function pointers');
      const name = this.expectName('a variable name');
      const dims = this.parseDims();
      const init = this.accept('=') ? this.parseInitializer() : null;
      declarators.push({
        name: name.text,
        type: { scalar, pointers },
        dims,
        init,
        at: name.offset,
      });
    } while (this.accept(','));
    this.expect(';', 'at the end of this declaration');
    const decl: Stmt = { kind: 'decl', declarators, at };
    return enums.length > 0 ? { kind: 'group', body: [...enums, decl], at } : decl;
  }

  private parseInitializer(): Expr {
    if (!this.isPunct('{')) return this.parseAssignment();
    const at = this.token.offset;
    this.at++;
    const items: Expr[] = [];
    while (!this.isPunct('}')) {
      items.push(this.parseInitializer());
      if (!this.accept(',')) break;
    }
    this.expect('}', 'to close this initializer');
    return { kind: 'list', items, at };
  }

  parseProgram(into: Program): void {
    while (this.token.kind !== 'eof') {
      if (this.accept(';')) continue;
      if (!this.startsType()) {
        const next = this.peek();
        // main() { ... } with no return type is old C, but textbooks still print it.
        if (this.token.kind === 'name' && next?.kind === 'punct' && next.text === '(') {
          this.parseFunction('int', 0, this.expectName('a function name'), into);
          continue;
        }
        this.fail(
          `Expected a declaration or a function here, but found ${this.shown()}.`,
          'Statements belong inside a function.',
        );
      }
      const at = this.token.offset;
      const enums: Stmt[] = [];
      const scalar = this.parseSpecifiers(enums);
      if (this.accept(';')) {
        into.globals.push(...enums);
        continue;
      }
      const start = this.at;
      const pointers = this.parsePointers();
      const nameToken = this.token;
      const next = this.peek();
      if (nameToken.kind === 'name' && next?.kind === 'punct' && next.text === '(') {
        this.at++;
        into.globals.push(...enums);
        this.parseFunction(scalar, pointers, nameToken, into);
        continue;
      }
      this.at = start;
      into.globals.push(this.parseDeclarators(scalar, at, enums));
    }
  }

  private parseFunction(scalar: Scalar, pointers: number, name: CToken, into: Program): void {
    this.expect('(', 'after the function name');
    const params: FuncDef['params'] = [];
    if (this.isWord('void') && this.peek()?.text === ')') this.at++;
    while (!this.isPunct(')')) {
      if (this.accept('...')) this.unsupported('functions with variable arguments', name);
      if (!this.startsType()) {
        this.fail(
          `Expected a parameter type, but found ${this.shown()}.`,
          'Write parameters like this: int count, char *text',
        );
      }
      const paramScalar = this.parseSpecifiers([]);
      let paramPointers = this.parsePointers();
      const paramName = this.token.kind === 'name' ? this.expectName('a parameter name').text : '';
      paramPointers += this.parseDims().length;
      params.push({ name: paramName, type: { scalar: paramScalar, pointers: paramPointers } });
      if (!this.accept(',')) break;
    }
    this.expect(')', 'to close the parameter list');
    if (this.accept(';')) return; // A prototype. The definition is found at run time.
    if (!this.isPunct('{')) {
      this.fail(
        `Expected the function body, but found ${this.shown()}.`,
        'Add { ... } after the parameters, or end a prototype with a semicolon.',
      );
    }
    if (into.functions.has(name.text)) {
      this.fail(
        `The function ${name.text} is defined twice.`,
        'Remove or rename one of them.',
        name,
      );
    }
    const body = this.parseBlock();
    into.functions.set(name.text, {
      name: name.text,
      returns: { scalar, pointers },
      params,
      body: body.kind === 'block' ? body.body : [body],
      at: name.offset,
    });
  }

  parseStatementList(): Stmt[] {
    const body: Stmt[] = [];
    while (this.token.kind !== 'eof') {
      if (this.isPunct('}')) {
        this.fail('This "}" has no matching "{".', 'Remove it, or add the missing "{".');
      }
      body.push(this.parseStatement());
    }
    return body;
  }

  private parseBlock(): Stmt {
    const at = this.token.offset;
    this.expect('{', 'to start this block');
    const body: Stmt[] = [];
    while (!this.isPunct('}')) {
      if (this.token.kind === 'eof') {
        this.fail('A "{" here is never closed.', 'Add the missing "}".');
      }
      body.push(this.parseStatement());
    }
    this.at++;
    return { kind: 'block', body, at };
  }

  private parseStatement(): Stmt {
    const at = this.token.offset;
    if (this.isPunct('{')) return this.parseBlock();
    if (this.accept(';')) return { kind: 'block', body: [], at };
    if (this.startsType()) {
      const enums: Stmt[] = [];
      const scalar = this.parseSpecifiers(enums);
      if (this.accept(';')) return { kind: 'group', body: enums, at };
      return this.parseDeclarators(scalar, at, enums);
    }
    if (this.token.kind === 'name') {
      switch (this.token.text) {
        case 'if':
          return this.parseIf(at);
        case 'while':
          return this.parseWhile(at);
        case 'do':
          return this.parseDo(at);
        case 'for':
          return this.parseFor(at);
        case 'switch':
          return this.parseSwitch(at);
        case 'return': {
          this.at++;
          const value = this.isPunct(';') ? null : this.parseExpression();
          this.expect(';', 'after return');
          return { kind: 'return', value, at };
        }
        case 'break':
          this.at++;
          this.expect(';', 'after break');
          return { kind: 'break', at };
        case 'continue':
          this.at++;
          this.expect(';', 'after continue');
          return { kind: 'continue', at };
        default:
      }
    }
    const expr = this.parseExpression();
    this.expect(';', 'at the end of this statement');
    return { kind: 'expr', expr, at };
  }

  private parseCondition(word: string): Expr {
    this.expect('(', `after ${word}`);
    const test = this.parseExpression();
    this.expect(')', `to close the ${word} condition`);
    return test;
  }

  private parseIf(at: number): Stmt {
    this.at++;
    const test = this.parseCondition('if');
    const yes = this.parseStatement();
    if (this.isWord('else')) {
      this.at++;
      return { kind: 'if', test, yes, no: this.parseStatement(), at };
    }
    return { kind: 'if', test, yes, no: null, at };
  }

  private parseWhile(at: number): Stmt {
    this.at++;
    const test = this.parseCondition('while');
    return { kind: 'while', test, body: this.parseStatement(), at };
  }

  private parseDo(at: number): Stmt {
    this.at++;
    const body = this.parseStatement();
    if (!this.isWord('while')) {
      this.fail(
        `Expected "while" after the do body, but found ${this.shown()}.`,
        'Add while (...);',
      );
    }
    this.at++;
    const test = this.parseCondition('while');
    this.expect(';', 'after the do-while condition');
    return { kind: 'do', test, body, at };
  }

  private parseFor(at: number): Stmt {
    this.at++;
    this.expect('(', 'after for');
    let init: Stmt | null = null;
    if (!this.accept(';')) {
      if (this.startsType()) {
        const enums: Stmt[] = [];
        const declAt = this.token.offset;
        const scalar = this.parseSpecifiers(enums);
        init = this.parseDeclarators(scalar, declAt, enums);
      } else {
        const expr = this.parseExpression();
        this.expect(';', 'after the first part of for');
        init = { kind: 'expr', expr, at };
      }
    }
    const test = this.isPunct(';') ? null : this.parseExpression();
    this.expect(';', 'after the second part of for');
    const update = this.isPunct(')') ? null : this.parseExpression();
    this.expect(')', 'to close the for header');
    return { kind: 'for', init, test, update, body: this.parseStatement(), at };
  }

  private parseSwitch(at: number): Stmt {
    this.at++;
    const test = this.parseCondition('switch');
    this.expect('{', 'to start the switch body');
    const labels: { value: Expr | null; index: number }[] = [];
    const body: Stmt[] = [];
    while (!this.isPunct('}')) {
      if (this.token.kind === 'eof') {
        this.fail('This switch is never closed.', 'Add the missing "}".');
      }
      if (this.isWord('case')) {
        this.at++;
        const value = this.parseConditional();
        this.expect(':', 'after the case value');
        labels.push({ value, index: body.length });
      } else if (this.isWord('default')) {
        this.at++;
        this.expect(':', 'after default');
        labels.push({ value: null, index: body.length });
      } else {
        body.push(this.parseStatement());
      }
    }
    this.at++;
    return { kind: 'switch', test, labels, body, at };
  }

  parseExpression(): Expr {
    let left = this.parseAssignment();
    while (this.isPunct(',')) {
      const at = this.token.offset;
      this.at++;
      left = { kind: 'comma', left, right: this.parseAssignment(), at };
    }
    return left;
  }

  private parseAssignment(): Expr {
    const left = this.parseConditional();
    if (this.token.kind === 'punct' && ASSIGNMENT_OPS.has(this.token.text)) {
      const { text: op, offset: at } = this.token;
      this.at++;
      return { kind: 'assign', op, target: left, value: this.parseAssignment(), at };
    }
    return left;
  }

  private parseConditional(): Expr {
    const test = this.parseLogicalOr();
    if (!this.isPunct('?')) return test;
    const at = this.token.offset;
    this.at++;
    const yes = this.parseExpression();
    this.expect(':', 'in this ?: expression');
    return { kind: 'cond', test, yes, no: this.parseConditional(), at };
  }

  private parseLogicalOr(): Expr {
    let left = this.parseLogicalAnd();
    while (this.isPunct('||')) {
      const at = this.token.offset;
      this.at++;
      left = { kind: 'logical', op: '||', left, right: this.parseLogicalAnd(), at };
    }
    return left;
  }

  private parseLogicalAnd(): Expr {
    let left = this.parseBinary(0);
    while (this.isPunct('&&')) {
      const at = this.token.offset;
      this.at++;
      left = { kind: 'logical', op: '&&', left, right: this.parseBinary(0), at };
    }
    return left;
  }

  private parseBinary(level: number): Expr {
    const ops = BINARY_LEVELS[level];
    if (!ops) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    while (this.token.kind === 'punct' && ops.includes(this.token.text)) {
      const { text: op, offset: at } = this.token;
      this.at++;
      left = { kind: 'binary', op, left, right: this.parseBinary(level + 1), at };
    }
    return left;
  }

  private parseUnary(): Expr {
    const at = this.token.offset;
    if (this.token.kind === 'punct') {
      const { text } = this.token;
      if (text === '-' || text === '+' || text === '!' || text === '~') {
        this.at++;
        return { kind: 'unary', op: text, operand: this.parseUnary(), at };
      }
      if (text === '++' || text === '--') {
        this.at++;
        return { kind: 'incdec', op: text, prefix: true, target: this.parseUnary(), at };
      }
      if (text === '*') {
        this.at++;
        return { kind: 'deref', operand: this.parseUnary(), at };
      }
      if (text === '&') {
        this.at++;
        return { kind: 'addr', operand: this.parseUnary(), at };
      }
      if (text === '(' && this.typeFollows()) {
        this.at++;
        const type = this.parseTypeName();
        this.expect(')', 'to close this cast');
        return { kind: 'cast', type, operand: this.parseUnary(), at };
      }
    }
    if (this.isWord('sizeof')) return this.parseSizeof(at);
    return this.parsePostfix();
  }

  private typeFollows(): boolean {
    const next = this.peek();
    if (next?.kind !== 'name') return false;
    if (UNSUPPORTED.has(next.text)) this.unsupported(`${next.text} types`, next);
    return TYPE_WORDS.has(next.text) || QUALIFIERS.has(next.text);
  }

  private parseTypeName(): CType {
    const scalar = this.parseSpecifiers([]);
    return { scalar, pointers: this.parsePointers() };
  }

  private parseSizeof(at: number): Expr {
    this.at++;
    if (this.isPunct('(') && this.typeFollows()) {
      this.at++;
      const type = this.parseTypeName();
      this.expect(')', 'to close sizeof');
      return { kind: 'sizeof-type', type, at };
    }
    return { kind: 'sizeof-expr', operand: this.parseUnary(), at };
  }

  private parsePostfix(): Expr {
    let node = this.parsePrimary();
    for (;;) {
      const at = this.token.offset;
      if (this.accept('[')) {
        const index = this.parseExpression();
        this.expect(']', 'to close this index');
        node = { kind: 'index', base: node, index, at };
      } else if (this.isPunct('(')) {
        if (node.kind !== 'name') this.unsupported('calling through a function pointer');
        this.at++;
        const args: Expr[] = [];
        while (!this.isPunct(')')) {
          args.push(this.parseAssignment());
          if (!this.accept(',')) break;
        }
        this.expect(')', 'to close this function call');
        node = { kind: 'call', callee: node.name, args, at: node.at };
      } else if (this.isPunct('++') || this.isPunct('--')) {
        const op = this.token.text as '++' | '--';
        this.at++;
        node = { kind: 'incdec', op, prefix: false, target: node, at };
      } else if (this.isPunct('.') || this.isPunct('->')) {
        this.unsupported('struct fields');
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): Expr {
    const token = this.token;
    switch (token.kind) {
      case 'int':
      case 'char':
        this.at++;
        return { kind: 'num', value: token.value, at: token.offset };
      case 'float':
        this.at++;
        return { kind: 'float', value: token.value, at: token.offset };
      case 'string': {
        const bytes = [...(token.bytes as number[])];
        this.at++;
        // Adjacent string literals join into one, as in C.
        while (this.token.kind === 'string') {
          bytes.push(...(this.token.bytes as number[]));
          this.at++;
        }
        return { kind: 'string', bytes, at: token.offset };
      }
      case 'name':
        this.at++;
        return { kind: 'name', name: token.text, at: token.offset };
      default:
    }
    if (this.accept('(')) {
      const inner = this.parseExpression();
      this.expect(')', 'to close this group');
      return inner;
    }
    return this.fail(
      `Expected a value here, but found ${this.shown()}.`,
      'Check for a missing operand or a stray symbol.',
    );
  }
}

function scalarFrom(words: readonly string[]): Scalar {
  if (words.includes('char')) return words.includes('unsigned') ? 'uchar' : 'char';
  if (words.includes('void')) return 'void';
  if (words.includes('float')) return 'float';
  if (words.includes('double')) return 'double';
  if (words.includes('short')) return 'short';
  if (words.includes('long') || words.includes('size_t')) return 'long';
  if (words.includes('unsigned')) return 'uint';
  return 'int';
}

/** Parses top-level C into `into`, so several pieces of a .l file can share one program. */
export function parseCProgram(tokens: readonly CToken[], into: Program): void {
  new Parser(tokens).parseProgram(into);
}

/** Parses the statements of a flex action. */
export function parseCStatements(tokens: readonly CToken[]): Stmt[] {
  return new Parser(tokens).parseStatementList();
}
