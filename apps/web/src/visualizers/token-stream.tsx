import {
  TOKEN_CATEGORIES,
  type LexError,
  type ScanState,
  type Token,
  type TokenCategory,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useId, useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import type { JobOutput } from './engine/jobs';
import { Player } from './player/player';
import { JobResult, type VisualizerProps } from './shared';

const DEFAULT_RULES = String.raw`# NAME   pattern          tags
IF       if               %keyword
ELSE     else             %keyword
WHILE    while            %keyword
ID       [a-zA-Z_][a-zA-Z0-9_]*  %identifier
NUM      [0-9]+(\.[0-9]+)?       %literal
RELOP    <=|>=|==|!=|<|>  %operator
ASSIGN   =                %operator
ARITH    [-+*/]           %operator
PUNCT    [(){};]          %punctuation
COMMENT  //[^\n]*         %comment %skip
WS       [ \t\n]+         %skip`;

const DEFAULT_SOURCE = `if (count >= 10) {
  total = total + 2.5; // add a bonus
}`;

const inputClass =
  'w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-[0.8125rem] leading-snug text-ink';

function tokenColor(category: TokenCategory | undefined): string {
  return category && (TOKEN_CATEGORIES as readonly string[]).includes(category)
    ? `var(--token-${category})`
    : 'var(--ink)';
}

export type SegmentKind = 'token' | 'skipped' | 'error' | 'lexeme' | 'pending';

export interface Segment {
  text: string;
  kind: SegmentKind;
  color: string;
}

/** Splits the source into colored runs for one step of the scan. */
export function segmentsFor(
  input: readonly string[],
  tokens: readonly Token[],
  errors: readonly LexError[],
  state: ScanState,
): Segment[] {
  const done = [
    ...tokens.slice(0, state.tokenCount).map((token) => ({
      start: token.start,
      end: token.end,
      kind: (token.skipped ? 'skipped' : 'token') as SegmentKind,
      color: token.skipped ? 'var(--token-comment)' : tokenColor(token.category),
    })),
    ...errors.slice(0, state.errorCount).map((error) => ({
      start: error.start,
      end: error.end,
      kind: 'error' as SegmentKind,
      color: 'var(--danger)',
    })),
  ].toSorted((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let at = 0;
  for (const piece of done) {
    // An error can grow past what this step's count shows, so clamp to the scan position.
    const end = Math.min(piece.end, Math.max(state.lexemeStart, piece.start + 1));
    if (end <= at) continue;
    segments.push({
      text: input.slice(piece.start, end).join(''),
      kind: piece.kind,
      color: piece.color,
    });
    at = end;
  }
  const lexemeEnd = Math.max(state.forward, state.lexemeStart);
  if (state.lexemeStart >= at && lexemeEnd > state.lexemeStart) {
    if (state.lexemeStart > at) {
      segments.push({
        text: input.slice(at, state.lexemeStart).join(''),
        kind: 'pending',
        color: 'var(--ink)',
      });
    }
    segments.push({
      text: input.slice(state.lexemeStart, lexemeEnd).join(''),
      kind: 'lexeme',
      color: 'var(--accent)',
    });
    at = lexemeEnd;
  }
  if (at < input.length) {
    segments.push({ text: input.slice(at).join(''), kind: 'pending', color: 'var(--ink-muted)' });
  }
  return segments;
}

function TokenChip({ token }: { token: Token }) {
  return (
    <li
      className="rounded-sm border px-1.5 py-0.5 font-mono text-xs"
      style={{ borderColor: tokenColor(token.category), color: tokenColor(token.category) }}
    >
      {token.type}
      <span className="text-ink"> {token.lexeme.replace(/\n/g, '\\n')}</span>
      <span className="ml-1 text-ink-muted">
        {token.line}:{token.column}
      </span>
    </li>
  );
}

const SVG_LINE_HEIGHT = 20;
const SVG_WIDTH = 640;
const SVG_MAX_LINES = 8;
const SVG_MAX_TOKENS = 8;

/** The step as a standalone drawing: the colored source, then the latest tokens. */
function TokenStageSvg({ output, state }: { output: JobOutput<'lexer'>; state: ScanState }) {
  const lines: Segment[][] = [[]];
  for (const segment of segmentsFor(output.input, output.tokens, output.errors, state)) {
    segment.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)?.push({ ...segment, text: part });
    });
  }
  const recent = output.tokens
    .slice(0, state.tokenCount)
    .filter((token) => !token.skipped)
    .slice(-SVG_MAX_TOKENS);
  return (
    <g fontFamily="monospace" fontSize={13}>
      {lines.slice(0, SVG_MAX_LINES).map((line, lineIndex) => (
        <text key={lineIndex} x={16} y={20 + lineIndex * SVG_LINE_HEIGHT} xmlSpace="preserve">
          {line.map((segment, index) => (
            <tspan
              key={index}
              fill={segment.color}
              fontWeight={segment.kind === 'lexeme' ? 700 : 400}
              textDecoration={segment.kind === 'error' ? 'underline' : undefined}
            >
              {segment.text}
            </tspan>
          ))}
        </text>
      ))}
      {recent.map((token, index) => (
        <text
          key={index}
          x={16 + (index % 2) * (SVG_WIDTH / 2)}
          y={20 + (SVG_MAX_LINES + Math.floor(index / 2)) * SVG_LINE_HEIGHT}
          fill={tokenColor(token.category)}
        >
          {`${token.type}: ${token.lexeme}`}
        </text>
      ))}
    </g>
  );
}

function Result({
  output,
  onUsed,
}: {
  output: JobOutput<'lexer'>;
  onUsed: (() => void) | undefined;
}) {
  const { input, tokens, errors, trace, rules, dfa } = output;

  const renderStage = useCallback(
    ({ state }: TraceStep<ScanState>) => {
      const segments = segmentsFor(input, tokens, errors, state);
      const visible = tokens.slice(0, state.tokenCount).filter((token) => !token.skipped);
      const shownErrors = errors.slice(0, state.errorCount);
      return (
        <div className="space-y-3">
          <pre className="max-h-56 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap">
            {segments.map((segment, index) => (
              <span
                key={index}
                style={{ color: segment.color }}
                className={
                  segment.kind === 'lexeme'
                    ? 'rounded-sm bg-accent-soft font-semibold'
                    : segment.kind === 'error'
                      ? 'underline decoration-wavy'
                      : ''
                }
              >
                {segment.text}
              </span>
            ))}
          </pre>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <div className="flex gap-1">
              <dt>DFA state:</dt>
              <dd className="font-mono text-ink">
                {state.dfaState === null ? '–' : dfa.names[state.dfaState]}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Longest match so far:</dt>
              <dd className="font-mono text-ink">
                {state.lastAccept
                  ? `${rules[state.lastAccept.rule]?.name} "${input.slice(state.lexemeStart, state.lastAccept.end).join('')}"`
                  : 'none'}
              </dd>
            </div>
          </dl>
          <div>
            <p className="mb-1 text-sm font-semibold">Token stream</p>
            {visible.length > 0 ? (
              <ol
                aria-label="Tokens so far"
                className="flex max-h-40 flex-wrap gap-1 overflow-y-auto"
              >
                {visible.map((token) => (
                  <TokenChip key={token.start} token={token} />
                ))}
              </ol>
            ) : (
              <p className="text-xs text-ink-muted">No tokens yet.</p>
            )}
          </div>
          {shownErrors.length > 0 ? (
            <ul aria-label="Lexical errors" className="space-y-0.5 text-xs text-danger">
              {shownErrors.map((error) => (
                <li key={error.start}>
                  Line {error.line}, column {error.column}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    },
    [input, tokens, errors, rules, dfa],
  );

  return (
    <Player
      trace={trace}
      name="token-stream"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: SVG_WIDTH,
        height: SVG_LINE_HEIGHT * (SVG_MAX_LINES + SVG_MAX_TOKENS / 2) + 24,
        render: ({ state }) => <TokenStageSvg output={output} state={state} />,
      }}
    />
  );
}

export default function TokenStream({ initial, onUsed }: VisualizerProps) {
  const [spec, setSpec] = useState(initial?.rules ?? DEFAULT_RULES);
  const [source, setSource] = useState(initial?.source ?? DEFAULT_SOURCE);
  const settledSpec = useDebouncedValue(spec, 400);
  const settledSource = useDebouncedValue(source, 400);
  const input = useMemo(
    () => ({ spec: settledSpec, source: settledSource }),
    [settledSpec, settledSource],
  );
  const { data } = useEngineJob('lexer', input);
  const rulesId = useId();
  const sourceId = useId();

  return (
    <div className="@container space-y-3">
      <div className="grid gap-3 @2xl:grid-cols-2">
        <div>
          <label htmlFor={rulesId} className="mb-1 block text-sm font-medium">
            Lexer rules
          </label>
          <textarea
            id={rulesId}
            rows={7}
            value={spec}
            spellCheck={false}
            className={inputClass}
            onChange={(event) => setSpec(event.target.value)}
          />
          <p className="mt-0.5 text-xs text-ink-muted">
            Earlier rules win ties. %skip drops a match. Tags like %keyword set its color.
          </p>
        </div>
        <div>
          <label htmlFor={sourceId} className="mb-1 block text-sm font-medium">
            Source code
          </label>
          <textarea
            id={sourceId}
            rows={7}
            value={source}
            spellCheck={false}
            className={inputClass}
            onChange={(event) => setSource(event.target.value)}
          />
        </div>
      </div>
      <JobResult result={data}>
        {(output) => (
          <>
            {output.warnings.length > 0 ? (
              <ul className="mb-3 space-y-1 rounded-md border border-warning p-2 text-sm">
                {output.warnings.map((warning) => (
                  <li key={warning.rule} className="flex gap-2">
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-warning"
                    />
                    {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <Result key={`${settledSpec}\n${settledSource}`} output={output} onUsed={onUsed} />
          </>
        )}
      </JobResult>
    </div>
  );
}
