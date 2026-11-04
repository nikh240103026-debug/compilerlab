import { EngineError, type EngineErrorInfo } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { vmAssemble, type VmInstr, type VmProgram } from './assembler';
import {
  VM_REGISTER_NAMES,
  vmExecuteOne,
  vmInitialState,
  vmRuntimeError,
  type VmCallFrame,
  type VmOptions,
  type VmState,
} from './machine';

export const VM_DEFAULT_MAX_STEPS = 2_000_000;
export const VM_DEFAULT_TRACE_STEPS = 5_000;
/** A snapshot shows this many cells from the top of the stack, so it stays a fixed size. */
export const VM_SNAPSHOT_STACK_CELLS = 96;
/** A snapshot shows this many cells of each named array, for the same reason. */
export const VM_SNAPSHOT_DATA_CELLS = 64;

export interface VmSnapshot {
  step: number;
  /** The instruction just run. Null for the starting snapshot. */
  instruction: string | null;
  /** Its 1-based line in the assembly source. */
  line: number | null;
  /** Its index. */
  executedPc: number | null;
  /** The instruction that runs next. */
  pc: number;
  registers: Record<string, number>;
  changedRegisters: string[];
  /** Live stack cells, from the top of the stack up. */
  stack: { address: number; value: number }[];
  /** True when the stack holds more cells than this snapshot shows. */
  stackClipped: boolean;
  /** Named memory, with current values. */
  data: { name: string; address: number; values: number[] }[];
  writes: { address: number; value: number }[];
  callStack: VmCallFrame[];
  /** How many lines of the result's output exist at this step. */
  outputCount: number;
  halted: boolean;
}

export interface VmRunOptions extends VmOptions {
  /** A program still running after this many steps is stopped, in case it never ends. */
  maxSteps?: number;
  /** How many steps to record for the player. The run itself carries on past this. */
  maxTraceSteps?: number;
}

export interface VmRunResult {
  program: VmProgram;
  output: string[];
  steps: number;
  halted: boolean;
  registers: Record<string, number>;
  /** Null when the run ended normally. */
  error: EngineErrorInfo | null;
  /** The instruction that failed. Null when the run ended normally. */
  errorPc: number | null;
  trace: Trace<VmSnapshot>;
  traceTruncated: boolean;
}

export function vmSnapshot(
  program: VmProgram,
  state: VmState,
  executed: { pc: number; instr: VmInstr | undefined } | null,
  previousRegisters: Readonly<Record<string, number>> | null,
  writes: VmSnapshot['writes'],
): VmSnapshot {
  const sp = state.registers.SP as number;
  const top = state.memory.length;
  const stack: VmSnapshot['stack'] = [];
  for (let address = sp; address < top && stack.length < VM_SNAPSHOT_STACK_CELLS; address++) {
    stack.push({ address, value: state.memory[address] as number });
  }
  return {
    step: state.steps,
    instruction: executed?.instr?.text ?? null,
    line: executed?.instr?.line ?? null,
    executedPc: executed?.pc ?? null,
    pc: state.pc,
    registers: { ...state.registers },
    changedRegisters: previousRegisters
      ? VM_REGISTER_NAMES.filter((name) => previousRegisters[name] !== state.registers[name])
      : [],
    stack,
    stackClipped: top - sp > VM_SNAPSHOT_STACK_CELLS,
    data: Object.entries(program.symbols).map(([name, symbol]) => ({
      name,
      address: symbol.address,
      values: state.memory.slice(
        symbol.address,
        symbol.address + Math.min(symbol.size, VM_SNAPSHOT_DATA_CELLS),
      ),
    })),
    writes,
    callStack: state.callStack.map((frame) => ({ ...frame })),
    outputCount: state.output.length,
    halted: state.halted,
  };
}

/**
 * Runs one instruction without changing the state passed in, for a player that steps on demand.
 * Throws EngineError on a runtime error.
 */
export function vmStep(
  program: VmProgram,
  state: VmState,
): { state: VmState; snapshot: VmSnapshot } {
  const next: VmState = {
    ...state,
    registers: { ...state.registers },
    memory: state.memory.slice(),
    output: state.output.slice(),
    callStack: state.callStack.map((frame) => ({ ...frame })),
  };
  if (next.halted) {
    return { state: next, snapshot: vmSnapshot(program, next, null, next.registers, []) };
  }
  const pc = next.pc;
  const effect = vmExecuteOne(program, next);
  return {
    state: next,
    snapshot: vmSnapshot(
      program,
      next,
      { pc, instr: program.instrs[pc] },
      state.registers,
      effect.writes,
    ),
  };
}

/**
 * Runs until the program stops, records a trace, and never throws for a runtime error: the
 * error comes back in the result along with the trace so far, so a student can watch the run up
 * to the failure. Assembly errors do throw, because then nothing can run at all.
 */
export function vmExecute(input: string | VmProgram, options: VmRunOptions = {}): VmRunResult {
  const program = typeof input === 'string' ? vmAssemble(input) : input;
  const maxSteps = options.maxSteps ?? VM_DEFAULT_MAX_STEPS;
  const maxTraceSteps = Math.min(options.maxTraceSteps ?? VM_DEFAULT_TRACE_STEPS, 19_000);
  const state = vmInitialState(program, options);
  const recorder = new TraceRecorder<VmSnapshot>(maxTraceSteps + 2);

  recorder.add(
    'Start',
    'The registers are clear, the stack is empty, and the next instruction is the first one.',
    vmSnapshot(program, state, null, null, []),
  );

  let error: EngineErrorInfo | null = null;
  let errorPc: number | null = null;
  let recorded = 0;
  let traceTruncated = false;

  try {
    while (!state.halted) {
      if (state.steps >= maxSteps) {
        throw vmRuntimeError(
          program,
          state.pc,
          'vm_step_limit',
          `The program was stopped after ${maxSteps.toLocaleString('en')} steps, because it may be stuck in an endless loop.`,
          'Check that every loop has a condition that eventually becomes false.',
        );
      }
      const pc = state.pc;
      const instr = program.instrs[pc];
      const tracing = recorded < maxTraceSteps;
      const previous = tracing ? { ...state.registers } : null;
      errorPc = pc;
      const effect = vmExecuteOne(program, state);
      errorPc = null;
      if (tracing) {
        recorded++;
        recorder.add(
          instr ? instr.text : 'End of program',
          effect.explanation,
          vmSnapshot(program, state, { pc, instr }, previous, effect.writes),
        );
      } else {
        traceTruncated = true;
      }
    }
  } catch (caught) {
    if (!(caught instanceof EngineError)) throw caught;
    error = caught.info;
    errorPc = errorPc ?? state.pc;
    if (!traceTruncated) {
      recorder.add(
        'Stopped by an error',
        caught.info.message,
        vmSnapshot(program, state, null, null, []),
      );
    }
  }

  return {
    program,
    output: state.output,
    steps: state.steps,
    halted: state.halted,
    registers: { ...state.registers },
    error,
    errorPc,
    trace: recorder.finish(),
    traceTruncated,
  };
}

/** The same as vmExecute, but a runtime error throws. */
export function vmRun(input: string | VmProgram, options: VmRunOptions = {}): VmRunResult {
  const result = vmExecute(input, options);
  if (result.error) throw new EngineError(result.error);
  return result;
}
