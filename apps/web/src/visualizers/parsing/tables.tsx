import type { GrammarSetRow } from '@compilerlab/engine';
import { cn } from '@/lib/cn';
import { measureTable } from '../player/export-frame';

export type CellTone = 'active' | 'conflict' | 'added' | 'muted' | null;

const HTML_TONE: Record<Exclude<CellTone, null>, string> = {
  active: 'bg-accent-soft font-semibold text-accent',
  conflict: 'bg-(--diff-remove) font-semibold text-(--diff-remove-ink)',
  added: 'bg-(--diff-add) text-(--diff-add-ink)',
  muted: 'text-ink-muted',
};

const SVG_FILL: Record<Exclude<CellTone, null>, string> = {
  active: 'var(--accent-soft)',
  conflict: 'var(--diff-remove)',
  added: 'var(--diff-add)',
  muted: 'none',
};

const SVG_INK: Record<Exclude<CellTone, null>, string> = {
  active: 'var(--accent)',
  conflict: 'var(--diff-remove-ink)',
  added: 'var(--diff-add-ink)',
  muted: 'var(--ink-muted)',
};

/** A table of strings whose first column is a row header. Each cell can carry a tone. */
export function ParsingTable({
  caption,
  headers,
  rows,
  tone,
  onRowClick,
}: {
  caption: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  /** Row and column count data rows and all columns, starting at 0. */
  tone?: (row: number, column: number) => CellTone;
  onRowClick?: (row: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[0.8125rem]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                className="border border-line bg-surface-2 px-2 py-1 text-left font-medium"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => {
                const cellTone = tone?.(rowIndex, column) ?? null;
                const className = cn(
                  'border border-line px-2 py-1 whitespace-pre-line',
                  cellTone && HTML_TONE[cellTone],
                );
                if (column === 0) {
                  return (
                    <th key={column} scope="row" className={cn(className, 'text-left font-medium')}>
                      {onRowClick ? (
                        <button
                          type="button"
                          className="underline decoration-dotted underline-offset-2"
                          onClick={() => onRowClick(rowIndex)}
                        >
                          {cell}
                        </button>
                      ) : (
                        cell
                      )}
                    </th>
                  );
                }
                return (
                  <td key={column} className={className}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ROW_HEIGHT = 24;
const flatten = (rows: readonly (readonly string[])[]) =>
  rows.map((row) => row.map((cell) => cell.replace(/\n/g, ' / ')));

export function measureParsingTable(rows: readonly (readonly string[])[]) {
  return measureTable(flatten(rows));
}

/** The same table for exported frames. `rows` includes the header as row 0 here. */
export function ParsingSvgTable({
  rows,
  tone,
  x = 0,
  y = 0,
}: {
  rows: readonly (readonly string[])[];
  /** Row counts data rows only, so it means the same as on screen. */
  tone?: (row: number, column: number) => CellTone;
  x?: number;
  y?: number;
}) {
  const flat = flatten(rows);
  const { widths } = measureTable(flat);
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="monospace" fontSize={12}>
      {flat.map((row, rowIndex) => {
        let cellX = 0;
        return row.map((cell, column) => {
          const width = widths[column] as number;
          const cellTone = rowIndex === 0 ? null : (tone?.(rowIndex - 1, column) ?? null);
          const shape = (
            <g
              key={`${rowIndex}-${column}`}
              transform={`translate(${cellX} ${rowIndex * ROW_HEIGHT})`}
            >
              <rect
                width={width}
                height={ROW_HEIGHT}
                fill={cellTone ? SVG_FILL[cellTone] : rowIndex === 0 ? 'var(--surface-2)' : 'none'}
                stroke="var(--line)"
              />
              <text
                x={width / 2}
                y={ROW_HEIGHT / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontWeight={cellTone === 'active' || cellTone === 'conflict' ? 600 : 400}
                fill={cellTone ? SVG_INK[cellTone] : 'var(--ink)'}
              >
                {cell}
              </text>
            </g>
          );
          cellX += width;
          return shape;
        });
      })}
    </g>
  );
}

export function setRows(
  nullable: readonly string[],
  first: readonly GrammarSetRow[],
  follow: readonly GrammarSetRow[],
): string[][] {
  return first.map((row, index) => [
    row.symbol,
    nullable.includes(row.symbol) ? 'yes' : 'no',
    row.items.join(', '),
    (follow[index] as GrammarSetRow).items.join(', '),
  ]);
}

export const SET_HEADERS = ['Symbol', 'Nullable', 'FIRST', 'FOLLOW'] as const;
