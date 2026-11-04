import { EngineError } from '../core/result';

export const TINYC_MAX_SOURCE_LENGTH = 40_000;
export const TINYC_MAX_INT = 2_147_483_647;

export type TinyTokenKind = 'keyword' | 'name' | 'int' | 'operator' | 'punctuation' | 'eof';

export interface TinyToken {
  kind: TinyTokenKind;
  text: string;
  /** The value of an integer literal. */
  value: number | null;
  /** UTF-16 offset in the source. */
  position: number;
  length: number;
  line: number;
  column: number;
}

export const TINYC_KEYWORDS: readonly string[] = [
  'int',
  'bool',
  'void',
  'true',
  'false',
  'if',
  'else',
  'while',
  'return',
  'print',
];

// Longest first, so <= is one token rather than < followed by =.
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '='];
const PUNCTUATION = '(){}[],;';

function lexError(message: string, position: number, length: number, hint: string): never {
  throw new EngineError({ code: 'tinyc_lex_error', message, hint, position, length });
}

/** Stage 1: splits the source into tokens. Each has its position, line and column. */
export function tinycLex(source: string): TinyToken[] {
  if (source.length > TINYC_MAX_SOURCE_LENGTH) {
    throw new EngineError({
      code: 'tinyc_too_long',
      message: `This program is longer than ${TINYC_MAX_SOURCE_LENGTH} characters.`,
      hint: 'Try a shorter program.',
    });
  }

  const tokens: TinyToken[] = [];
  let at = 0;
  let line = 1;
  let lineStart = 0;

  const push = (kind: TinyTokenKind, text: string, value: number | null = null) => {
    tokens.push({
      kind,
      text,
      value,
      position: at,
      length: text.length,
      line,
      column: at - lineStart + 1,
    });
    at += text.length;
  };

  while (at < source.length) {
    const char = source[at] as string;

    if (char === '\n') {
      at++;
      line++;
      lineStart = at;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      at++;
    } else if (source.startsWith('//', at)) {
      while (at < source.length && source[at] !== '\n') at++;
    } else if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      if (end === -1) {
        lexError('This comment is never closed.', at, 2, 'End it with */');
      }
      for (let i = at; i < end; i++) {
        if (source[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
      }
      at = end + 2;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at, at + 256)) as RegExpExecArray;
      const text = match[0];
      if (text.length >= 256) {
        lexError('This name is too long.', at, text.length, 'Use a name under 256 characters.');
      }
      push(TINYC_KEYWORDS.includes(text) ? 'keyword' : 'name', text);
    } else if (/[0-9]/.test(char)) {
      const match = /^[0-9]+/.exec(source.slice(at, at + 64)) as RegExpExecArray;
      const text = match[0];
      const value = Number(text);
      if (value > TINYC_MAX_INT) {
        lexError(
          `${text} is too large. Integers go up to ${TINYC_MAX_INT}.`,
          at,
          text.length,
          'Use a smaller number.',
        );
      }
      const next = source[at + text.length];
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        lexError(
          `A number cannot run straight into a name, as in "${text}${next}".`,
          at,
          text.length + 1,
          'Put a space between them, or start names with a letter.',
        );
      }
      push('int', text, value);
    } else {
      const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at));
      if (operator) {
        push('operator', operator);
      } else if (PUNCTUATION.includes(char)) {
        push('punctuation', char);
      } else {
        const hint =
          char === '&' || char === '|'
            ? `TinyC has only ${char}${char}, the logical operator.`
            : 'TinyC uses names, whole numbers, operators and brackets.';
        lexError(`"${char}" is not part of TinyC.`, at, 1, hint);
      }
    }
  }

  tokens.push({
    kind: 'eof',
    text: '',
    value: null,
    position: source.length,
    length: 0,
    line,
    column: at - lineStart + 1,
  });
  return tokens;
}
