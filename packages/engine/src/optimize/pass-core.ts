import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr } from '../ir/types';

export const OPT_PASS_NAMES = [
  'constant-folding',
  'copy-propagation',
  'cse',
  'strength-reduction',
  'licm',
  'dce',
  'peephole',
] as const;

export type OptPassName = (typeof OPT_PASS_NAMES)[number];

export const OPT_PASS_LABELS: Readonly<Record<OptPassName, string>> = {
  'constant-folding': 'Constant folding and propagation',
  'copy-propagation': 'Copy propagation',
  cse: 'Common subexpression elimination',
  'strength-reduction': 'Strength reduction',
  licm: 'Loop-invariant code motion',
  dce: 'Dead code elimination',
  peephole: 'Peephole optimization',
};

export interface OptChange {
  kind: 'replace' | 'remove' | 'insert';
  /** Index in the program as it stood when this change happened. */
  line: number;
  before: string | null;
  after: string | null;
  reason: string;
}

export interface OptDiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  /** Line in the old program, or null for an added line. */
  beforeLine: number | null;
  /** Line in the new program, or null for a removed line. */
  afterLine: number | null;
}

export interface OptPassState {
  pass: OptPassName;
  /** The whole program at this step, one instruction per entry. */
  program: string[];
  /** null for the first and last steps, which change nothing. */
  change: OptChange | null;
}

export interface OptPassResult {
  pass: OptPassName;
  instrs: TacInstr[];
  before: string[];
  after: string[];
  changes: OptChange[];
  diff: OptDiffLine[];
  changed: boolean;
  trace: Trace<OptPassState>;
}

/** Line diff by longest common subsequence, after trimming lines that match at both ends. */
export function optDiffLines(before: readonly string[], after: readonly string[]): OptDiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const rows = endBefore - start;
  const columns = endAfter - start;
  const width = columns + 1;
  const table = new Uint16Array((rows + 1) * width);
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = columns - 1; c >= 0; c--) {
      table[r * width + c] =
        before[start + r] === after[start + c]
          ? (table[(r + 1) * width + c + 1] as number) + 1
          : Math.max(table[(r + 1) * width + c] as number, table[r * width + c + 1] as number);
    }
  }

  const lines: OptDiffLine[] = [];
  const same = (b: number, a: number) => {
    lines.push({ kind: 'same', text: before[b] as string, beforeLine: b, afterLine: a });
  };
  for (let i = 0; i < start; i++) same(i, i);
  let r = 0;
  let c = 0;
  while (r < rows || c < columns) {
    if (r < rows && c < columns && before[start + r] === after[start + c]) {
      same(start + r, start + c);
      r++;
      c++;
    } else if (
      c < columns &&
      (r === rows || (table[r * width + c + 1] as number) >= (table[(r + 1) * width + c] as number))
    ) {
      lines.push({
        kind: 'added',
        text: after[start + c] as string,
        beforeLine: null,
        afterLine: start + c,
      });
      c++;
    } else {
      lines.push({
        kind: 'removed',
        text: before[start + r] as string,
        beforeLine: start + r,
        afterLine: null,
      });
      r++;
    }
  }
  for (let i = 0; i < before.length - endBefore; i++) same(endBefore + i, endAfter + i);
  return lines;
}

/** Holds a pass's working copy of the code, and records every edit with the reason for it. */
export class OptPassRun {
  readonly before: string[];
  readonly changes: OptChange[] = [];
  private readonly recorder = new TraceRecorder<OptPassState>();

  constructor(
    readonly pass: OptPassName,
    public instrs: TacInstr[],
    introduction: string,
  ) {
    this.before = instrs.map(formatTac);
    this.recorder.add('Before', introduction, { pass, program: this.before, change: null });
  }

  private record(change: OptChange): void {
    this.changes.push(change);
    this.recorder.add(change.after ?? `Removed ${change.before ?? ''}`, change.reason, {
      pass: this.pass,
      program: this.instrs.map(formatTac),
      change,
    });
  }

  replace(index: number, instr: TacInstr, reason: string): void {
    const before = formatTac(this.instrs[index] as TacInstr);
    const after = formatTac(instr);
    this.instrs = this.instrs.with(index, instr);
    this.record({ kind: 'replace', line: index, before, after, reason });
  }

  remove(index: number, reason: string): void {
    const before = formatTac(this.instrs[index] as TacInstr);
    this.instrs = this.instrs.toSpliced(index, 1);
    this.record({ kind: 'remove', line: index, before, after: null, reason });
  }

  insert(index: number, instr: TacInstr, reason: string): void {
    this.instrs = this.instrs.toSpliced(index, 0, instr);
    this.record({ kind: 'insert', line: index, before: null, after: formatTac(instr), reason });
  }

  finish(summaryWhenNothingChanged: string): OptPassResult {
    const after = this.instrs.map(formatTac);
    const changed = this.changes.length > 0;
    this.recorder.add(
      'After',
      changed
        ? `This pass made ${this.changes.length} change${this.changes.length === 1 ? '' : 's'}.`
        : summaryWhenNothingChanged,
      { pass: this.pass, program: after, change: null },
    );
    return {
      pass: this.pass,
      instrs: this.instrs,
      before: this.before,
      after,
      changes: this.changes,
      diff: optDiffLines(this.before, after),
      changed,
      trace: this.recorder.finish(),
    };
  }
}
