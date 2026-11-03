import { EngineError } from '../core/result';
import {
  charSet,
  formatCharSet,
  negateSet,
  singleChar,
  unionSets,
  type CharRange,
  type CharSet,
} from '../regex/charset';
import type { RegexNode, Span } from '../regex/parser';
import { utf8Bytes } from './bytes';

export interface FlexPattern {
  node: RegexNode;
  /** `r/s`, or `r$`, which is short for r/\n. The context is matched but stays in the input. */
  trailing: RegexNode | null;
  /** `^r` only matches at the start of a line. */
  atLineStart: boolean;
}

const MAX_REPEAT = 255;
const MAX_NODES = 4000;

const ANY_BUT_NEWLINE = negateSet(singleChar(0x0a));

const NAMED_CLASSES: Readonly<Record<string, CharSet>> = {
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  blank: charSet([
    [0x09, 0x09],
    [0x20, 0x20],
  ]),
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f],
  ],
  digit: [[0x30, 0x39]],
  graph: [[0x21, 0x7e]],
  lower: [[0x61, 0x7a]],
  print: [[0x20, 0x7e]],
  punct: charSet([
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
  ]),
  space: charSet([
    [0x09, 0x0d],
    [0x20, 0x20],
  ]),
  upper: [[0x41, 0x5a]],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66],
  ],
};

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  f: 0x0c,
  v: 0x0b,
  a: 0x07,
  b: 0x08,
};

/** Thompson's construction numbers states per node object, so a reused node must be copied. */
function cloneNode(node: RegexNode): RegexNode {
  switch (node.type) {
    case 'empty':
    case 'charset':
      return { ...node };
    case 'union':
    case 'concat':
      return { ...node, left: cloneNode(node.left), right: cloneNode(node.right) };
    default:
      return { ...node, child: cloneNode(node.child) };
  }
}

function countNodes(node: RegexNode): number {
  switch (node.type) {
    case 'empty':
    case 'charset':
      return 1;
    case 'union':
    case 'concat':
      return 1 + countNodes(node.left) + countNodes(node.right);
    default:
      return 1 + countNodes(node.child);
  }
}

function bothCases(set: CharSet): CharSet {
  const extra: CharRange[] = [];
  for (const [low, high] of set) {
    for (let code = Math.max(low, 0x41); code <= Math.min(high, 0x7a); code++) {
      if (code <= 0x5a) extra.push([code + 32, code + 32]);
      else if (code >= 0x61) extra.push([code - 32, code - 32]);
    }
  }
  return unionSets(set, extra);
}

class PatternParser {
  private position = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    /** Where this pattern sits in the .l file, so errors can point at it. */
    private readonly baseOffset: number,
    private readonly definitions: ReadonlyMap<string, RegexNode>,
    private readonly caseless: boolean,
  ) {}

  parseRule(): FlexPattern {
    let atLineStart = false;
    if (this.peek() === '^') {
      atLineStart = true;
      this.position++;
    }
    const node = this.parseUnion();
    let trailing: RegexNode | null = null;
    if (this.peek() === '/') {
      this.position++;
      trailing = this.parseUnion();
    } else if (this.peek() === '$' && this.position === this.source.length - 1) {
      this.position++;
      trailing = this.charset(singleChar(0x0a), this.position - 1);
    }
    this.expectEnd();
    return { node, trailing, atLineStart };
  }

  parseDefinition(): RegexNode {
    const node = this.parseUnion();
    this.expectEnd();
    return node;
  }

  private expectEnd(): void {
    if (this.position < this.source.length) {
      const char = this.peek() as string;
      this.fail(
        char === ')' ? 'flex_unmatched_paren' : 'flex_bad_pattern',
        char === ')'
          ? 'This ")" has no matching "(".'
          : `Simulated mode cannot read "${char}" at this point in the pattern.`,
        this.position,
        char === ')'
          ? 'Remove it, or write \\) to match a parenthesis.'
          : `Write \\${char} to match it literally.`,
      );
    }
  }

  private peek(): string | undefined {
    return this.source[this.position];
  }

  private fail(code: string, message: string, at: number, hint: string): never {
    throw new EngineError({ code, message, hint, position: this.baseOffset + at, length: 1 });
  }

  private span(start: number): Span {
    return { start, end: this.position };
  }

  /** A fresh copy of a node, checked against the size limit before it is built. */
  private copy(node: RegexNode): RegexNode {
    this.count(countNodes(node));
    return cloneNode(node);
  }

  private count(nodes = 1): void {
    this.nodes += nodes;
    if (this.nodes > MAX_NODES) {
      this.fail(
        'flex_pattern_too_big',
        'This pattern is too large for Simulated mode to process.',
        0,
        'Use smaller repeat counts.',
      );
    }
  }

  private charset(set: CharSet, start: number): RegexNode {
    this.count();
    const final = this.caseless ? bothCases(set) : set;
    return { type: 'charset', set: final, label: formatCharSet(final), span: this.span(start) };
  }

  private concat(left: RegexNode | null, right: RegexNode): RegexNode {
    if (!left) return right;
    this.count();
    return { type: 'concat', left, right, span: { start: left.span.start, end: right.span.end } };
  }

  private parseUnion(): RegexNode {
    let left = this.parseConcat();
    while (this.peek() === '|') {
      this.position++;
      const right = this.parseConcat();
      this.count();
      left = { type: 'union', left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseConcat(): RegexNode {
    const start = this.position;
    let node: RegexNode | null = null;
    while (this.position < this.source.length) {
      const char = this.peek();
      if (char === '|' || char === ')' || char === '/') break;
      if (char === '$' && this.position === this.source.length - 1) break;
      node = this.concat(node, this.parsePostfix());
    }
    if (!node) {
      this.fail(
        'flex_empty_pattern',
        'One side of this "|" or "(" group is empty.',
        start,
        'Add something there. To make it optional, use ? instead.',
      );
    }
    return node;
  }

  private parsePostfix(): RegexNode {
    let node = this.parsePrimary();
    for (let char = this.peek(); char !== undefined; char = this.peek()) {
      if (char === '*' || char === '+' || char === '?') {
        this.position++;
        this.count();
        const type = char === '*' ? 'star' : char === '+' ? 'plus' : 'optional';
        node = { type, child: node, span: { start: node.span.start, end: this.position } };
      } else if (char === '{' && /\d/.test(this.source[this.position + 1] ?? '')) {
        node = this.parseRepeat(node);
      } else {
        break;
      }
    }
    return node;
  }

  private parseRepeat(node: RegexNode): RegexNode {
    const start = this.position;
    const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(start));
    if (!match) {
      this.fail(
        'flex_bad_repeat',
        'This repeat count is not closed properly.',
        start,
        'Write it as {2}, {2,} or {2,5}.',
      );
    }
    this.position += match[0].length;
    const low = Number(match[1]);
    const unbounded = match[2] !== undefined && match[3] === '';
    const high = match[2] === undefined ? low : unbounded ? low : Number(match[3]);
    if (low > MAX_REPEAT || high > MAX_REPEAT) {
      this.fail(
        'flex_repeat_too_big',
        `Simulated mode allows repeat counts up to ${MAX_REPEAT}.`,
        start,
        'Use a smaller count.',
      );
    }
    if (high < low) {
      this.fail(
        'flex_bad_repeat',
        `This repeat runs backwards, from ${low} down to ${high}.`,
        start,
        'Put the smaller number first.',
      );
    }
    if (high === 0 && !unbounded) {
      this.fail('flex_bad_repeat', 'A repeat of zero matches nothing.', start, 'Remove it.');
    }
    let result: RegexNode | null = null;
    for (let i = 0; i < low; i++) result = this.concat(result, this.copy(node));
    if (unbounded) {
      this.count();
      const star: RegexNode = { type: 'star', child: this.copy(node), span: node.span };
      return this.concat(result, star);
    }
    // a{1,3} is a(a(a)?)?, built from the inside out.
    let optional: RegexNode | null = null;
    for (let i = low; i < high; i++) {
      this.count();
      const inner: RegexNode = optional ? this.concat(this.copy(node), optional) : this.copy(node);
      optional = { type: 'optional', child: inner, span: node.span };
    }
    return optional ? this.concat(result, optional) : (result as RegexNode);
  }

  private parsePrimary(): RegexNode {
    const start = this.position;
    const char = this.peek() as string;
    switch (char) {
      case '(':
        return this.parseGroup();
      case '[':
        return this.parseClass();
      case '"':
        return this.parseQuoted();
      case '\\':
        this.position++;
        return this.charset(this.readEscape(start), start);
      case '.':
        this.position++;
        return this.charset(ANY_BUT_NEWLINE, start);
      case '{':
        return this.parseName();
      case '*':
      case '+':
      case '?':
        return this.fail(
          'flex_nothing_to_repeat',
          `"${char}" has nothing before it to repeat.`,
          start,
          `Put a character or a group before it, or write \\${char} to match it.`,
        );
      default:
        return this.parseLiteral();
    }
  }

  /** A non-ASCII character in a pattern is several bytes, so it becomes a sequence. */
  private parseLiteral(): RegexNode {
    const start = this.position;
    const point = this.source.codePointAt(start) as number;
    const text = String.fromCodePoint(point);
    this.position += text.length;
    let node: RegexNode | null = null;
    for (const byte of utf8Bytes(text))
      node = this.concat(node, this.charset(singleChar(byte), start));
    return node as RegexNode;
  }

  private parseGroup(): RegexNode {
    const start = this.position;
    this.position++;
    if (this.peek() === '?') {
      this.fail(
        'flex_unsupported',
        'Simulated mode does not support (?...) pattern options.',
        start,
        'Write the pattern out in full, or install flex to use this.',
      );
    }
    const inner = this.parseUnion();
    if (this.peek() !== ')') {
      this.fail(
        'flex_unclosed_paren',
        'This "(" is never closed.',
        start,
        'Add a ")" where the group ends. Spaces end a pattern unless they are quoted.',
      );
    }
    this.position++;
    return { ...inner, span: this.span(start) };
  }

  private parseName(): RegexNode {
    const start = this.position;
    const end = this.source.indexOf('}', start);
    const name = end === -1 ? '' : this.source.slice(start + 1, end);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
      this.fail(
        'flex_bad_name',
        'A "{" must start a repeat count like {2,3} or a definition name like {DIGIT}.',
        start,
        'Write \\{ to match a brace.',
      );
    }
    const definition = this.definitions.get(name);
    if (!definition) {
      this.fail(
        'flex_undefined_name',
        `{${name}} is used here, but it is not defined in the first section.`,
        start,
        `Add a line like this before the first %%: ${name} [0-9]+`,
      );
    }
    this.position = end + 1;
    return { ...this.copy(definition), span: this.span(start) };
  }

  private readEscape(start: number): CharSet {
    const char = this.peek();
    if (char === undefined) {
      this.fail(
        'flex_trailing_backslash',
        'This backslash has nothing after it to escape.',
        start,
        'Write \\\\ to match a backslash.',
      );
    }
    const rest = this.source.slice(this.position);
    const octal = /^[0-7]{1,3}/.exec(rest);
    if (octal) {
      this.position += octal[0].length;
      return singleChar(parseInt(octal[0], 8) & 0xff);
    }
    const hex = /^x[0-9a-fA-F]{1,2}/.exec(rest);
    if (hex) {
      this.position += hex[0].length;
      return singleChar(parseInt(hex[0].slice(1), 16));
    }
    this.position++;
    const named = SIMPLE_ESCAPES[char];
    return singleChar(named ?? (char.codePointAt(0) as number));
  }

  private parseQuoted(): RegexNode {
    const start = this.position;
    this.position++;
    let node: RegexNode | null = null;
    while (this.peek() !== '"') {
      if (this.position >= this.source.length) {
        this.fail(
          'flex_unclosed_quote',
          'This quotation mark is never closed.',
          start,
          'Add a closing ". To match a quotation mark, write \\".',
        );
      }
      const charStart = this.position;
      if (this.peek() === '\\') {
        this.position++;
        node = this.concat(node, this.charset(this.readEscape(charStart), charStart));
      } else {
        node = this.concat(node, this.parseLiteral());
      }
    }
    this.position++;
    if (!node) {
      this.fail(
        'flex_empty_quote',
        'These quotation marks are empty.',
        start,
        'Add text between them.',
      );
    }
    return { ...node, span: this.span(start) };
  }

  private parseClass(): RegexNode {
    const start = this.position;
    this.position++;
    const negated = this.peek() === '^';
    if (negated) this.position++;
    const parts: CharSet[] = [];
    // A "]" right after the opening bracket is an ordinary member, as in []a].
    let first = true;
    while (first || this.peek() !== ']') {
      if (this.position >= this.source.length) {
        this.fail(
          'flex_unclosed_class',
          'This character class is never closed.',
          start,
          'Add a "]" where the class ends. Write \\[ to match a bracket.',
        );
      }
      first = false;
      const named = /^\[:(\^?)([a-z]+):\]/.exec(this.source.slice(this.position));
      if (named) {
        parts.push(this.readNamedClass(named));
        continue;
      }
      const itemStart = this.position;
      const low = this.readClassItem();
      const isRange =
        this.peek() === '-' &&
        this.position + 1 < this.source.length &&
        this.source[this.position + 1] !== ']';
      if (!isRange) {
        parts.push(singleChar(low));
        continue;
      }
      this.position++;
      const high = this.readClassItem();
      if (high < low) {
        this.fail(
          'flex_reversed_range',
          `This range runs backwards, from "${String.fromCharCode(low)}" down to "${String.fromCharCode(high)}".`,
          itemStart,
          'Put the lower character first, as in a-z.',
        );
      }
      parts.push([[low, high]]);
    }
    this.position++;
    const set = unionSets(...parts);
    const cased = this.caseless ? bothCases(set) : set;
    return this.charset(negated ? negateSet(cased) : cased, start);
  }

  private readNamedClass(match: RegExpExecArray): CharSet {
    const set = NAMED_CLASSES[match[2] as string];
    if (!set) {
      this.fail(
        'flex_bad_class_name',
        `[:${match[2]}:] is not a character class name.`,
        this.position,
        `Use one of: ${Object.keys(NAMED_CLASSES).join(', ')}.`,
      );
    }
    this.position += match[0].length;
    return match[1] ? negateSet(set) : set;
  }

  private readClassItem(): number {
    const start = this.position;
    const char = this.peek() as string;
    if (char === '\\') {
      this.position++;
      return (this.readEscape(start)[0] as CharRange)[0];
    }
    const point = this.source.codePointAt(start) as number;
    if (point >= 0x80) {
      this.fail(
        'flex_non_ascii_class',
        'Simulated mode only allows ASCII characters inside [ ].',
        start,
        'Write the character outside the class, or install flex to use this.',
      );
    }
    this.position++;
    return point;
  }
}

export function parseFlexPattern(
  source: string,
  baseOffset: number,
  definitions: ReadonlyMap<string, RegexNode>,
  caseless: boolean,
): FlexPattern {
  return new PatternParser(source, baseOffset, definitions, caseless).parseRule();
}

export function parseFlexDefinition(
  source: string,
  baseOffset: number,
  definitions: ReadonlyMap<string, RegexNode>,
  caseless: boolean,
): RegexNode {
  return new PatternParser(source, baseOffset, definitions, caseless).parseDefinition();
}
