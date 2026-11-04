import { EngineError } from '../core/result';

// A tiny scanner shared by the small C-like languages in this folder and in ../ir. It is not
// exported from the package: each language keeps its own parser and its own error codes.

export interface ScanToken {
  kind: 'name' | 'number' | 'char' | 'op' | 'eof';
  text: string;
  /** The value of a number or character constant. */
  value: number;
  start: number;
  end: number;
}

export interface ScanOptions {
  /** Every operator and punctuator. The longest match wins, whatever the order here. */
  operators: readonly string[];
  /** Starts every error code, so 'tc' gives tc_bad_character. */
  codePrefix: string;
  /** The language's name, for messages. */
  language: string;
  maxLength: number;
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[0-9]+(?:\.[0-9]+)?/y;
const CHAR_ESCAPES: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, '0': 0 };

function matchAt(pattern: RegExp, source: string, at: number): string {
  pattern.lastIndex = at;
  return (pattern.exec(source) as RegExpExecArray)[0];
}

export function scanSource(source: string, options: ScanOptions): ScanToken[] {
  const { codePrefix, language } = options;
  if (source.length > options.maxLength) {
    throw new EngineError({
      code: `${codePrefix}_too_long`,
      message: `This ${language} text is longer than ${options.maxLength} characters.`,
      hint: 'Try a shorter one. Every step of the run is kept so that you can replay it.',
    });
  }
  const operators = options.operators.toSorted((a, b) => b.length - a.length);
  const tokens: ScanToken[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (source.startsWith('//', at)) {
      const newline = source.indexOf('\n', at);
      at = newline === -1 ? source.length : newline;
    } else if (source.startsWith('/*', at)) {
      const close = source.indexOf('*/', at + 2);
      if (close === -1) {
        throw new EngineError({
          code: `${codePrefix}_unclosed_comment`,
          message: 'This comment is never closed.',
          hint: 'Add */ where the comment ends.',
          position: at,
          length: 2,
        });
      }
      at = close + 2;
    } else if (/[A-Za-z_]/.test(char)) {
      const text = matchAt(NAME, source, at);
      tokens.push({ kind: 'name', text, value: 0, start: at, end: at + text.length });
      at += text.length;
    } else if (/[0-9]/.test(char)) {
      const text = matchAt(NUMBER, source, at);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new EngineError({
          code: `${codePrefix}_bad_number`,
          message: `${text.slice(0, 20)}... is too large to be a number here.`,
          hint: 'Use a smaller number.',
          position: at,
          length: text.length,
        });
      }
      tokens.push({ kind: 'number', text, value, start: at, end: at + text.length });
      at += text.length;
    } else if (char === "'") {
      const escaped = source[at + 1] === '\\';
      const close = at + (escaped ? 3 : 2);
      const inner = source[at + (escaped ? 2 : 1)];
      if (inner === undefined || inner === '\n' || source[close] !== "'") {
        throw new EngineError({
          code: `${codePrefix}_bad_char`,
          message: 'A character constant holds exactly one character.',
          hint: "Write it like this: 'a'",
          position: at,
          length: 1,
        });
      }
      const value = escaped ? (CHAR_ESCAPES[inner] ?? inner.charCodeAt(0)) : inner.charCodeAt(0);
      tokens.push({
        kind: 'char',
        text: source.slice(at, close + 1),
        value,
        start: at,
        end: close + 1,
      });
      at = close + 1;
    } else {
      const operator = operators.find((text) => source.startsWith(text, at));
      if (!operator) {
        throw new EngineError({
          code: `${codePrefix}_bad_character`,
          message: `"${String.fromCodePoint(source.codePointAt(at) as number)}" is not part of ${language}.`,
          hint: 'Remove it, or check for a typo.',
          position: at,
          length: 1,
        });
      }
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
  tokens.push({ kind: 'eof', text: '', value: 0, start: source.length, end: source.length });
  return tokens;
}
