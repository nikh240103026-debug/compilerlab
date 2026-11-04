import { EngineError } from '../core/result';

// The little language inside the braces of an SDD or SDT: assignments like E.val = E1.val + T.val
// and calls like addType(id.entry, L.inh). Parsing, printing and evaluating live here, so the
// SDD evaluator and the SDT runner agree on what a rule means.

export type SddValue = number | string | boolean;

export interface SddAttrRef {
  /** As the student wrote it, like E1 or T'. */
  written: string;
  attr: string;
  /** -1 for the head of the production, otherwise an index into its body. */
  occurrence: number;
}

export type SddExpr =
  | { kind: 'literal'; value: SddValue; quoted: boolean }
  | { kind: 'ref'; ref: SddAttrRef }
  | { kind: 'call'; name: string; args: SddExpr[] }
  | { kind: 'binary'; op: string; left: SddExpr; right: SddExpr }
  | { kind: 'unary'; op: string; arg: SddExpr };

export interface SddRule {
  text: string;
  /** null for a rule that only has a side effect, like print(E.val). */
  target: SddAttrRef | null;
  expr: SddExpr;
  /** Every attribute the right side reads, in reading order. */
  reads: SddAttrRef[];
  position: number;
  length: number;
}

/** Finds which occurrence a written name means, or throws a readable error. */
export type SddResolver = (written: string, position: number, length: number) => number;

const MAX_TEXT_VALUE = 10_000;
const MAX_EXPR_DEPTH = 64;

interface RuleToken {
  kind: 'name' | 'number' | 'string' | 'op' | 'end';
  text: string;
  value: number;
  start: number;
  end: number;
}

const RULE_NAME = /[A-Za-z_][A-Za-z0-9_]*'*[0-9]*'*/y;
const RULE_NUMBER = /[0-9]+(?:\.[0-9]+)?/y;
const RULE_OPERATORS = [':=', '==', '!=', '<=', '>=', '&&', '||', ...'=+-*/%<>!(),.;'];
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];
const RULE_HINT = 'Write a rule like E.val = E1.val + T.val, or a call like print(E.val).';

function ruleError(message: string, position: number, length: number, hint = RULE_HINT): never {
  throw new EngineError({ code: 'sdd_spec_bad_rule', message, hint, position, length });
}

function scanRule(source: string, start: number, end: number): RuleToken[] {
  const tokens: RuleToken[] = [];
  let at = start;
  while (at < end) {
    const char = source[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (/[A-Za-z_]/.test(char)) {
      RULE_NAME.lastIndex = at;
      const text = (RULE_NAME.exec(source) as RegExpExecArray)[0];
      tokens.push({ kind: 'name', text, value: 0, start: at, end: at + text.length });
      at += text.length;
    } else if (/[0-9]/.test(char)) {
      RULE_NUMBER.lastIndex = at;
      const text = (RULE_NUMBER.exec(source) as RegExpExecArray)[0];
      tokens.push({ kind: 'number', text, value: Number(text), start: at, end: at + text.length });
      at += text.length;
    } else if (char === "'" || char === '"') {
      const close = source.indexOf(char, at + 1);
      if (close === -1 || close >= end) {
        ruleError('This quoted text is never closed.', at, 1, `Add the closing ${char}.`);
      }
      tokens.push({
        kind: 'string',
        text: source.slice(at + 1, close),
        value: 0,
        start: at,
        end: close + 1,
      });
      at = close + 1;
    } else {
      const operator = RULE_OPERATORS.find((text) => source.startsWith(text, at));
      if (!operator) ruleError(`"${char}" cannot appear in a semantic rule.`, at, 1);
      tokens.push({
        kind: 'op',
        text: operator,
        value: 0,
        start: at,
        end: at + operator.length,
      });
      at += operator.length;
    }
  }
  tokens.push({ kind: 'end', text: '', value: 0, start: end, end });
  return tokens;
}

function isOp(token: RuleToken, text: string): boolean {
  return token.kind === 'op' && token.text === text;
}

class RuleParser {
  private at = 0;
  private depth = 0;
  private reads: SddAttrRef[] = [];

  constructor(
    private readonly source: string,
    private readonly tokens: RuleToken[],
    private readonly resolve: SddResolver,
  ) {}

  private peek(distance = 0): RuleToken {
    return this.tokens[Math.min(this.at + distance, this.tokens.length - 1)] as RuleToken;
  }

  rules(): SddRule[] {
    const rules: SddRule[] = [];
    while (this.peek().kind !== 'end') {
      if (isOp(this.peek(), ';')) this.at++;
      else rules.push(this.rule());
    }
    return rules;
  }

  private rule(): SddRule {
    const first = this.peek();
    this.reads = [];
    let target: SddAttrRef | null = null;
    const assignment =
      first.kind === 'name' &&
      isOp(this.peek(1), '.') &&
      this.peek(2).kind === 'name' &&
      (isOp(this.peek(3), '=') || isOp(this.peek(3), ':='));
    if (assignment) {
      target = {
        written: first.text,
        attr: this.peek(2).text,
        occurrence: this.resolve(first.text, first.start, first.end - first.start),
      };
      this.at += 4;
    }
    const expr = this.expression();
    if (target === null && expr.kind !== 'call') {
      ruleError(
        'A semantic rule must assign to an attribute or call something.',
        first.start,
        Math.max(1, first.end - first.start),
      );
    }
    const last = this.tokens[this.at - 1] as RuleToken;
    return {
      text: this.source.slice(first.start, last.end),
      target,
      expr,
      reads: this.reads,
      position: first.start,
      length: last.end - first.start,
    };
  }

  private expression(): SddExpr {
    if (this.depth >= MAX_EXPR_DEPTH) {
      ruleError(
        'This expression is nested too deeply.',
        this.peek().start,
        1,
        'Split it into simpler rules.',
      );
    }
    this.depth++;
    const expr = this.binary(0);
    this.depth--;
    return expr;
  }

  private binary(level: number): SddExpr {
    const operators = BINARY_LEVELS[level];
    if (!operators) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !operators.includes(token.text)) return left;
      this.at++;
      left = { kind: 'binary', op: token.text, left, right: this.binary(level + 1) };
    }
  }

  private unary(): SddExpr {
    const token = this.peek();
    if (isOp(token, '-') || isOp(token, '!')) {
      this.at++;
      if (this.depth >= MAX_EXPR_DEPTH) {
        ruleError('This expression is nested too deeply.', token.start, 1);
      }
      this.depth++;
      const arg = this.unary();
      this.depth--;
      return { kind: 'unary', op: token.text, arg };
    }
    return this.primary();
  }

  private primary(): SddExpr {
    const token = this.peek();
    if (token.kind === 'number') {
      this.at++;
      return { kind: 'literal', value: token.value, quoted: false };
    }
    if (token.kind === 'string') {
      this.at++;
      return { kind: 'literal', value: token.text, quoted: true };
    }
    if (isOp(token, '(')) {
      this.at++;
      const inner = this.expression();
      if (!isOp(this.peek(), ')')) {
        ruleError('A closing ) is missing here.', this.peek().start, 1, 'Add the ).');
      }
      this.at++;
      return inner;
    }
    if (token.kind !== 'name') {
      ruleError(
        token.kind === 'end'
          ? 'This semantic rule ends too early.'
          : `"${token.text}" cannot start an expression.`,
        token.start,
        Math.max(1, token.end - token.start),
      );
    }
    this.at++;
    if (isOp(this.peek(), '(')) return this.call(token);
    if (isOp(this.peek(), '.')) {
      const attr = this.peek(1);
      if (attr.kind !== 'name') {
        ruleError(`After ${token.text}. write an attribute name.`, attr.start, 1);
      }
      this.at += 2;
      const ref: SddAttrRef = {
        written: token.text,
        attr: attr.text,
        occurrence: this.resolve(token.text, token.start, token.end - token.start),
      };
      this.reads.push(ref);
      return { kind: 'ref', ref };
    }
    if (token.text === 'true') return { kind: 'literal', value: true, quoted: false };
    if (token.text === 'false') return { kind: 'literal', value: false, quoted: false };
    // A bare word stands for itself, which is how the book writes T.type = integer.
    return { kind: 'literal', value: token.text, quoted: false };
  }

  private call(name: RuleToken): SddExpr {
    this.at++;
    const args: SddExpr[] = [];
    if (!isOp(this.peek(), ')')) {
      for (;;) {
        args.push(this.expression());
        if (!isOp(this.peek(), ',')) break;
        this.at++;
      }
    }
    if (!isOp(this.peek(), ')')) {
      ruleError(`The call to ${name.text} needs a closing ).`, this.peek().start, 1, 'Add the ).');
    }
    this.at++;
    return { kind: 'call', name: name.text, args };
  }
}

/** Parses the rules in source[start..end), which is the text between one pair of braces. */
export function sddParseRules(
  source: string,
  start: number,
  end: number,
  resolve: SddResolver,
): SddRule[] {
  return new RuleParser(source, scanRule(source, start, end), resolve).rules();
}

const PRECEDENCE = new Map(
  BINARY_LEVELS.flatMap((operators, level) => operators.map((op) => [op, level] as const)),
);

function formatOperand(expr: SddExpr, parent: number, right: boolean, show: ShowRef): string {
  const text = sddFormatExpr(expr, show);
  if (expr.kind !== 'binary') return text;
  const level = PRECEDENCE.get(expr.op) as number;
  return level < parent || (right && level === parent) ? `(${text})` : text;
}

type ShowRef = (ref: SddAttrRef) => string;

/** Prints an expression, with `show` deciding how each attribute appears. */
export function sddFormatExpr(expr: SddExpr, show: ShowRef): string {
  switch (expr.kind) {
    case 'literal':
      return expr.quoted ? `'${String(expr.value)}'` : String(expr.value);
    case 'ref':
      return show(expr.ref);
    case 'call':
      return `${expr.name}(${expr.args.map((arg) => sddFormatExpr(arg, show)).join(', ')})`;
    case 'unary':
      return `${expr.op}${formatOperand(expr.arg, BINARY_LEVELS.length, false, show)}`;
    case 'binary': {
      const level = PRECEDENCE.get(expr.op) as number;
      const left = formatOperand(expr.left, level, false, show);
      const right = formatOperand(expr.right, level, true, show);
      return `${left} ${expr.op} ${right}`;
    }
  }
}

export function sddShowValue(value: SddValue | null): string {
  return value === null ? '?' : String(value);
}

function valueError(message: string, hint: string): never {
  throw new EngineError({ code: 'sdd_bad_value', message, hint });
}

function checkedText(text: string): string {
  if (text.length > MAX_TEXT_VALUE) {
    valueError(
      `An attribute grew past ${MAX_TEXT_VALUE} characters.`,
      'Rules that repeat a value can double its size at each level. Try a shorter input.',
    );
  }
  return text;
}

function needNumbers(op: string, left: SddValue, right: SddValue): [number, number] {
  if (typeof left !== 'number' || typeof right !== 'number') {
    valueError(
      `${String(left)} ${op} ${String(right)} needs two numbers.`,
      'Check which attribute holds text here.',
    );
  }
  return [left, right];
}

function applyBinary(op: string, left: SddValue, right: SddValue): SddValue {
  switch (op) {
    case '+':
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      return checkedText(String(left) + String(right));
    case '-': {
      const [a, b] = needNumbers(op, left, right);
      return a - b;
    }
    case '*': {
      const [a, b] = needNumbers(op, left, right);
      return a * b;
    }
    case '/': {
      const [a, b] = needNumbers(op, left, right);
      if (b === 0) valueError('A rule divides by zero.', 'Change the input so this cannot happen.');
      return a / b;
    }
    case '%': {
      const [a, b] = needNumbers(op, left, right);
      if (b === 0) valueError('A rule divides by zero.', 'Change the input so this cannot happen.');
      return a % b;
    }
    case '<': {
      const [a, b] = needNumbers(op, left, right);
      return a < b;
    }
    case '<=': {
      const [a, b] = needNumbers(op, left, right);
      return a <= b;
    }
    case '>': {
      const [a, b] = needNumbers(op, left, right);
      return a > b;
    }
    case '>=': {
      const [a, b] = needNumbers(op, left, right);
      return a >= b;
    }
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '&&':
      if (typeof left !== 'boolean' || typeof right !== 'boolean') {
        valueError(`&& needs true or false on both sides.`, 'Check the attributes used with &&.');
      }
      return left && right;
    default:
      // The book writes concatenation as ||, so || on anything but two booleans joins text.
      if (typeof left === 'boolean' && typeof right === 'boolean') return left || right;
      return checkedText(String(left) + String(right));
  }
}

function applyCall(name: string, args: SddValue[]): SddValue {
  const numbers = args.filter((arg): arg is number => typeof arg === 'number');
  if (numbers.length === args.length && args.length > 0) {
    if (name === 'max') return Math.max(...numbers);
    if (name === 'min') return Math.min(...numbers);
    if (name === 'abs' && numbers.length === 1) return Math.abs(numbers[0] as number);
  }
  if (name === 'concat') return checkedText(args.map(String).join(''));
  if (name === 'if' && args.length === 3)
    return args[0] ? (args[1] as SddValue) : (args[2] as SddValue);
  // Anything else is a term that stands for itself, like array(3, integer) or addType(x, float).
  return checkedText(`${name}(${args.map(String).join(', ')})`);
}

/** Evaluates an expression. Reading an attribute with no value gives null, which spreads. */
export function sddEvalExpr(
  expr: SddExpr,
  read: (ref: SddAttrRef) => SddValue | null,
): SddValue | null {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ref':
      return read(expr.ref);
    case 'unary': {
      const value = sddEvalExpr(expr.arg, read);
      if (value === null) return null;
      if (expr.op === '!') {
        if (typeof value !== 'boolean') valueError('! needs true or false.', 'Check this rule.');
        return !value;
      }
      if (typeof value !== 'number') valueError('Unary - needs a number.', 'Check this rule.');
      return -value;
    }
    case 'binary': {
      const left = sddEvalExpr(expr.left, read);
      const right = sddEvalExpr(expr.right, read);
      return left === null || right === null ? null : applyBinary(expr.op, left, right);
    }
    case 'call': {
      const args = expr.args.map((arg) => sddEvalExpr(arg, read));
      if (args.includes(null)) return null;
      return applyCall(expr.name, args as SddValue[]);
    }
  }
}

/** What a side-effect rule writes: print shows its values, and anything else shows the call. */
export function sddEffectText(
  expr: SddExpr,
  read: (ref: SddAttrRef) => SddValue | null,
): string | null {
  if (expr.kind === 'call' && expr.name === 'print') {
    const args = expr.args.map((arg) => sddEvalExpr(arg, read));
    return args.includes(null) ? null : args.map(String).join(' ');
  }
  const value = sddEvalExpr(expr, read);
  return value === null ? null : String(value);
}
