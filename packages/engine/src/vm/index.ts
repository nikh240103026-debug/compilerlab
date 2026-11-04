/**
 * The teaching VM: registers, a stack in memory, named data, and a call-stack view. It runs the
 * teaching ISA, which is defined in codegen/isa.ts and listed in ISA_REFERENCE.
 *
 * Memory is one array of 32-bit integer cells. Named data starts at address 0, and the stack starts
 * at the top and grows down. A name mentioned without a .data line gets one cell automatically.
 *
 * ASSEMBLE. Errors are EngineErrors that name the line and carry a source position.
 *
 *   const program = vmAssemble(`
 *     .data x = 5
 *     LD R1, x
 *     ADD R1, R1, #2
 *     PRINT R1
 *     HALT`);
 *
 * RUN WITH A TRACE. Each trace step's state is a VmSnapshot: { step, instruction, line, executedPc,
 * pc, registers, changedRegisters, stack, stackClipped, data, writes, callStack, outputCount,
 * halted }. Use outputCount to show result.output.slice(0, outputCount).
 *
 *   const result = vmExecute(source, { maxSteps: 100_000, variables: { a: 3 } });
 *   // { program, output, steps, halted, registers, error, errorPc, trace, traceTruncated }
 *
 * vmExecute returns a runtime error in `error`, along with the trace up to that point. vmRun is the
 * same but throws. A program that runs past maxSteps stops with the code vm_step_limit.
 *
 * STEP ON DEMAND. Pure: the state you pass in is not changed.
 *
 *   let state = vmInitialState(program);
 *   ({ state, snapshot } = vmStep(program, state));
 *
 * A stack-machine sketch:   PUSH #2 / PUSH #3 / ADD / PRINT / HALT    prints 5.
 * A register sketch:        LD R1, #2 / ADD R1, R1, #3 / PRINT R1 / HALT    prints 5.
 */
export { vmEvalBinary, vmEvalUnary } from './arith';
export {
  VM_MAX_ASM_LINES,
  VM_MAX_DATA_CELLS,
  vmAssemble,
  vmIsRegisterName,
  type VmDataSymbol,
  type VmInstr,
  type VmOperand,
  type VmProgram,
} from './assembler';
export {
  VM_DEFAULT_MEMORY,
  VM_MAX_MEMORY,
  VM_MIN_MEMORY,
  VM_REGISTER_NAMES,
  vmInitialState,
  type VmCallFrame,
  type VmOptions,
  type VmState,
} from './machine';
export {
  VM_DEFAULT_MAX_STEPS,
  VM_DEFAULT_TRACE_STEPS,
  VM_SNAPSHOT_DATA_CELLS,
  VM_SNAPSHOT_STACK_CELLS,
  vmExecute,
  vmRun,
  vmSnapshot,
  vmStep,
  type VmRunOptions,
  type VmRunResult,
  type VmSnapshot,
} from './run';
