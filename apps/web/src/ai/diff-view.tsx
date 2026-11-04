/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be focusable. */
import { useMemo } from 'react';
import { lineDiff, withContext, type DiffRow } from './line-diff';

const ROW_STYLE = {
  add: { background: 'var(--diff-add)', color: 'var(--diff-add-ink)' },
  remove: { background: 'var(--diff-remove)', color: 'var(--diff-remove-ink)' },
} as const;

const ROW_MARK = { add: '+', remove: '-', same: ' ' } as const;
const ROW_WORD = { add: 'Added: ', remove: 'Removed: ', same: '' } as const;

function Row({ row }: { row: DiffRow }) {
  if (row.kind === 'gap') {
    return (
      <div className="px-2 py-0.5 text-ink-muted">
        {row.count} unchanged line{row.count === 1 ? '' : 's'}
      </div>
    );
  }
  return (
    <div
      className="flex gap-2 px-2 whitespace-pre"
      style={row.kind === 'same' ? undefined : ROW_STYLE[row.kind]}
    >
      <span aria-hidden="true" className="select-none">
        {ROW_MARK[row.kind]}
      </span>
      <span>
        <span className="sr-only">{ROW_WORD[row.kind]}</span>
        {row.text || ' '}
      </span>
    </div>
  );
}

/** Green and red lines, with + and - as well, so the meaning never depends on color alone. */
export function DiffView({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const rows = useMemo(() => withContext(lineDiff(before, after)), [before, after]);
  return (
    <div
      role="group"
      aria-label={label}
      // Focusable, so keyboard users can scroll long lines sideways.
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-sm border border-line bg-surface py-1 font-mono text-xs leading-relaxed"
    >
      {rows.map((row, index) => (
        <Row key={index} row={row} />
      ))}
    </div>
  );
}
