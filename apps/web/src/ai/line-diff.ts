export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/** Past this, a diff would take too long, so the changed part is shown as replaced outright. */
const MAX_TABLE_CELLS = 4_000_000;

function longestCommonSubsequence(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = new Uint32Array(rows * columns);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i * columns + j] =
        before[i] === after[j]
          ? (lengths[(i + 1) * columns + j + 1] as number) + 1
          : Math.max(
              lengths[(i + 1) * columns + j] as number,
              lengths[i * columns + j + 1] as number,
            );
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'same', text: before[i] as string });
      i += 1;
      j += 1;
    } else if (
      (lengths[(i + 1) * columns + j] as number) >= (lengths[i * columns + j + 1] as number)
    ) {
      lines.push({ kind: 'remove', text: before[i] as string });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: after[j] as string });
      j += 1;
    }
  }
  for (; i < before.length; i += 1) lines.push({ kind: 'remove', text: before[i] as string });
  for (; j < after.length; j += 1) lines.push({ kind: 'add', text: after[j] as string });
  return lines;
}

/** A line-by-line diff. Matching lines at both ends are skipped first, which covers most edits. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle =
    middleA.length * middleB.length > MAX_TABLE_CELLS
      ? [
          ...middleA.map((text): DiffLine => ({ kind: 'remove', text })),
          ...middleB.map((text): DiffLine => ({ kind: 'add', text })),
        ]
      : longestCommonSubsequence(middleA, middleB);
  return [
    ...a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })),
    ...middle,
    ...a.slice(endA).map((text): DiffLine => ({ kind: 'same', text })),
  ];
}

export type DiffRow = DiffLine | { kind: 'gap'; count: number };

/** Keeps the changes and a few lines around each one, and collapses the rest. */
export function withContext(lines: readonly DiffLine[], around = 2): DiffRow[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let at = index - around; at <= index + around; at += 1) keep.add(at);
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped > 0) rows.push({ kind: 'gap', count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) rows.push({ kind: 'gap', count: skipped });
  return rows;
}

const crlfToLf = (text: string) => text.replace(/\r\n/g, '\n');

/**
 * Applies one suggested edit, or returns null if its text is no longer in the file. An empty `find`
 * creates a file, so it only applies when the file is empty.
 */
export function applyEdit(content: string, find: string, replace: string): string | null {
  const source = crlfToLf(content);
  const target = crlfToLf(find);
  if (target === '') return source === '' ? crlfToLf(replace) : null;
  const at = source.indexOf(target);
  if (at === -1) return null;
  return `${source.slice(0, at)}${crlfToLf(replace)}${source.slice(at + target.length)}`;
}
