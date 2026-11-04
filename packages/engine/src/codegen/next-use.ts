import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr } from '../ir/types';
import { optIsTempName } from '../optimize/tac-text';
import { optDefOf, optOperandsOf, optToInstrs } from '../optimize/tac-util';

export const CODEGEN_MAX_BLOCK_STATEMENTS = 200;

export interface NextUseEntry {
  /** Can this name's value be read after this point? */
  live: boolean;
  /** Index of the next statement that reads it, or null if none does in this block. */
  nextUse: number | null;
}

export interface NextUseRow {
  index: number;
  text: string;
  /** Status after this statement, for the names it mentions. This is what the book attaches. */
  attached: { name: string; live: boolean; nextUse: number | null }[];
  /** Status after this statement, for every name in the block. */
  after: Record<string, NextUseEntry>;
}

export interface NextUseState {
  /** The statement being scanned. Null for the first step. */
  index: number | null;
  /** The symbol table as it stands after processing this statement. */
  table: Record<string, NextUseEntry>;
  /** What was attached to this statement before the table changed. */
  attached: NextUseRow['attached'];
}

export interface NextUseResult {
  statements: string[];
  liveOnExit: string[];
  rows: NextUseRow[];
  trace: Trace<NextUseState>;
}

/**
 * Pulls the statements out of a single basic block. A leading label is fine, and so is one jump at
 * the very end. Anything that shows this is really several blocks is an error.
 */
export function codegenBlockStatements(input: string | readonly TacInstr[]): {
  body: TacInstr[];
  jump: (TacInstr & { op: 'goto' | 'if' }) | null;
} {
  const instrs = optToInstrs(input);
  let start = 0;
  while (instrs[start]?.op === 'label') start++;
  const body = instrs.slice(start);
  const last = body.at(-1);
  const jump = last?.op === 'goto' || last?.op === 'if' ? last : null;
  if (jump) body.pop();
  for (const instr of body) {
    if (instr.op === 'label' || instr.op === 'goto' || instr.op === 'if' || instr.op === 'return') {
      throw new EngineError({
        code: 'not_one_block',
        message: `This needs one basic block, but "${formatTac(instr)}" splits the code into several.`,
        hint: 'Use straight-line statements, with at most one jump at the very end.',
      });
    }
  }
  if (body.length > CODEGEN_MAX_BLOCK_STATEMENTS) {
    throw new EngineError({
      code: 'block_too_long',
      message: `This block has more than ${CODEGEN_MAX_BLOCK_STATEMENTS} statements.`,
      hint: 'Try a shorter block.',
    });
  }
  return { body, jump };
}

function namesIn(instrs: readonly TacInstr[]): string[] {
  const names = new Set<string>();
  for (const instr of instrs) {
    const def = optDefOf(instr);
    if (def !== null) names.add(def);
    for (const operand of optOperandsOf(instr)) {
      if (operand.kind !== 'const') names.add(operand.name);
    }
  }
  return [...names];
}

/** The book's assumption: temporaries die with the block, and program variables stay live. */
export function codegenDefaultLiveOnExit(instrs: readonly TacInstr[]): string[] {
  return namesIn(instrs)
    .filter((name) => !optIsTempName(name))
    .toSorted();
}

const copyTable = (table: Record<string, NextUseEntry>) =>
  Object.fromEntries(Object.entries(table).map(([name, entry]) => [name, { ...entry }]));

const operandNames = (instr: TacInstr) =>
  optOperandsOf(instr).flatMap((operand) => (operand.kind === 'const' ? [] : [operand.name]));

/**
 * The book's backward scan. For statement i, x = y + z, going from the last statement to the first:
 * attach the current status of x, y and z to i; mark x not live with no next use; then mark y and z
 * live with next use i. The order matters when y or z is x.
 */
export function codegenNextUse(
  input: string | readonly TacInstr[],
  options: { liveOnExit?: readonly string[] } = {},
): NextUseResult {
  const { body, jump } = codegenBlockStatements(input);
  // A jump's condition is read at the very end, so it counts as a use like any other.
  const statements = jump ? [...body, jump] : body;
  const liveOnExit = [...(options.liveOnExit ?? codegenDefaultLiveOnExit(statements))];
  const names = namesIn(statements);
  const live = new Set(liveOnExit);

  const table: Record<string, NextUseEntry> = {};
  for (const name of new Set([...names, ...liveOnExit])) {
    table[name] = { live: live.has(name), nextUse: null };
  }

  const recorder = new TraceRecorder<NextUseState>();
  recorder.add(
    'At the end of the block',
    `Start from the last statement. Live on exit: ${liveOnExit.length > 0 ? liveOnExit.join(', ') : 'nothing'}. No name has a next use yet, because the block is over.`,
    { index: null, table: copyTable(table), attached: [] },
  );

  const rows: NextUseRow[] = new Array<NextUseRow>(statements.length);
  for (let index = statements.length - 1; index >= 0; index--) {
    const instr = statements[index] as TacInstr;
    const def = optDefOf(instr);
    const uses = operandNames(instr);
    const mentioned = [...new Set([...(def === null ? [] : [def]), ...uses])];

    const attached = mentioned.map((name) => ({ name, ...(table[name] as NextUseEntry) }));
    rows[index] = { index, text: formatTac(instr), attached, after: copyTable(table) };

    if (def !== null) table[def] = { live: false, nextUse: null };
    for (const name of uses) table[name] = { live: true, nextUse: index };

    const defNote =
      def === null
        ? ''
        : `${def} gets a new value here, so before this line its old value is not needed. `;
    const useNote =
      uses.length > 0
        ? `${[...new Set(uses)].join(' and ')} are read here, so they are live with next use at statement ${index + 1}. `
        : '';
    recorder.add(
      `Statement ${index + 1}: ${formatTac(instr)}`,
      `First attach the current status of the names on this line. ${defNote}${useNote}`,
      { index, table: copyTable(table), attached },
    );
  }

  return { statements: statements.map(formatTac), liveOnExit, rows, trace: recorder.finish() };
}
