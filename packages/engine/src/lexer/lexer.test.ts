import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/result';
import { MAX_BUFFERED_INPUT, SENTINEL, traceInputBuffer } from './input-buffer';
import { buildLexer, MAX_TRACED_INPUT, tokenize, traceTokenize, type LexRule } from './mini-lex';
import { parseLexSpec } from './spec';

const CODE_RULES: LexRule[] = [
  { name: 'IF', pattern: 'if', category: 'keyword' },
  { name: 'ELSE', pattern: 'else', category: 'keyword' },
  { name: 'ID', pattern: '[a-zA-Z_][a-zA-Z0-9_]*', category: 'identifier' },
  { name: 'NUM', pattern: '[0-9]+(\\.[0-9]+)?', category: 'literal' },
  { name: 'RELOP', pattern: '<=|>=|==|<|>', category: 'operator' },
  { name: 'ASSIGN', pattern: '=', category: 'operator' },
  { name: 'WS', pattern: '[ \\t\\n]+', skip: true },
];

const lexer = buildLexer(CODE_RULES);
const visible = (input: string, using = lexer) =>
  tokenize(using, input)
    .tokens.filter((token) => !token.skipped)
    .map((token) => `${token.type}:${token.lexeme}`);

describe('Dragon Book Example 3.26 and Fig. 3.51: a, abb, a*b+', () => {
  const book = buildLexer([
    { name: 'A1', pattern: 'a' },
    { name: 'A2', pattern: 'abb' },
    { name: 'A3', pattern: 'a*b+' },
  ]);

  it('takes the longest prefix on aaba (Example 3.28)', () => {
    expect(visible('aaba', book)).toEqual(['A3:aab', 'A1:a']);
  });

  it('prefers the earlier rule when two match the same length', () => {
    expect(visible('abb', book)).toEqual(['A2:abb']);
  });

  it('does not take the short match when a longer one exists', () => {
    expect(visible('a', book)).toEqual(['A1:a']);
    expect(visible('ab', book)).toEqual(['A3:ab']);
    expect(visible('abbb', book)).toEqual(['A3:abbb']);
  });
});

describe('tokenize', () => {
  it('applies longest match, so keywords do not split identifiers', () => {
    expect(visible('if iffy')).toEqual(['IF:if', 'ID:iffy']);
  });

  it('applies rule priority, so keywords beat identifiers on a tie', () => {
    expect(visible('else')).toEqual(['ELSE:else']);
  });

  it('prefers the longer operator', () => {
    expect(visible('<= < = ==')).toEqual(['RELOP:<=', 'RELOP:<', 'ASSIGN:=', 'RELOP:==']);
  });

  it('backs up past a partial match', () => {
    // 3. starts a decimal, but with no digit after the dot the match must back up to 3.
    const result = tokenize(lexer, '3.x');
    expect(result.tokens[0]).toMatchObject({ type: 'NUM', lexeme: '3', end: 1 });
    expect(result.errors[0]?.lexeme).toBe('.');
  });

  it('tracks lines and columns from 1', () => {
    const { tokens } = tokenize(lexer, 'if\n  x1 = 2\n');
    const located = tokens
      .filter((token) => !token.skipped)
      .map(({ lexeme, line, column }) => [lexeme, line, column]);
    expect(located).toEqual([
      ['if', 1, 1],
      ['x1', 2, 3],
      ['=', 2, 6],
      ['2', 2, 8],
    ]);
  });

  it('keeps skipped tokens in the list, marked, so nothing in the source is lost', () => {
    const { tokens } = tokenize(lexer, 'a b');
    expect(tokens.map((token) => token.skipped)).toEqual([false, true, false]);
    expect(tokens.map((token) => token.lexeme).join('')).toBe('a b');
  });

  it('carries each rule category', () => {
    expect(tokenize(lexer, 'if').tokens[0]?.category).toBe('keyword');
    expect(tokenize(lexer, ' ').tokens[0]?.category).toBeUndefined();
  });

  it('handles empty input', () => {
    expect(tokenize(lexer, '')).toEqual({ tokens: [], errors: [] });
  });

  describe('error recovery', () => {
    it('reports the position and carries on', () => {
      const { tokens, errors } = tokenize(lexer, 'x @ y');
      expect(errors).toEqual([
        { message: 'No rule matches "@".', lexeme: '@', start: 2, end: 3, line: 1, column: 3 },
      ]);
      expect(tokens.filter((t) => !t.skipped).map((t) => t.lexeme)).toEqual(['x', 'y']);
    });

    it('groups adjacent bad characters into one error', () => {
      const { errors } = tokenize(lexer, 'a @#$ b');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ lexeme: '@#$', start: 2, end: 5 });
      expect(errors[0]?.message).toBe('No rule matches "@#$".');
    });

    it('reports separate runs separately, on the right lines', () => {
      const { errors } = tokenize(lexer, '@\nx\n  #');
      expect(errors.map(({ line, column }) => [line, column])).toEqual([
        [1, 1],
        [3, 3],
      ]);
    });

    it('survives input with no valid characters at all', () => {
      const { tokens, errors } = tokenize(lexer, '@@@');
      expect(tokens).toEqual([]);
      expect(errors).toHaveLength(1);
    });

    it('treats a character outside the rules as an error', () => {
      expect(tokenize(lexer, '😀').errors[0]?.lexeme).toBe('😀');
    });
  });
});

describe('buildLexer', () => {
  const failure = (rules: LexRule[]) => {
    try {
      buildLexer(rules);
    } catch (error) {
      return (error as EngineError).info;
    }
    throw new Error('Expected buildLexer to fail');
  };

  it('needs at least one rule', () => {
    expect(failure([]).code).toBe('no_rules');
  });

  it('rejects duplicate names', () => {
    expect(
      failure([
        { name: 'A', pattern: 'a' },
        { name: 'A', pattern: 'b' },
      ]).code,
    ).toBe('duplicate_rule');
  });

  it('names the rule when a pattern is invalid', () => {
    const info = failure([{ name: 'BAD', pattern: '(a' }]);
    expect(info.code).toBe('bad_rule_pattern');
    expect(info.message).toContain('Rule BAD:');
    expect(info.hint).toBeTruthy();
  });

  it.each(['a*', 'a?', 'ε', '(a|ε)'])('refuses %s, which could loop forever', (pattern) => {
    const info = failure([{ name: 'LOOP', pattern }]);
    expect(info.code).toBe('rule_matches_empty');
    expect(info.hint).toContain('+');
  });

  it('warns about a rule that an earlier rule shadows completely', () => {
    const { warnings } = buildLexer([
      { name: 'ID', pattern: '[a-z]+' },
      { name: 'IF', pattern: 'if' },
    ]);
    expect(warnings).toEqual([
      {
        rule: 'IF',
        message: expect.stringContaining('the earlier rule ID') as unknown as string,
      },
    ]);
  });

  it('does not warn when the order is right', () => {
    expect(lexer.warnings).toEqual([]);
  });

  it('copes with a rule whose language is claimed by several others', () => {
    const { warnings } = buildLexer([
      { name: 'A', pattern: 'a' },
      { name: 'B', pattern: 'b' },
      { name: 'AB', pattern: 'a|b' },
    ]);
    expect(warnings.map((warning) => warning.rule)).toEqual(['AB']);
  });
});

describe('traceTokenize', () => {
  const traced = traceTokenize(lexer, 'if x1');

  it('produces the same result as the untraced scanner', () => {
    expect({ tokens: traced.tokens, errors: traced.errors }).toEqual(tokenize(lexer, 'if x1'));
  });

  it('walks through begin, read, stuck and emit, ending with done', () => {
    const actions = traced.trace.map((step) => step.state.action);
    expect(actions.slice(0, 5)).toEqual(['begin', 'read', 'read', 'stuck', 'emit']);
    expect(actions.at(-1)).toBe('done');
  });

  it('remembers the last accepting point while it reads on', () => {
    const steps = traceTokenize(lexer, 'if').trace;
    const accepted = steps.filter((step) => step.state.lastAccept);
    expect(accepted[0]?.title).toContain('ID');
    expect(accepted[1]?.title).toContain('IF');
  });

  it('counts tokens as they are emitted', () => {
    const counts = traced.trace.map((step) => step.state.tokenCount);
    expect(counts[0]).toBe(0);
    expect(counts.at(-1)).toBe(traced.tokens.length);
    expect(counts).toEqual(counts.toSorted((a, b) => a - b));
  });

  it('explains backing up when the scanner overshoots', () => {
    const emit = traceTokenize(lexer, '3.x').trace.find((step) => step.state.action === 'emit');
    expect(emit?.explanation).toContain('Back up 1 character');
    expect(emit?.state.forward).toBe(1);
  });

  it('explains skipping and errors', () => {
    const steps = traceTokenize(lexer, ' @').trace;
    expect(steps.find((step) => step.state.action === 'skip')?.explanation).toContain('skip');
    expect(steps.find((step) => step.state.action === 'error')?.explanation).toContain(
      'Panic-mode',
    );
  });

  it('refuses input too long to animate', () => {
    expect(() => traceTokenize(lexer, 'a'.repeat(MAX_TRACED_INPUT + 1))).toThrow(/longer than/);
  });

  it('counts code points, so offsets line up with what is drawn', () => {
    const result = traceTokenize(lexer, '😀a');
    expect(result.input).toEqual(['😀', 'a']);
    expect(result.tokens[0]).toMatchObject({ start: 1, end: 2, column: 2 });
  });
});

describe('property: the scanner', () => {
  const inputs = fc.string({ maxLength: 60 });

  it('accounts for every input character, as a token or an error', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const { tokens, errors } = tokenize(lexer, input);
        const pieces = [...tokens, ...errors].toSorted((a, b) => a.start - b.start);
        expect(pieces.map((piece) => piece.lexeme).join('')).toBe(input);
        let at = 0;
        for (const piece of pieces) {
          expect(piece.start).toBe(at);
          at = piece.end;
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('always matches the longest possible token', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', '1', ' '), { maxLength: 20 }), (chars) => {
        const input = chars.join('');
        const ids = tokenize(lexer, input).tokens.filter((token) => token.type === 'ID');
        for (const token of ids) {
          const next = [...input][token.end];
          if (next !== undefined) expect(next).toBe(' ');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('gives the same answer traced and untraced', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const { tokens, errors } = traceTokenize(lexer, input);
        expect({ tokens, errors }).toEqual(tokenize(lexer, input));
      }),
      { numRuns: 300 },
    );
  });
});

describe('parseLexSpec', () => {
  it('reads names, patterns and tags, and ignores comments', () => {
    const rules = parseLexSpec(`
      # a comment

      IF   if        %keyword
      WS   [ \\t]+    %skip
      NUM  [0-9]+    %literal %skip
    `);
    expect(rules).toEqual([
      { name: 'IF', pattern: 'if', category: 'keyword' },
      { name: 'WS', pattern: '[ \\t]+', skip: true },
      { name: 'NUM', pattern: '[0-9]+', skip: true, category: 'literal' },
    ]);
  });

  it('keeps spaces that belong to the pattern', () => {
    expect(parseLexSpec('X  a b')[0]?.pattern).toBe('a b');
  });

  it('accepts Windows line endings', () => {
    expect(parseLexSpec('A a\r\nB b\r\n')).toHaveLength(2);
  });

  it('returns nothing for empty text', () => {
    expect(parseLexSpec('\n\n# only a comment\n')).toEqual([]);
  });

  it.each([
    ['JUSTANAME', 'bad_rule_line', 'Line 1'],
    ['a\n9bad x', 'bad_rule_line', 'Line 1'],
    ['A a\n9bad x', 'bad_rule_name', 'Line 2'],
    ['A a %nope', 'bad_rule_tag', '%nope'],
  ])('reports %j clearly', (text, code, fragment) => {
    try {
      parseLexSpec(text);
      throw new Error('Expected parseLexSpec to fail');
    } catch (error) {
      const { info } = error as EngineError;
      expect(info.code).toBe(code);
      expect(info.message).toContain(fragment);
    }
  });

  it('builds a working lexer from text', () => {
    const fromText = buildLexer(parseLexSpec('NUM [0-9]+\nWS \\s+ %skip'));
    expect(visible('12 3', fromText)).toEqual(['NUM:12', 'NUM:3']);
  });
});

describe('traceInputBuffer (Dragon Book section 3.2)', () => {
  it('splits lexemes and reads every character', () => {
    const { lexemes, trace } = traceInputBuffer('if x1 = 42', 4);
    expect(lexemes).toEqual(['if', 'x1', '=', '42']);
    expect(trace.at(-1)?.state.charactersRead).toBe(10);
    expect(trace.at(-1)?.state.action).toBe('done');
  });

  it('puts a sentinel after each loaded chunk', () => {
    const { trace } = traceInputBuffer('abcdef', 4);
    expect(trace[0]?.state.buffers[0]).toEqual(['a', 'b', 'c', 'd', SENTINEL]);
    const reload = trace.find((step) => step.state.action === 'reload');
    expect(reload?.state.buffers[1]).toEqual(['e', 'f', SENTINEL]);
    expect(reload?.state.forward).toEqual({ buffer: 1, index: 0 });
  });

  it('lets a lexeme cross the boundary between buffers', () => {
    const { lexemes, trace } = traceInputBuffer('abcdefg h', 4);
    expect(lexemes).toEqual(['abcdefg', 'h']);
    const reload = trace.find((step) => step.state.action === 'reload');
    expect(reload?.state.lexemeBegin).toEqual({ buffer: 0, index: 0 });
    expect(reload?.state.lexeme).toBe('abcd');
  });

  it('wraps around to the first buffer again', () => {
    const { lexemes, trace } = traceInputBuffer('abcdefghijkl', 4);
    expect(lexemes).toEqual(['abcdefghijkl']);
    const buffersUsed = trace
      .filter((step) => step.state.action === 'reload')
      .map((step) => step.state.forward.buffer);
    // The input fills the second load exactly, so the last reload finds nothing left.
    expect(buffersUsed).toEqual([1, 0, 1]);
  });

  it('stops at a sentinel in the middle of a buffer, which means end of input', () => {
    const { trace } = traceInputBuffer('ab', 4);
    expect(trace.at(-1)?.explanation).toContain('input has ended');
  });

  it('reloads and finds only an eof when the input fills a buffer exactly', () => {
    const { trace, lexemes } = traceInputBuffer('abcd', 4);
    expect(lexemes).toEqual(['abcd']);
    const reload = trace.find((step) => step.state.action === 'reload');
    expect(reload?.explanation).toContain('no more characters');
    expect(reload?.state.buffers[1]).toEqual([SENTINEL]);
    expect(trace.at(-1)?.explanation).toContain('input has ended');
  });

  it('starts the next lexeme in the new buffer when no lexeme is in progress', () => {
    const { trace } = traceInputBuffer('abc defg', 4);
    const reload = trace.find((step) => step.state.action === 'reload');
    expect(reload?.state.lexemeBegin).toEqual({ buffer: 1, index: 0 });
    expect(reload?.explanation).not.toContain('boundary');
  });

  it('says so when a lexeme is too long and its start gets overwritten', () => {
    const { trace, lexemes } = traceInputBuffer('abcdefghij', 4);
    const reloads = trace.filter((step) => step.state.action === 'reload');
    expect(reloads[0]?.explanation).toContain('boundary');
    expect(reloads[1]?.explanation).toContain('overwrites the start');
    expect(lexemes).toEqual(['abcdefghij']);
  });

  it('handles empty input and input that is only whitespace', () => {
    expect(traceInputBuffer('', 4).lexemes).toEqual([]);
    expect(traceInputBuffer('   ', 4).lexemes).toEqual([]);
  });

  it('needs one sentinel test per character, plus one per reload and the end', () => {
    const { trace } = traceInputBuffer('abcdefgh', 4);
    const last = trace.at(-1)?.state;
    expect(last?.charactersRead).toBe(8);
    // Eight characters, a test at each of the two reloads, and one at the end.
    expect(last?.sentinelChecks).toBe(11);
  });

  it.each([3, 33])('rejects a buffer of size %i', (size) => {
    expect(() => traceInputBuffer('a', size)).toThrow(/between/);
  });

  it('rejects input too long for the demo', () => {
    expect(() => traceInputBuffer('a'.repeat(MAX_BUFFERED_INPUT + 1))).toThrow(/longer than/);
  });
});
