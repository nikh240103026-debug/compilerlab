import { buildLexer, parseLexSpec, traceTokenize } from '@compilerlab/engine';
import { describe, expect, it } from 'vitest';
import { segmentsFor } from './token-stream';

const lexer = buildLexer(parseLexSpec('ID [a-z]+ %identifier\nWS [ ]+ %skip'));

describe('segmentsFor', () => {
  it('always covers the whole source, at every step of the scan', () => {
    for (const source of ['ab cd', 'ab @@ cd', '@', '', '  ', 'a\nb']) {
      const { input, tokens, errors, trace } = traceTokenize(lexer, source);
      for (const { state } of trace) {
        const segments = segmentsFor(input, tokens, errors, state);
        expect(segments.map((segment) => segment.text).join('')).toBe(source);
      }
    }
  });

  it('marks the lexeme being read', () => {
    const { input, tokens, errors, trace } = traceTokenize(lexer, 'ab cd');
    const reading = trace.find((step) => step.state.action === 'read')?.state;
    const segments = segmentsFor(input, tokens, errors, reading as never);
    expect(segments[0]).toMatchObject({ text: 'a', kind: 'lexeme' });
  });

  it('colors finished tokens by their category', () => {
    const { input, tokens, errors, trace } = traceTokenize(lexer, 'ab cd');
    const done = trace.at(-1)?.state;
    const segments = segmentsFor(input, tokens, errors, done as never);
    expect(segments[0]).toMatchObject({
      text: 'ab',
      kind: 'token',
      color: 'var(--token-identifier)',
    });
    expect(segments[1]).toMatchObject({ text: ' ', kind: 'skipped' });
  });

  it('marks errors', () => {
    const { input, tokens, errors, trace } = traceTokenize(lexer, '@a');
    const done = trace.at(-1)?.state;
    expect(segmentsFor(input, tokens, errors, done as never)[0]).toMatchObject({
      text: '@',
      kind: 'error',
    });
  });
});
