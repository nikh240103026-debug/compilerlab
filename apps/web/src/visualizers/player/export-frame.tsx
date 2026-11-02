import type { ReactNode } from 'react';

const HEADER_HEIGHT = 96;
const CAPTION_CHARS_PER_PIXEL = 1 / 7;
const MIN_WIDTH = 520;

export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${(kept[maxLines - 1] as string).slice(0, maxChars - 1)}…`;
  return kept;
}

/**
 * A complete, standalone image of one step: its title, its explanation, then the drawing.
 * The size is fixed for a whole trace so a GIF's frames all line up.
 */
export function ExportFrame({
  title,
  explanation,
  step,
  total,
  width,
  height,
  children,
}: {
  title: string;
  explanation: string;
  step: number;
  total: number;
  /** The size of the drawing, not counting the header. */
  width: number;
  height: number;
  children: ReactNode;
}) {
  const fullWidth = Math.max(width, MIN_WIDTH);
  const lines = wrapText(explanation, Math.floor((fullWidth - 32) * CAPTION_CHARS_PER_PIXEL), 3);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={fullWidth}
      height={height + HEADER_HEIGHT}
      viewBox={`0 0 ${fullWidth} ${height + HEADER_HEIGHT}`}
    >
      <rect width="100%" height="100%" fill="var(--surface)" />
      <text x={16} y={26} fontSize={15} fontWeight={600} fill="var(--ink)" fontFamily="sans-serif">
        {title}
      </text>
      <text
        x={fullWidth - 16}
        y={26}
        textAnchor="end"
        fontSize={12}
        fill="var(--ink-muted)"
        fontFamily="monospace"
      >
        {step + 1} / {total}
      </text>
      {lines.map((line, index) => (
        <text
          key={index}
          x={16}
          y={48 + index * 16}
          fontSize={12}
          fill="var(--ink-muted)"
          fontFamily="sans-serif"
        >
          {line}
        </text>
      ))}
      <g transform={`translate(${(fullWidth - width) / 2} ${HEADER_HEIGHT})`}>{children}</g>
    </svg>
  );
}

export interface SvgTableProps {
  rows: readonly (readonly string[])[];
  /** Highlights one cell, as [row, column], counting the header as row 0. */
  active?: readonly [number, number] | null;
  x?: number;
  y?: number;
}

const ROW_HEIGHT = 24;
const CHAR_WIDTH = 7.4;
const CELL_PADDING = 16;

export function measureTable(rows: readonly (readonly string[])[]) {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => (row[column]?.length ?? 0) * CHAR_WIDTH + CELL_PADDING)),
  );
  return {
    widths,
    width: widths.reduce((sum, width) => sum + width, 0),
    height: rows.length * ROW_HEIGHT,
  };
}

/** A table drawn in SVG, for exported frames. On screen the same data is a real HTML table. */
export function SvgTable({ rows, active, x = 0, y = 0 }: SvgTableProps) {
  const { widths } = measureTable(rows);
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="monospace" fontSize={12}>
      {rows.map((row, rowIndex) => {
        let cellX = 0;
        return row.map((cell, column) => {
          const cellWidth = widths[column] as number;
          const isActive = active?.[0] === rowIndex && active[1] === column;
          const shape = (
            <g
              key={`${rowIndex}-${column}`}
              transform={`translate(${cellX} ${rowIndex * ROW_HEIGHT})`}
            >
              <rect
                width={cellWidth}
                height={ROW_HEIGHT}
                fill={
                  isActive ? 'var(--accent-soft)' : rowIndex === 0 ? 'var(--surface-2)' : 'none'
                }
                stroke="var(--line)"
              />
              <text
                x={cellWidth / 2}
                y={ROW_HEIGHT / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--ink)"
              >
                {cell}
              </text>
            </g>
          );
          cellX += cellWidth;
          return shape;
        });
      })}
    </g>
  );
}
