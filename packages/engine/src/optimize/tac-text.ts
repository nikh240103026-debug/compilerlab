import { EngineError } from '../core/result';
import {
  formatTac,
  type TacBinaryOp,
  type TacInstr,
  type TacOperand,
  type TacUnaryOp,
} from '../ir/types';

/** Generous for a hand-written example, and it keeps every trace small enough to animate. */
export const MAX_TAC_LINES = 1000;

const BINARY_OPS: readonly string[] = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
];

interface Word {
  text: string;
  offset: number;
}

const WORD = /[A-Za-z_$][A-Za-z0-9_$.]*|\d+|<=|>=|==|!=|&&|\|\||[-+*/%<>!=,:[\]]/g;

function fail(message: string, offset: number, length: number, hint: string): never {
  throw new EngineError({ code: 'bad_tac', message, hint, position: offset, length });
}

function splitWords(line: string, lineOffset: number, lineNumber: number): Word[] {
  const words: Word[] = [];
  let last = 0;
  for (const match of line.matchAll(WORD)) {
    const gap = line.slice(last, match.index);
    if (gap.trim() !== '') {
      fail(
        `Line ${lineNumber}: "${gap.trim()}" is not part of three-address code.`,
        lineOffset + last + gap.indexOf(gap.trim()),
        gap.trim().length,
        'Write statements like: t1 = a + b',
      );
    }
    words.push({ text: match[0], offset: lineOffset + match.index });
    last = match.index + match[0].length;
  }
  const rest = line.slice(last);
  if (rest.trim() !== '') {
    fail(
      `Line ${lineNumber}: "${rest.trim()}" is not part of three-address code.`,
      lineOffset + last + rest.indexOf(rest.trim()),
      rest.trim().length,
      'Write statements like: t1 = a + b',
    );
  }
  return words;
}

const isName = (text: string | undefined) => text !== undefined && /^[A-Za-z_$]/.test(text);
const isNumber = (text: string | undefined) => text !== undefined && /^\d/.test(text);

/** Book convention: a name like t1 is a compiler temporary, anything else is a program variable. */
export function optIsTempName(name: string): boolean {
  return /^t\d+$/.test(name);
}

export function optOperandOfName(name: string): TacOperand {
  return optIsTempName(name) ? { kind: 'temp', name } : { kind: 'var', name };
}

/** Reads the statements of one line. A cursor object keeps the helper functions short. */
class LineReader {
  private index = 0;

  constructor(
    private readonly words: readonly Word[],
    private readonly lineNumber: number,
    private readonly lineOffset: number,
  ) {}

  peek(ahead = 0): string | undefined {
    return this.words[this.index + ahead]?.text;
  }

  next(): Word {
    const word = this.words[this.index];
    if (!word) this.failHere('This statement stops too early.');
    this.index++;
    return word;
  }

  atEnd(): boolean {
    return this.index >= this.words.length;
  }

  failHere(message: string, hint = 'Write statements like: t1 = a + b'): never {
    const word = this.words[this.index];
    fail(
      `Line ${this.lineNumber}: ${message}`,
      word?.offset ?? this.lineOffset,
      word?.text.length ?? 1,
      hint,
    );
  }

  expect(text: string): void {
    if (this.peek() !== text) {
      this.failHere(`Expected "${text}" here, but found ${this.describeNext()}.`);
    }
    this.index++;
  }

  describeNext(): string {
    const next = this.peek();
    return next === undefined ? 'the end of the line' : `"${next}"`;
  }

  name(what: string): Word {
    if (!isName(this.peek())) {
      this.failHere(`Expected ${what} here, but found ${this.describeNext()}.`);
    }
    return this.next();
  }

  operand(): TacOperand {
    const text = this.peek();
    if (text === '-' && isNumber(this.peek(1))) {
      this.index++;
      return { kind: 'const', value: -Number(this.next().text) };
    }
    if (isNumber(text)) return { kind: 'const', value: Number(this.next().text) };
    if (isName(text)) return optOperandOfName(this.next().text);
    this.failHere(`Expected a name or a number here, but found ${this.describeNext()}.`);
  }

  finish(): void {
    if (!this.atEnd()) {
      this.failHere(`Unexpected ${this.describeNext()} after the end of the statement.`);
    }
  }
}

interface ParseContext {
  nextGeneratedTemp: () => string;
  targets: { label: string; offset: number; line: number }[];
  labels: Map<string, number>;
}

function parseAssignment(reader: LineReader, out: TacInstr[]): void {
  const dest = reader.name('a destination').text;

  if (reader.peek() === '[') {
    reader.next();
    const index = reader.operand();
    reader.expect(']');
    reader.expect('=');
    const src = reader.operand();
    reader.finish();
    out.push({ op: 'store', base: dest, index, src });
    return;
  }

  reader.expect('=');
  const first = reader.peek();

  if (first === 'call') {
    reader.next();
    const name = reader.name('a function name').text;
    let argCount = 0;
    if (reader.peek() === ',') {
      reader.next();
      if (!isNumber(reader.peek())) reader.failHere('Expected the number of arguments here.');
      argCount = Number(reader.next().text);
    }
    reader.finish();
    out.push({ op: 'call', dest, name, argCount });
    return;
  }

  if ((first === '-' && !isNumber(reader.peek(1))) || first === '!') {
    const operator = reader.next().text as TacUnaryOp;
    const arg = reader.operand();
    reader.finish();
    out.push({ op: 'unary', dest, operator, arg });
    return;
  }

  // "x = a [ i ]" reads an array, and the base must be a name, so check before reading an operand.
  if (isName(first) && reader.peek(1) === '[') {
    const base = reader.next().text;
    reader.next();
    const index = reader.operand();
    reader.expect(']');
    reader.finish();
    out.push({ op: 'load', dest, base, index });
    return;
  }

  const left = reader.operand();
  if (reader.atEnd()) {
    out.push({ op: 'assign', dest, src: left });
    return;
  }

  const operator = reader.peek() as string;
  if (!BINARY_OPS.includes(operator)) {
    reader.failHere(`"${operator}" is not an operator here.`, `Operators: ${BINARY_OPS.join(' ')}`);
  }
  reader.next();
  const right = reader.operand();
  reader.finish();
  out.push({ op: 'binary', dest, operator: operator as TacBinaryOp, left, right });
}

function parseConditionalJump(
  reader: LineReader,
  negate: boolean,
  context: ParseContext,
  lineNumber: number,
  out: TacInstr[],
): void {
  reader.next();
  const left = reader.operand();
  let cond = left;

  // The book writes "if a < b goto L". Our TAC tests one operand, so the comparison gets its own
  // temporary just before the jump. The meaning is unchanged.
  if (reader.peek() !== 'goto') {
    const operator = reader.peek();
    if (operator === undefined || !BINARY_OPS.includes(operator)) {
      reader.failHere(`Expected "goto" here, but found ${reader.describeNext()}.`);
    }
    reader.next();
    const right = reader.operand();
    const temp = context.nextGeneratedTemp();
    out.push({
      op: 'binary',
      dest: temp,
      operator: operator as TacBinaryOp,
      left,
      right,
    });
    cond = { kind: 'temp', name: temp };
  }

  reader.expect('goto');
  const target = reader.name('a label');
  reader.finish();
  context.targets.push({ label: target.text, offset: target.offset, line: lineNumber });
  out.push(
    negate
      ? { op: 'if', cond, target: target.text, negate }
      : { op: 'if', cond, target: target.text },
  );
}

function parseStatement(
  reader: LineReader,
  context: ParseContext,
  lineNumber: number,
  out: TacInstr[],
): void {
  const first = reader.peek();

  if (first === 'goto') {
    reader.next();
    const target = reader.name('a label');
    reader.finish();
    context.targets.push({ label: target.text, offset: target.offset, line: lineNumber });
    out.push({ op: 'goto', target: target.text });
    return;
  }

  if (first === 'if' || first === 'ifFalse' || first === 'iffalse') {
    parseConditionalJump(reader, first !== 'if', context, lineNumber, out);
    return;
  }

  if (first === 'param') {
    reader.next();
    const arg = reader.operand();
    reader.finish();
    out.push({ op: 'param', arg });
    return;
  }

  if (first === 'call') {
    reader.next();
    const name = reader.name('a function name').text;
    let argCount = 0;
    if (reader.peek() === ',') {
      reader.next();
      if (!isNumber(reader.peek())) reader.failHere('Expected the number of arguments here.');
      argCount = Number(reader.next().text);
    }
    reader.finish();
    out.push({ op: 'call', dest: null, name, argCount });
    return;
  }

  if (first === 'return') {
    reader.next();
    if (reader.atEnd()) {
      out.push({ op: 'return', value: null });
      return;
    }
    const value = reader.operand();
    reader.finish();
    out.push({ op: 'return', value });
    return;
  }

  parseAssignment(reader, out);
}

/**
 * Parses textual three-address code, one statement per line:
 *
 *   t1 = a + b      x = -y       x = y       x = a[i]      a[i] = x
 *   L1:             goto L1      if x goto L1              ifFalse x goto L1
 *   if a < b goto L1             param x     t = call f, 2 return x
 *
 * A label may share a line with its statement. Lines may end with a // or # comment. A name like
 * t1 is a temporary, and anything else is a program variable.
 */
export function optParseTac(text: string): TacInstr[] {
  const lines = text.split('\n');
  if (lines.length > MAX_TAC_LINES) {
    throw new EngineError({
      code: 'tac_too_long',
      message: `This code has more than ${MAX_TAC_LINES} lines, which is too long to animate.`,
      hint: 'Try a shorter program.',
    });
  }

  // Generated temporaries must not collide with any the student wrote.
  let highestTemp = 0;
  for (const match of text.matchAll(/\bt(\d+)\b/g)) {
    highestTemp = Math.max(highestTemp, Number(match[1]));
  }

  const out: TacInstr[] = [];
  const context: ParseContext = {
    nextGeneratedTemp: () => `t${++highestTemp}`,
    targets: [],
    labels: new Map(),
  };

  let lineOffset = 0;
  lines.forEach((rawLine, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const commentAt = rawLine.search(/\/\/|#/);
    const line = commentAt === -1 ? rawLine : rawLine.slice(0, commentAt);
    let words = splitWords(line, lineOffset, lineNumber);

    while (words.length >= 2 && isName(words[0]?.text) && words[1]?.text === ':') {
      const label = words[0] as Word;
      if (context.labels.has(label.text)) {
        fail(
          `Line ${lineNumber}: the label ${label.text} is already used on line ${context.labels.get(label.text)}.`,
          label.offset,
          label.text.length,
          'Give each label its own name.',
        );
      }
      context.labels.set(label.text, lineNumber);
      out.push({ op: 'label', name: label.text });
      words = words.slice(2);
    }

    if (words.length > 0) {
      parseStatement(new LineReader(words, lineNumber, lineOffset), context, lineNumber, out);
    }
    lineOffset += rawLine.length + 1;
  });

  for (const { label, offset, line } of context.targets) {
    if (!context.labels.has(label)) {
      fail(
        `Line ${line}: this jumps to ${label}, but no line defines that label.`,
        offset,
        label.length,
        `Add a line "${label}:" where the jump should land.`,
      );
    }
  }

  if (out.length === 0) {
    throw new EngineError({
      code: 'empty_tac',
      message: 'There is no code here yet.',
      hint: 'Write a statement like: t1 = a + b',
    });
  }
  return out;
}

export function optFormatProgram(instrs: readonly TacInstr[]): string[] {
  return instrs.map(formatTac);
}
