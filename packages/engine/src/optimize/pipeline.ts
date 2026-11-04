import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr } from '../ir/types';
import { optConstantFolding } from './constant';
import { optCopyPropagation } from './copy';
import { optCommonSubexpressions } from './cse';
import { optDeadCode } from './dce';
import { optLoopInvariantMotion } from './licm';
import {
  OPT_PASS_LABELS,
  OPT_PASS_NAMES,
  optDiffLines,
  type OptDiffLine,
  type OptPassName,
  type OptPassResult,
} from './pass-core';
import { optPeephole } from './peephole';
import { optStrengthReduction } from './strength';
import { optDefaultLiveAtExit, optToInstrs } from './tac-util';

export const OPT_MAX_ROUNDS = 8;

export interface OptPipelineOptions {
  /** Passes to switch on or off. Anything not listed stays on. */
  toggles?: Partial<Record<OptPassName, boolean>>;
  /** Names read after this code ends. Defaults to every non-temporary name. */
  liveAtExit?: readonly string[];
  /** Upper limit on full rounds through the enabled passes. */
  maxRounds?: number;
}

export interface OptPipelineState {
  round: number;
  /** null for the first and last steps. */
  pass: OptPassName | null;
  program: string[];
  /** Index into the result's passResults for this step, so a UI can open its detail. */
  passResult: number | null;
  changeCount: number;
}

export interface OptPipelineResult {
  enabled: OptPassName[];
  before: string[];
  after: string[];
  instrs: TacInstr[];
  diff: OptDiffLine[];
  /** One entry per pass per round, in the order they ran. Each has its own trace. */
  passResults: (OptPassResult & { round: number })[];
  rounds: number;
  /** Instruction counts, as a simple measure of the combined effect. */
  sizeBefore: number;
  sizeAfter: number;
  trace: Trace<OptPipelineState>;
}

function runPass(
  pass: OptPassName,
  instrs: TacInstr[],
  liveAtExit: readonly string[],
): OptPassResult {
  switch (pass) {
    case 'constant-folding':
      return optConstantFolding(instrs);
    case 'copy-propagation':
      return optCopyPropagation(instrs);
    case 'cse':
      return optCommonSubexpressions(instrs);
    case 'strength-reduction':
      return optStrengthReduction(instrs);
    case 'licm':
      return optLoopInvariantMotion(instrs, { liveAtExit });
    case 'dce':
      return optDeadCode(instrs, { liveAtExit });
    case 'peephole':
      return optPeephole(instrs);
  }
}

/**
 * Runs the enabled passes in a sensible fixed order, repeating until a whole round changes
 * nothing. Passes feed each other: propagation exposes dead code, and CSE leaves copies behind.
 */
export function optRunPipeline(
  input: string | readonly TacInstr[],
  options: OptPipelineOptions = {},
): OptPipelineResult {
  const start = optToInstrs(input);
  const liveAtExit = options.liveAtExit ?? optDefaultLiveAtExit(start);
  const enabled = OPT_PASS_NAMES.filter((pass) => options.toggles?.[pass] !== false);
  const maxRounds = Math.min(options.maxRounds ?? OPT_MAX_ROUNDS, OPT_MAX_ROUNDS);
  const before = start.map(formatTac);
  const recorder = new TraceRecorder<OptPipelineState>();

  recorder.add(
    'Original code',
    enabled.length > 0
      ? `Enabled passes: ${enabled.map((pass) => OPT_PASS_LABELS[pass]).join(', ')}.`
      : 'Every pass is switched off, so the code stays as it is.',
    { round: 0, pass: null, program: before, passResult: null, changeCount: 0 },
  );

  const passResults: OptPipelineResult['passResults'] = [];
  let instrs = start;
  let rounds = 0;
  for (let round = 1; round <= maxRounds && enabled.length > 0; round++) {
    rounds = round;
    let changedInRound = false;
    for (const pass of enabled) {
      const result = runPass(pass, instrs, liveAtExit);
      passResults.push({ ...result, round });
      instrs = result.instrs;
      changedInRound ||= result.changed;
      recorder.add(
        `Round ${round}: ${OPT_PASS_LABELS[pass]}`,
        result.changed
          ? `Made ${result.changes.length} change${result.changes.length === 1 ? '' : 's'}.`
          : 'Nothing to do on this round.',
        {
          round,
          pass,
          program: result.after,
          passResult: passResults.length - 1,
          changeCount: result.changes.length,
        },
      );
    }
    if (!changedInRound) break;
  }

  const after = instrs.map(formatTac);
  recorder.add(
    'Final code',
    `Went from ${before.length} to ${after.length} instructions after ${rounds} round${rounds === 1 ? '' : 's'}.`,
    { round: rounds, pass: null, program: after, passResult: null, changeCount: 0 },
  );

  return {
    enabled,
    before,
    after,
    instrs,
    diff: optDiffLines(before, after),
    passResults,
    rounds,
    sizeBefore: before.length,
    sizeAfter: after.length,
    trace: recorder.finish(),
  };
}
