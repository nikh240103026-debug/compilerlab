export type CharRange = readonly [low: number, high: number];

/** A set of Unicode code points: sorted, non-overlapping, non-adjacent ranges. */
export type CharSet = readonly CharRange[];

export const MAX_CODE_POINT = 0x10ffff;
const NEWLINE = 0x0a;

export function charSet(ranges: readonly CharRange[]): CharSet {
  const sorted = ranges.filter(([low, high]) => low <= high).toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

export function singleChar(codePoint: number): CharSet {
  return [[codePoint, codePoint]];
}

export function negateSet(set: CharSet): CharSet {
  const result: CharRange[] = [];
  let next = 0;
  for (const [low, high] of set) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= MAX_CODE_POINT) result.push([next, MAX_CODE_POINT]);
  return result;
}

export function unionSets(...sets: readonly CharSet[]): CharSet {
  return charSet(sets.flat());
}

export function setContains(set: CharSet, codePoint: number): boolean {
  let low = 0;
  let high = set.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = set[middle] as CharRange;
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

export function setSize(set: CharSet): number {
  return set.reduce((total, [low, high]) => total + high - low + 1, 0);
}

const NAMED_CHARS: Readonly<Record<number, string>> = {
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x20: '␠',
};

export function formatChar(codePoint: number): string {
  const named = NAMED_CHARS[codePoint];
  if (named) return named;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  }
  if (codePoint > 0xffff) return `\\u{${codePoint.toString(16)}}`;
  return String.fromCodePoint(codePoint);
}

function formatRanges(set: CharSet): string {
  return set
    .map(([low, high]) => {
      if (low === high) return formatChar(low);
      if (high === low + 1) return formatChar(low) + formatChar(high);
      return `${formatChar(low)}-${formatChar(high)}`;
    })
    .join('');
}

/** A short label for an automaton edge: a, [a-z], [^0-9], ., or "any". */
export function formatCharSet(set: CharSet): string {
  if (set.length === 0) return '∅';
  const size = setSize(set);
  if (size === MAX_CODE_POINT + 1) return 'any';
  if (size === MAX_CODE_POINT && !setContains(set, NEWLINE)) return '.';
  if (size > (MAX_CODE_POINT + 1) / 2) return `[^${formatRanges(negateSet(set))}]`;
  if (size === 1) return formatChar((set[0] as CharRange)[0]);
  return `[${formatRanges(set)}]`;
}

const PREFERRED_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ _-+*/=<>()';

/** A readable member of the set, used when showing a counterexample string. */
export function representativeChar(set: CharSet): number {
  for (const char of PREFERRED_CHARS) {
    const codePoint = char.codePointAt(0) as number;
    if (setContains(set, codePoint)) return codePoint;
  }
  for (const [low, high] of set) {
    const printable = Math.max(low, 0x21);
    if (printable <= high) return printable;
  }
  return (set[0] as CharRange)[0];
}

function setKey(set: CharSet): string {
  return set.map(([low, high]) => `${low}-${high}`).join(',');
}

/**
 * Splits the characters mentioned in `sets` into groups the automaton cannot tell apart, so
 * subset construction runs per group rather than once for each of 1.1 million code points.
 * Returned in order of their lowest character, which gives "a" before "b" as textbooks do.
 */
export function alphabetAtoms(sets: readonly CharSet[]): CharSet[] {
  const unique = [...new Map(sets.map((set) => [setKey(set), set])).values()];
  const cuts = new Set<number>();
  for (const set of unique) {
    for (const [low, high] of set) {
      cuts.add(low);
      cuts.add(high + 1);
    }
  }
  const points = [...cuts].toSorted((a, b) => a - b);
  const groups = new Map<string, [number, number][]>();
  for (let i = 0; i < points.length - 1; i++) {
    const low = points[i] as number;
    const signature = unique.flatMap((set, index) => (setContains(set, low) ? [index] : []));
    if (signature.length === 0) continue;
    const key = signature.join(',');
    const ranges = groups.get(key) ?? [];
    ranges.push([low, (points[i + 1] as number) - 1]);
    groups.set(key, ranges);
  }
  return [...groups.values()]
    .map((ranges) => charSet(ranges))
    .toSorted((a, b) => (a[0] as CharRange)[0] - (b[0] as CharRange)[0]);
}

/** The index of the atom holding this character, or -1 if the automaton never mentions it. */
export function atomIndexOf(atoms: readonly CharSet[], codePoint: number): number {
  return atoms.findIndex((atom) => setContains(atom, codePoint));
}
