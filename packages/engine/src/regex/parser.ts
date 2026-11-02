import { EngineError } from '../core/result';
import {
  charSet,
  formatCharSet,
  negateSet,
  singleChar,
  unionSets,
  type CharRange,
  type CharSet,
} from './charset';

export interface Span {
  start: number;
  end: number;
}

export type RegexNode =
  | { type: 'empty'; span: Span }
  | { type: 'charset'; set: CharSet; label: string; span: Span }
  | { type: 'union' | 'concat'; left: RegexNode; right: RegexNode; span: Span }
  | { type: 'star' | 'plus' | 'optional'; child: RegexNode; span: Span };

export const MAX_REGEX_LENGTH = 300;
const MAX_NESTING = 64;

const DIGITS: CharSet = [[0x30, 0x39]];
const WORD: CharSet = charSet([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);
const SPACE: CharSet = charSet([
  [0x09, 0x0d],
  [0x20, 0x20],
]);
const ANY_BUT_NEWLINE = negateSet(singleChar(0x0a));

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  f: 0x0c,
  v: 0x0b,
};

const CLASS_ESCAPES: Readonly<Record<string, CharSet>> = {
  d: DIGITS,
  D: negateSet(DIGITS),
  w: WORD,
  W: negateSet(WORD),
  s: SPACE,
  S: negateSet(SPACE),
};

const EPSILON = 'ε';

class Parser {
  private position = 0;
  private readonly openGroups: number[] = [];

  constructor(private readonly source: string) {}

  parse(): RegexNode {
    if (this.source.trim().length === 0) {
      this.fail('empty_regex', 'Type a regular expression to get started.', 0, 0);
    }
    if (this.source.length > MAX_REGEX_LENGTH) {
      this.fail(
        'regex_too_long',
        `This expression is longer than the ${MAX_REGEX_LENGTH} characters this tool accepts.`,
        MAX_REGEX_LENGTH,
        this.source.length - MAX_REGEX_LENGTH,
        'Try a shorter expression.',
      );
    }
    const node = this.parseUnion();
    if (this.position < this.source.length) {
      // parseUnion only stops early at a ")" with no matching "(".
      this.fail(
        'unmatched_paren',
        'This closing parenthesis has no matching opening one.',
        this.position,
        1,
        'Remove it, or add a "(" earlier. To match a literal ")", write \\).',
      );
    }
    return node;
  }

  private fail(
    code: string,
    message: string,
    position: number,
    length: number,
    hint?: string,
  ): never {
    throw new EngineError({ code, message, position, length, ...(hint ? { hint } : {}) });
  }

  private peek(): string | undefined {
    return this.source[this.position];
  }

  private readCodePoint(): number {
    const codePoint = this.source.codePointAt(this.position) as number;
    this.position += String.fromCodePoint(codePoint).length;
    return codePoint;
  }

  private parseUnion(): RegexNode {
    let left = this.parseConcat();
    while (this.peek() === '|') {
      this.position++;
      const right = this.parseConcat();
      left = { type: 'union', left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseConcat(): RegexNode {
    const start = this.position;
    let node: RegexNode | null = null;
    while (this.position < this.source.length) {
      const char = this.peek();
      if (char === '|' || char === ')') break;
      const next = this.parsePostfix();
      node = node
        ? {
            type: 'concat',
            left: node,
            right: next,
            span: { start: node.span.start, end: next.span.end },
          }
        : next;
    }
    if (!node) {
      const openGroup = this.openGroups.at(-1);
      if (openGroup !== undefined && this.position >= this.source.length) {
        this.fail(
          'unclosed_paren',
          'This opening parenthesis is never closed.',
          openGroup,
          1,
          'Add a ")" where the group ends. To match a literal "(", write \\(.',
        );
      }
      if (this.peek() === ')' && openGroup === undefined) {
        this.fail(
          'unmatched_paren',
          'This closing parenthesis has no matching opening one.',
          start,
          1,
          'Remove it, or add a "(" earlier. To match a literal ")", write \\).',
        );
      }
      this.fail(
        'empty_alternative',
        'One side of this "|" or "(" group is empty.',
        start,
        1,
        'Add something there. To allow the empty string on purpose, write ε, as in a|ε.',
      );
    }
    return node;
  }

  private parsePostfix(): RegexNode {
    let node = this.parsePrimary();
    for (let char = this.peek(); char !== undefined; char = this.peek()) {
      const type = char === '*' ? 'star' : char === '+' ? 'plus' : char === '?' ? 'optional' : null;
      if (!type) break;
      this.position++;
      node = { type, child: node, span: { start: node.span.start, end: this.position } };
    }
    return node;
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
        return this.parseEscape();
      case '*':
      case '+':
      case '?':
        return this.fail(
          'nothing_to_repeat',
          `"${char}" has nothing before it to repeat.`,
          start,
          1,
          `Put a character or a group before it. To match a literal ${char}, write \\${char}.`,
        );
      case '{':
      case '}':
        return this.fail(
          'unsupported_braces',
          'Repeat counts like a{2,3} are not supported in this tool.',
          start,
          1,
          'Write the repeats out, as in aa|aaa. To match a literal brace, write \\{ or \\}.',
        );
      case ']':
        return this.fail(
          'unmatched_bracket',
          'This "]" has no matching "[".',
          start,
          1,
          'Remove it, or write \\] to match a literal "]".',
        );
      case '.':
        this.position++;
        return this.charsetNode(ANY_BUT_NEWLINE, start);
      case EPSILON:
        this.position++;
        return { type: 'empty', span: { start, end: this.position } };
      default:
        return this.charsetNode(singleChar(this.readCodePoint()), start);
    }
  }

  private charsetNode(set: CharSet, start: number): RegexNode {
    return {
      type: 'charset',
      set,
      label: formatCharSet(set),
      span: { start, end: this.position },
    };
  }

  private parseGroup(): RegexNode {
    const start = this.position;
    if (this.openGroups.length >= MAX_NESTING) {
      this.fail(
        'nesting_too_deep',
        'These parentheses are nested too deeply to process.',
        start,
        1,
        'Remove some of the nesting.',
      );
    }
    this.openGroups.push(start);
    this.position++;
    const inner = this.parseUnion();
    if (this.peek() !== ')') {
      this.fail(
        'unclosed_paren',
        'This opening parenthesis is never closed.',
        start,
        1,
        'Add a ")" where the group ends. To match a literal "(", write \\(.',
      );
    }
    this.position++;
    this.openGroups.pop();
    // The span includes the parentheses, so highlighting a star on a group covers the group.
    return { ...inner, span: { start, end: this.position } };
  }

  private parseEscape(): RegexNode {
    const start = this.position;
    this.position++;
    if (this.position >= this.source.length) {
      this.fail(
        'trailing_backslash',
        'This backslash has nothing after it to escape.',
        start,
        1,
        'Remove it, or write \\\\ to match a literal backslash.',
      );
    }
    return this.charsetNode(this.readEscapeBody(), start);
  }

  /** Reads what follows a backslash. Unknown escapes mean the character itself, as in Lex. */
  private readEscapeBody(): CharSet {
    const codePoint = this.readCodePoint();
    const char = String.fromCodePoint(codePoint);
    const named = SIMPLE_ESCAPES[char];
    if (named !== undefined) return singleChar(named);
    return CLASS_ESCAPES[char] ?? singleChar(codePoint);
  }

  /** Lex-style "literal text", where operators lose their meaning. */
  private parseQuoted(): RegexNode {
    const start = this.position;
    this.position++;
    let node: RegexNode | null = null;
    while (this.peek() !== '"') {
      if (this.position >= this.source.length) {
        this.fail(
          'unclosed_quote',
          'This quotation mark is never closed.',
          start,
          1,
          'Add a closing ". To match a literal quotation mark, write \\".',
        );
      }
      const charStart = this.position;
      let set: CharSet;
      if (this.peek() === '\\' && this.position + 1 < this.source.length) {
        this.position++;
        set = this.readEscapeBody();
      } else {
        set = singleChar(this.readCodePoint());
      }
      const next = this.charsetNode(set, charStart);
      node = node
        ? {
            type: 'concat',
            left: node,
            right: next,
            span: { start: charStart, end: this.position },
          }
        : next;
    }
    this.position++;
    if (!node) {
      this.fail(
        'empty_quote',
        'These quotation marks are empty.',
        start,
        2,
        'Add text between them.',
      );
    }
    return { ...node, span: { start, end: this.position } };
  }

  private parseClass(): RegexNode {
    const start = this.position;
    this.position++;
    const negated = this.peek() === '^';
    if (negated) this.position++;

    const parts: CharSet[] = [];
    const unclosed = () =>
      this.fail(
        'unclosed_class',
        'This character class is never closed.',
        start,
        1,
        'Add a "]" where the class ends. To match a literal "[", write \\[.',
      );

    while (this.peek() !== ']') {
      if (this.position >= this.source.length) unclosed();
      const itemStart = this.position;
      const low = this.readClassItem();
      const isRange =
        low.length === 1 &&
        (low[0] as CharRange)[0] === (low[0] as CharRange)[1] &&
        this.peek() === '-' &&
        this.position + 1 < this.source.length &&
        this.source[this.position + 1] !== ']';
      if (!isRange) {
        parts.push(low);
        continue;
      }
      this.position++;
      const high = this.readClassItem();
      const lowPoint = (low[0] as CharRange)[0];
      const highRange = high[0] as CharRange;
      if (high.length !== 1 || highRange[0] !== highRange[1]) {
        this.fail(
          'bad_class_range',
          'A range must end in a single character.',
          itemStart,
          this.position - itemStart,
          'Write it as two parts, or escape the dash as \\-.',
        );
      }
      if (highRange[0] < lowPoint) {
        this.fail(
          'reversed_range',
          `This range runs backwards, from "${String.fromCodePoint(lowPoint)}" down to "${String.fromCodePoint(highRange[0])}".`,
          itemStart,
          this.position - itemStart,
          'Put the lower character first, as in a-z.',
        );
      }
      parts.push([[lowPoint, highRange[0]]]);
    }
    if (parts.length === 0) {
      this.fail(
        'empty_class',
        'This character class is empty, so it could never match anything.',
        start,
        this.position - start + 1,
        'Add characters inside it. To match a literal "]", write \\].',
      );
    }
    this.position++;
    const set = unionSets(...parts);
    return this.charsetNode(negated ? negateSet(set) : set, start);
  }

  private readClassItem(): CharSet {
    if (this.peek() === '\\') {
      this.position++;
      if (this.position >= this.source.length) {
        this.fail(
          'unclosed_class',
          'This character class is never closed.',
          this.position - 1,
          1,
          'Add a "]" where the class ends.',
        );
      }
      return this.readEscapeBody();
    }
    return singleChar(this.readCodePoint());
  }
}

/** Throws an EngineError with a position and a hint when the expression is not valid. */
export function parseRegex(source: string): RegexNode {
  return new Parser(source).parse();
}
