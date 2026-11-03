import { EngineError } from '../core/result';
import { utf8Bytes } from '../flex/bytes';

export type CTokenKind = 'name' | 'int' | 'float' | 'char' | 'string' | 'punct' | 'eof';

export interface CToken {
  kind: CTokenKind;
  text: string;
  /** The value of a number or character constant. */
  value: number;
  /** The bytes of a string literal. */
  bytes: number[] | null;
  offset: number;
  length: number;
}

/** Object-like #define macros, by name. */
export type MacroTable = Map<string, CToken[]>;

const PUNCTUATORS = [
  '...',
  '<<=',
  '>>=',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  ...'+-*/%=<>!~&|^?:;,.()[]{}',
];

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  f: 0x0c,
  v: 0x0b,
  a: 0x07,
  b: 0x08,
  e: 0x1b,
};

function fail(code: string, message: string, offset: number, hint: string): never {
  throw new EngineError({ code, message, hint, position: offset, length: 1 });
}

class Tokenizer {
  private at: number;
  private atLineStart = true;
  private readonly tokens: CToken[] = [];

  constructor(
    private readonly source: string,
    start: number,
    private readonly end: number,
    private readonly macros: MacroTable,
  ) {
    this.at = start;
  }

  run(): CToken[] {
    for (;;) {
      this.skipSpace();
      if (this.at >= this.end) break;
      const char = this.source[this.at] as string;
      if (char === '#' && this.atLineStart) {
        this.readDirective();
        continue;
      }
      this.atLineStart = false;
      if (/[A-Za-z_]/.test(char)) this.readName();
      else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(this.peekAt(1)))) {
        this.readNumber();
      } else if (char === "'") this.readChar();
      else if (char === '"') this.readString();
      else this.readPunctuator();
    }
    this.push('eof', '', 0, null, this.end, 0);
    return this.tokens;
  }

  private peekAt(distance: number): string {
    const index = this.at + distance;
    return index < this.end ? (this.source[index] as string) : '';
  }

  private push(
    kind: CTokenKind,
    text: string,
    value: number,
    bytes: number[] | null,
    offset: number,
    length: number,
  ): void {
    this.tokens.push({ kind, text, value, bytes, offset, length });
  }

  private skipSpace(): void {
    while (this.at < this.end) {
      const char = this.source[this.at];
      if (char === '\n') {
        this.atLineStart = true;
        this.at++;
      } else if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v') {
        this.at++;
      } else if (char === '\\' && /^\r?\n/.test(this.source.slice(this.at + 1, this.at + 3))) {
        // A backslash at the end of a line joins it to the next one.
        this.at += this.peekAt(1) === '\r' ? 3 : 2;
      } else if (char === '/' && this.peekAt(1) === '/') {
        while (this.at < this.end && this.source[this.at] !== '\n') this.at++;
      } else if (char === '/' && this.peekAt(1) === '*') {
        const close = this.source.indexOf('*/', this.at + 2);
        if (close === -1 || close >= this.end) {
          fail(
            'c_unclosed_comment',
            'This comment is never closed.',
            this.at,
            'Add */ where the comment ends.',
          );
        }
        this.at = close + 2;
      } else {
        return;
      }
    }
  }

  private readDirective(): void {
    const start = this.at;
    let lineEnd = this.at;
    for (;;) {
      const newline = this.source.indexOf('\n', lineEnd);
      lineEnd = newline === -1 || newline >= this.end ? this.end : newline;
      if (lineEnd < this.end && this.source[lineEnd - 1] === '\\') {
        lineEnd++;
        continue;
      }
      break;
    }
    const text = this.source.slice(start + 1, lineEnd);
    const match = /^\s*(\w+)\s*(.*)$/s.exec(text);
    const directive = match?.[1] ?? '';
    const rest = match?.[2] ?? '';
    if (directive === 'include' || directive === 'pragma') {
      // The built-in library is always available.
    } else if (directive === 'undef') {
      this.macros.delete(rest.trim());
    } else if (directive === 'define') {
      this.readDefine(rest, lineEnd - rest.length, start);
    } else {
      fail(
        'c_unsupported',
        `Simulated mode does not support #${directive || ' on its own'}.`,
        start,
        'Remove this line, or install flex and gcc to use the full preprocessor.',
      );
    }
    this.at = lineEnd;
  }

  private readDefine(rest: string, restOffset: number, directiveOffset: number): void {
    const match = /^([A-Za-z_]\w*)(\(?)/.exec(rest);
    if (!match) {
      fail(
        'c_bad_define',
        'A #define needs a name.',
        directiveOffset,
        'Write it like this: #define SIZE 100',
      );
    }
    if (match[2]) {
      fail(
        'c_unsupported',
        'Simulated mode does not support #define macros that take arguments.',
        directiveOffset,
        'Write a small function instead, or install flex and gcc to use this.',
      );
    }
    const name = match[1] as string;
    const bodyStart = restOffset + name.length;
    const body = new Tokenizer(this.source, bodyStart, restOffset + rest.length, this.macros).run();
    body.pop();
    this.macros.set(name, body);
  }

  private readName(): void {
    const start = this.at;
    while (this.at < this.end && /\w/.test(this.source[this.at] as string)) this.at++;
    const text = this.source.slice(start, this.at);
    const macro = this.macros.get(text);
    if (macro) {
      for (const token of macro) {
        this.tokens.push({ ...token, offset: start, length: text.length });
      }
      return;
    }
    this.push('name', text, 0, null, start, text.length);
  }

  private readNumber(): void {
    const start = this.at;
    const rest = this.source.slice(start, this.end);
    const hex = /^0[xX][0-9a-fA-F]+/.exec(rest);
    if (hex) {
      this.at += hex[0].length;
      this.push('int', hex[0], parseInt(hex[0], 16), null, start, hex[0].length);
    } else {
      const float = /^(\d+\.\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?|\d+[eE][-+]?\d+)/.exec(rest);
      if (float) {
        this.at += float[0].length;
        this.push('float', float[0], Number(float[0]), null, start, float[0].length);
      } else {
        const digits = (/^\d+/.exec(rest) as RegExpExecArray)[0];
        this.at += digits.length;
        const octal = digits.length > 1 && digits.startsWith('0');
        if (octal && /[89]/.test(digits)) {
          fail(
            'c_bad_number',
            `${digits} starts with 0, so it is octal, but 8 and 9 are not octal digits.`,
            start,
            'Remove the leading zero.',
          );
        }
        this.push('int', digits, parseInt(digits, octal ? 8 : 10), null, start, digits.length);
      }
    }
    const suffix = /^[uUlLfF]+/.exec(this.source.slice(this.at, this.end));
    if (suffix) {
      this.at += suffix[0].length;
      (this.tokens.at(-1) as CToken).length += suffix[0].length;
    }
  }

  /** Reads one possibly escaped character, at the cursor, as bytes. */
  private readEscaped(): number[] {
    const char = this.source[this.at] as string;
    if (char !== '\\') {
      const point = this.source.codePointAt(this.at) as number;
      const text = String.fromCodePoint(point);
      this.at += text.length;
      return utf8Bytes(text);
    }
    this.at++;
    const rest = this.source.slice(this.at, Math.min(this.at + 4, this.end));
    const octal = /^[0-7]{1,3}/.exec(rest);
    if (octal) {
      this.at += octal[0].length;
      return [parseInt(octal[0], 8) & 0xff];
    }
    const hex = /^x[0-9a-fA-F]{1,2}/.exec(rest);
    if (hex) {
      this.at += hex[0].length;
      return [parseInt(hex[0].slice(1), 16)];
    }
    const escaped = this.source[this.at] ?? '\\';
    this.at++;
    return [SIMPLE_ESCAPES[escaped] ?? (escaped.codePointAt(0) as number) & 0xff];
  }

  private readChar(): void {
    const start = this.at;
    this.at++;
    if (this.at >= this.end || this.source[this.at] === '\n') {
      fail(
        'c_unclosed_char',
        'This character constant is never closed.',
        start,
        "Write it like this: 'a'",
      );
    }
    if (this.source[this.at] === "'") {
      fail(
        'c_empty_char',
        'This character constant is empty.',
        start,
        "Put a character in it: 'a'",
      );
    }
    const bytes = this.readEscaped();
    if (this.source[this.at] !== "'" || bytes.length !== 1) {
      fail(
        'c_unclosed_char',
        'A character constant holds one character.',
        start,
        'For text, use double quotes: "abc"',
      );
    }
    this.at++;
    const value = bytes[0] as number;
    this.push(
      'char',
      this.source.slice(start, this.at),
      (value << 24) >> 24,
      null,
      start,
      this.at - start,
    );
  }

  private readString(): void {
    const start = this.at;
    this.at++;
    const bytes: number[] = [];
    for (;;) {
      const char = this.source[this.at];
      if (this.at >= this.end || char === '\n') {
        fail(
          'c_unclosed_string',
          'This string is never closed.',
          start,
          'Add the closing " on the same line.',
        );
      }
      if (char === '"') break;
      bytes.push(...this.readEscaped());
    }
    this.at++;
    this.push('string', this.source.slice(start, this.at), 0, bytes, start, this.at - start);
  }

  private readPunctuator(): void {
    const found = PUNCTUATORS.find(
      (text) => this.source.startsWith(text, this.at) && this.at + text.length <= this.end,
    );
    if (!found) {
      fail(
        'c_bad_character',
        `"${this.source[this.at]}" is not part of C here.`,
        this.at,
        'Remove it, or put it inside a string.',
      );
    }
    this.push('punct', found, 0, null, this.at, found.length);
    this.at += found.length;
  }
}

/** Tokens for source[start..end). Offsets stay relative to the whole file, for error markers. */
export function tokenizeC(
  source: string,
  start: number,
  end: number,
  macros: MacroTable,
): CToken[] {
  return new Tokenizer(source, start, end, macros).run();
}
