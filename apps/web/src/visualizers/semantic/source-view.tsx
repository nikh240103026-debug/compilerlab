/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be focusable. */
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';

// Source text with the part being worked on highlighted, and listings of code that grow as a
// translation runs. Each has an HTML form for the page and an SVG form for exported frames.

export interface TextSpan {
  start: number;
  end: number;
}

interface SourcePiece {
  text: string;
  active: boolean;
  error: boolean;
}

/** Cuts the source at every highlight's ends, so each piece has one look. */
function sourcePieces(
  source: string,
  span: TextSpan | null,
  errors: readonly TextSpan[],
): SourcePiece[] {
  const clamp = (at: number) => Math.min(Math.max(0, at), source.length);
  const cuts = new Set([0, source.length]);
  for (const part of span ? [span, ...errors] : errors) {
    cuts.add(clamp(part.start));
    cuts.add(clamp(part.end));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const pieces: SourcePiece[] = [];
  sorted.forEach((from, index) => {
    const to = sorted[index + 1];
    if (to === undefined || to === from) return;
    const inside = ({ start, end }: TextSpan) => from >= start && to <= end;
    pieces.push({
      text: source.slice(from, to),
      active: span !== null && inside(span),
      error: errors.some(inside),
    });
  });
  return pieces;
}

/** The program, with the current node highlighted and errors so far underlined. */
export function SourceView({
  source,
  span,
  errors = [],
  label = 'Source',
}: {
  source: string;
  span: TextSpan | null;
  errors?: readonly TextSpan[];
  label?: string;
}) {
  const box = useRef<HTMLPreElement>(null);
  const pieces = useMemo(() => sourcePieces(source, span, errors), [source, span, errors]);

  // Keeps the highlight in view by scrolling only this box, never the page.
  useEffect(() => {
    const element = box.current;
    const mark = element?.querySelector('[data-active]');
    if (!element || !mark) return;
    const top = mark.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (top < 0 || top > element.clientHeight - 24) {
      element.scrollTop += top - element.clientHeight / 2;
    }
  }, [span?.start, span?.end]);

  return (
    <pre
      ref={box}
      tabIndex={0}
      role="group"
      aria-label={label}
      data-scroll-region=""
      className="relative max-h-56 min-w-0 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-[0.8125rem] leading-relaxed whitespace-pre"
    >
      {pieces.map((piece, index) => (
        <span
          key={index}
          data-active={piece.active ? '' : undefined}
          className={cn(
            piece.active && 'rounded-sm bg-accent-soft font-semibold text-accent',
            piece.error && 'underline decoration-danger decoration-wavy',
          )}
        >
          {piece.text}
        </span>
      ))}
    </pre>
  );
}

const SVG_LINE = 18;
const SVG_CHAR = 7.9;

export function svgSourceSize(source: string, maxLines: number) {
  const lines = source.split('\n');
  const longest = Math.max(0, ...lines.map((line) => line.length));
  return { width: longest * SVG_CHAR + 8, height: Math.min(lines.length, maxLines) * SVG_LINE + 6 };
}

/** The same view for exports. A long program shows the lines around the highlight. */
export function SvgSource({
  source,
  span,
  errors = [],
  maxLines,
  x = 0,
  y = 0,
}: {
  source: string;
  span: TextSpan | null;
  errors?: readonly TextSpan[];
  maxLines: number;
  x?: number;
  y?: number;
}) {
  const lines: SourcePiece[][] = [[]];
  let activeLine = -1;
  for (const piece of sourcePieces(source, span, errors)) {
    piece.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (!part) return;
      lines.at(-1)?.push({ ...piece, text: part });
      if (piece.active && activeLine === -1) activeLine = lines.length - 1;
    });
  }
  const first = Math.max(
    0,
    Math.min(activeLine - Math.floor(maxLines / 2), lines.length - maxLines),
  );
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="monospace" fontSize={13}>
      {lines.slice(first, first + maxLines).map((line, lineIndex) => (
        <text key={lineIndex} y={14 + lineIndex * SVG_LINE} xmlSpace="preserve">
          {line.map((piece, index) => (
            <tspan
              key={index}
              fill={piece.active ? 'var(--accent)' : piece.error ? 'var(--danger)' : 'var(--ink)'}
              fontWeight={piece.active ? 700 : 400}
              textDecoration={piece.error ? 'underline' : undefined}
            >
              {piece.text}
            </tspan>
          ))}
        </text>
      ))}
    </g>
  );
}

export type CodeTone = 'new' | 'active' | 'muted' | 'danger' | null;

export interface CodeLine {
  /** What goes in the margin, like an instruction number. */
  margin?: string;
  text: string;
  tone?: CodeTone;
}

/** Code that grows as a translation runs. New lines are green, as additions are everywhere else. */
export function CodeList({
  lines,
  label,
  empty = 'No code yet.',
  className,
}: {
  lines: readonly CodeLine[];
  label: string;
  empty?: string;
  className?: string;
}) {
  const box = useRef<HTMLOListElement>(null);
  const toneKey = lines.map((line) => line.tone ?? '').join();

  useEffect(() => {
    const element = box.current;
    const mark = element?.querySelector('[data-marked]');
    if (!element || !mark) return;
    const top = mark.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (top < 0 || top > element.clientHeight - 24) {
      element.scrollTop += top - element.clientHeight / 2;
    }
  }, [toneKey]);

  if (lines.length === 0) return <p className="text-xs text-ink-muted">{empty}</p>;
  return (
    <ol
      ref={box}
      tabIndex={0}
      aria-label={label}
      data-scroll-region=""
      className={cn(
        'max-h-72 min-w-0 overflow-auto rounded-sm bg-surface-2 p-1 font-mono text-[0.8125rem] leading-relaxed whitespace-pre',
        className,
      )}
    >
      {lines.map((line, index) => (
        <li
          key={index}
          data-marked={line.tone === 'new' || line.tone === 'active' ? '' : undefined}
          className={cn(
            'rounded-sm px-1',
            line.tone === 'new' && 'bg-(--diff-add) text-(--diff-add-ink)',
            line.tone === 'active' && 'bg-accent-soft font-semibold text-accent',
            line.tone === 'muted' && 'text-ink-muted',
            line.tone === 'danger' && 'bg-(--diff-remove) text-(--diff-remove-ink)',
          )}
        >
          {line.margin !== undefined ? (
            <span className="mr-2 inline-block min-w-[2ch] text-right text-ink-muted select-none">
              {line.margin}
            </span>
          ) : null}
          {line.text}
        </li>
      ))}
    </ol>
  );
}

const CODE_LINE = 20;
const CODE_CHAR = 7.4;

export function svgCodeSize(lines: readonly CodeLine[]) {
  const margin = Math.max(0, ...lines.map((line) => line.margin?.length ?? 0));
  const longest = Math.max(0, ...lines.map((line) => line.text.length));
  return {
    width: (longest + (margin > 0 ? margin + 2 : 0)) * CODE_CHAR + 12,
    height: lines.length * CODE_LINE + 4,
  };
}

const CODE_FILL: Record<Exclude<CodeTone, null>, string> = {
  new: 'var(--diff-add)',
  active: 'var(--accent-soft)',
  muted: 'none',
  danger: 'var(--diff-remove)',
};

const CODE_INK: Record<Exclude<CodeTone, null>, string> = {
  new: 'var(--diff-add-ink)',
  active: 'var(--accent)',
  muted: 'var(--ink-muted)',
  danger: 'var(--diff-remove-ink)',
};

/** Listings for exports. `width` makes a highlighted line's band as wide as the whole column. */
export function SvgCodeList({
  lines,
  width,
  x = 0,
  y = 0,
}: {
  lines: readonly CodeLine[];
  width: number;
  x?: number;
  y?: number;
}) {
  const margin = Math.max(0, ...lines.map((line) => line.margin?.length ?? 0));
  const textX = 6 + (margin > 0 ? (margin + 2) * CODE_CHAR : 0);
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="monospace" fontSize={12}>
      {lines.map((line, index) => (
        <g key={index} transform={`translate(0 ${index * CODE_LINE})`}>
          {line.tone && line.tone !== 'muted' ? (
            <rect width={width} height={CODE_LINE} rx={3} fill={CODE_FILL[line.tone]} />
          ) : null}
          {line.margin !== undefined ? (
            <text
              x={6 + margin * CODE_CHAR}
              y={CODE_LINE / 2}
              textAnchor="end"
              dominantBaseline="central"
              fill="var(--ink-muted)"
            >
              {line.margin}
            </text>
          ) : null}
          <text
            x={textX}
            y={CODE_LINE / 2}
            dominantBaseline="central"
            xmlSpace="preserve"
            fontWeight={line.tone === 'active' ? 600 : 400}
            fill={line.tone ? CODE_INK[line.tone] : 'var(--ink)'}
          >
            {line.text}
          </text>
        </g>
      ))}
    </g>
  );
}

export interface SvgNote {
  text: string;
  fill?: string;
  bold?: boolean;
}

export const SVG_NOTE_HEIGHT = 18;

/** Plain lines of text in an export, such as the rule a step used. */
export function SvgNotes({
  notes,
  x = 0,
  y = 0,
}: {
  notes: readonly SvgNote[];
  x?: number;
  y?: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="monospace" fontSize={12}>
      {notes.map((note, index) => (
        <text
          key={index}
          y={13 + index * SVG_NOTE_HEIGHT}
          xmlSpace="preserve"
          fontWeight={note.bold ? 600 : 400}
          fill={note.fill ?? 'var(--ink)'}
        >
          {note.text}
        </text>
      ))}
    </g>
  );
}

/** How wide a list of notes will be, given monospace text at the size SvgNotes uses. */
export function svgNotesWidth(notes: readonly SvgNote[]): number {
  return Math.max(0, ...notes.map((note) => note.text.length)) * CODE_CHAR + 8;
}

/** Cuts a long value for a small space. The step's caption always has the whole thing. */
export function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
