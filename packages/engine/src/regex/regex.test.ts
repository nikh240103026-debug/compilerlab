import { describe, expect, it } from 'vitest';
import { attempt, EngineError } from '../core/result';
import {
  alphabetAtoms,
  atomIndexOf,
  charSet,
  formatChar,
  formatCharSet,
  MAX_CODE_POINT,
  negateSet,
  representativeChar,
  setContains,
  setSize,
  singleChar,
  unionSets,
} from './charset';
import { MAX_REGEX_LENGTH, parseRegex, type RegexNode } from './parser';

const cp = (char: string) => char.codePointAt(0) as number;

/** A compact, fully parenthesized form, so tests can check precedence directly. */
function show(node: RegexNode): string {
  switch (node.type) {
    case 'empty':
      return 'ε';
    case 'charset':
      return node.label;
    case 'union':
      return `(${show(node.left)}|${show(node.right)})`;
    case 'concat':
      return `(${show(node.left)}.${show(node.right)})`;
    case 'star':
      return `${show(node.child)}*`;
    case 'plus':
      return `${show(node.child)}+`;
    case 'optional':
      return `${show(node.child)}?`;
  }
}

function errorOf(source: string) {
  const result = attempt(() => parseRegex(source));
  if (result.ok) throw new Error(`Expected "${source}" to fail`);
  return result.error;
}

describe('charset', () => {
  it('normalizes overlapping and adjacent ranges', () => {
    expect(
      charSet([
        [5, 9],
        [1, 3],
        [4, 4],
        [20, 10],
      ]),
    ).toEqual([[1, 9]]);
  });

  it('negates, and negating twice gives the original', () => {
    const set = charSet([
      [0x61, 0x7a],
      [0x30, 0x39],
    ]);
    expect(setContains(negateSet(set), 0x41)).toBe(true);
    expect(setContains(negateSet(set), 0x61)).toBe(false);
    expect(negateSet(negateSet(set))).toEqual(set);
    expect(setSize(negateSet([]))).toBe(MAX_CODE_POINT + 1);
    expect(negateSet([[0, MAX_CODE_POINT]])).toEqual([]);
  });

  it('checks membership across several ranges', () => {
    const set = unionSets(singleChar(1), singleChar(5), singleChar(9));
    expect([0, 1, 4, 5, 9, 10].map((n) => setContains(set, n))).toEqual([
      false,
      true,
      false,
      true,
      true,
      false,
    ]);
  });

  it.each([
    [singleChar(cp('a')), 'a'],
    [singleChar(0x20), '␠'],
    [singleChar(0x0a), '\\n'],
    [[[cp('a'), cp('z')]] as const, '[a-z]'],
    [[[cp('a'), cp('b')]] as const, '[ab]'],
    [negateSet(singleChar(0x0a)), '.'],
    [negateSet(singleChar(cp('a'))), '[^a]'],
    [[[0, MAX_CODE_POINT]] as const, 'any'],
    [[] as const, '∅'],
  ])('labels %j as %s', (set, label) => {
    expect(formatCharSet(set)).toBe(label);
  });

  it('formats unusual characters so they can be seen', () => {
    expect(formatChar(0x07)).toBe('\\x07');
    expect(formatChar(0x1f600)).toBe('\\u{1f600}');
  });

  it('prefers readable characters when it needs an example', () => {
    expect(representativeChar(negateSet(singleChar(cp('a'))))).toBe(cp('b'));
    expect(representativeChar(singleChar(0x07))).toBe(0x07);
    expect(representativeChar(singleChar(cp('~')))).toBe(cp('~'));
  });

  describe('alphabetAtoms', () => {
    it('keeps separate symbols separate, in order', () => {
      expect(alphabetAtoms([singleChar(cp('b')), singleChar(cp('a'))]).map(formatCharSet)).toEqual([
        'a',
        'b',
      ]);
    });

    it('splits overlapping sets so each atom behaves as one', () => {
      const atoms = alphabetAtoms([[[cp('a'), cp('z')]], singleChar(cp('e'))]);
      expect(atoms.map(formatCharSet)).toEqual(['[a-df-z]', 'e']);
    });

    it('joins separated pieces that behave the same way', () => {
      const atoms = alphabetAtoms([negateSet(singleChar(cp('a'))), singleChar(cp('a'))]);
      expect(atoms).toHaveLength(2);
    });

    it('finds the atom for a character, or -1', () => {
      const atoms = alphabetAtoms([singleChar(cp('a'))]);
      expect(atomIndexOf(atoms, cp('a'))).toBe(0);
      expect(atomIndexOf(atoms, cp('z'))).toBe(-1);
    });

    it('handles an empty alphabet', () => {
      expect(alphabetAtoms([])).toEqual([]);
    });
  });
});

describe('parseRegex', () => {
  it.each([
    ['a', 'a'],
    ['ab', '(a.b)'],
    ['a|b', '(a|b)'],
    ['ab|c', '((a.b)|c)'],
    ['a|bc', '(a|(b.c))'],
    ['ab*', '(a.b*)'],
    ['(ab)*', '(a.b)*'],
    ['a|b*', '(a|b*)'],
    ['a+b?', '(a+.b?)'],
    ['a**', 'a**'],
    ['(a|b)*abb', '((((a|b)*.a).b).b)'],
    ['a|ε', '(a|ε)'],
    ['ε', 'ε'],
  ])('parses %s with the right precedence', (source, expected) => {
    expect(show(parseRegex(source))).toBe(expected);
  });

  it('is left associative', () => {
    expect(show(parseRegex('a|b|c'))).toBe('((a|b)|c)');
    expect(show(parseRegex('abc'))).toBe('((a.b).c)');
  });

  it.each([
    ['[a-c]', '[a-c]'],
    ['[abc]', '[a-c]'],
    ['[^a]', '[^a]'],
    ['[a-]', '[-a]'],
    ['[-a]', '[-a]'],
    ['[a\\]]', '[]a]'],
    ['.', '.'],
    ['\\n', '\\n'],
    ['\\t', '\\t'],
    ['\\.', '.'],
    ['\\*', '*'],
    ['\\q', 'q'],
    ['\\ε', 'ε'],
    ['[\\n]', '\\n'],
    ['\\d', '[0-9]'],
    ['[\\da]', '[0-9a]'],
  ])('reads the class or escape %s', (source, label) => {
    const node = parseRegex(source);
    expect(node.type).toBe('charset');
    expect(node.type === 'charset' && node.label).toBe(label);
  });

  it('supports the other class escapes', () => {
    const at = (source: string, char: string) => {
      const node = parseRegex(source);
      return node.type === 'charset' && setContains(node.set, cp(char));
    };
    expect(at('\\w', '_')).toBe(true);
    expect(at('\\W', '_')).toBe(false);
    expect(at('\\s', ' ')).toBe(true);
    expect(at('\\S', ' ')).toBe(false);
    expect(at('\\D', '5')).toBe(false);
  });

  it('treats operators as literal text inside quotation marks', () => {
    expect(show(parseRegex('"a|b"'))).toBe('((a.|).b)');
    expect(show(parseRegex('"a\\n"'))).toBe('(a.\\n)');
  });

  it('reads characters outside the basic plane as one symbol', () => {
    const node = parseRegex('😀');
    expect(node.type === 'charset' && node.set).toEqual(singleChar(0x1f600));
  });

  it('records where each part came from', () => {
    const node = parseRegex('(a|b)*c');
    expect(node.span).toEqual({ start: 0, end: 7 });
    expect(node.type === 'concat' && node.left.span).toEqual({ start: 0, end: 6 });
    expect(node.type === 'concat' && node.right.span).toEqual({ start: 6, end: 7 });
  });

  it.each([
    ['', 'empty_regex', 0],
    ['   ', 'empty_regex', 0],
    ['(a', 'unclosed_paren', 0],
    ['(', 'unclosed_paren', 0],
    ['a((', 'unclosed_paren', 2],
    ['a(b', 'unclosed_paren', 1],
    ['a)', 'unmatched_paren', 1],
    [')', 'unmatched_paren', 0],
    ['*a', 'nothing_to_repeat', 0],
    ['a|*', 'nothing_to_repeat', 2],
    ['(+a)', 'nothing_to_repeat', 1],
    ['a|', 'empty_alternative', 2],
    ['|a', 'empty_alternative', 0],
    ['()', 'empty_alternative', 1],
    ['[a', 'unclosed_class', 0],
    ['[', 'unclosed_class', 0],
    ['[]', 'empty_class', 0],
    ['[^]', 'empty_class', 0],
    ['[z-a]', 'reversed_range', 1],
    ['[a-\\d]', 'bad_class_range', 1],
    ['[a\\', 'unclosed_class', 2],
    ['a\\', 'trailing_backslash', 1],
    ['a{2}', 'unsupported_braces', 1],
    ['a]', 'unmatched_bracket', 1],
    ['"a', 'unclosed_quote', 0],
    ['""', 'empty_quote', 0],
  ])('rejects %j with a positioned error', (source, code, position) => {
    const error = errorOf(source);
    expect(error.code).toBe(code);
    expect(error.position).toBe(position);
    expect(error.message.length).toBeGreaterThan(10);
  });

  it('gives a hint for mistakes that have an obvious fix', () => {
    expect(errorOf('*a').hint).toContain('\\*');
    expect(errorOf('a|').hint).toContain('ε');
    expect(errorOf('a{2}').hint).toContain('aa');
  });

  it('refuses very long and very deep input instead of crashing', () => {
    expect(errorOf('a'.repeat(MAX_REGEX_LENGTH + 1)).code).toBe('regex_too_long');
    expect(errorOf(`${'('.repeat(100)}a${')'.repeat(100)}`).code).toBe('nesting_too_deep');
  });

  it('throws EngineError, not a raw error', () => {
    expect(() => parseRegex('(')).toThrow(EngineError);
  });
});
