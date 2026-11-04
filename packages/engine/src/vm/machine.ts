import { ISA_OPERATORS, ISA_REGISTER_COUNT, type IsaBinaryOpcode } from '../codegen/isa';
import { EngineError } from '../core/result';
import { vmEvalBinary, vmEvalUnary } from './arith';
import type { VmInstr, VmOperand, VmProgram } from './assembler';

export const VM_DEFAULT_MEMORY = 4096;
export const VM_MIN_MEMORY = 64;
export const VM_MAX_MEMORY = 65_536;

export const VM_REGISTER_NAMES: readonly string[] = [
  ...Array.from({ length: ISA_REGISTER_COUNT }, (_, index) => `R${index}`),
  'SP',
  'FP',
];

export interface VmCallFrame {
  /** Label of the function that was called. */
  function: string;
  /** Instruction index to come back to. */
  returnTo: number;
  /** Stack pointer just after the return address was pushed. */
  sp: number;
}

/** The whole machine, as plain data. */
export interface VmState {
  pc: number;
  registers: Record<string, number>;
  memory: number[];
  output: string[];
  callStack: VmCallFrame[];
  halted: boolean;
  steps: number;
}

export interface VmOptions {
  memorySize?: number;
  /** Starting values for named memory, by name. */
  variables?: Readonly<Record<string, number>>;
}

/** What one instruction did, separate from the machine state, so a trace can show it. */
export interface VmEffect {
  explanation: string;
  writes: { address: number; value: number }[];
}

export function vmRuntimeError(
  program: VmProgram,
  pc: number,
  code: string,
  message: string,
  hint: string,
): EngineError {
  const instr = program.instrs[pc];
  return new EngineError({
    code,
    message: instr ? `Line ${instr.line} (${instr.text}): ${message}` : message,
    hint,
    ...(instr ? { position: instr.offset, length: instr.length } : {}),
  });
}

export function vmInitialState(program: VmProgram, options: VmOptions = {}): VmState {
  const memorySize = options.memorySize ?? VM_DEFAULT_MEMORY;
  if (!Number.isInteger(memorySize) || memorySize < VM_MIN_MEMORY || memorySize > VM_MAX_MEMORY) {
    throw new EngineError({
      code: 'vm_bad_memory_size',
      message: `Memory must be between ${VM_MIN_MEMORY} and ${VM_MAX_MEMORY} cells.`,
      hint: `Try ${VM_DEFAULT_MEMORY}.`,
    });
  }
  if (program.dataEnd >= memorySize) {
    throw new EngineError({
      code: 'vm_bad_memory_size',
      message: `This program's named data needs ${program.dataEnd} cells, which leaves no room for the stack in ${memorySize} cells.`,
      hint: 'Use more memory, or declare less data.',
    });
  }

  const memory = new Array<number>(memorySize).fill(0);
  for (const symbol of Object.values(program.symbols)) {
    symbol.initial.forEach((value, index) => {
      memory[symbol.address + index] = value;
    });
  }
  for (const [name, value] of Object.entries(options.variables ?? {})) {
    const symbol = program.symbols[name];
    if (!symbol) {
      throw new EngineError({
        code: 'vm_unknown_variable',
        message: `This program never mentions a variable named ${name}, so it cannot be given a starting value.`,
        hint: 'Check the spelling of the name.',
      });
    }
    memory[symbol.address] = value | 0;
  }

  const registers: Record<string, number> = {};
  for (const name of VM_REGISTER_NAMES) registers[name] = 0;
  // The stack starts at the top of memory and grows down, toward the named data.
  registers.SP = memorySize;
  registers.FP = memorySize;
  return { pc: 0, registers, memory, output: [], callStack: [], halted: false, steps: 0 };
}

/** Everything one step needs. Mutates the state it is given, so long runs avoid copying. */
class Executor {
  readonly writes: VmEffect['writes'] = [];

  constructor(
    private readonly program: VmProgram,
    private readonly state: VmState,
    private readonly pc: number,
  ) {}

  fail(code: string, message: string, hint: string): never {
    throw vmRuntimeError(this.program, this.pc, code, message, hint);
  }

  register(name: string): number {
    return this.state.registers[name] as number;
  }

  setRegister(name: string, value: number): void {
    this.state.registers[name] = value;
  }

  private checkAddress(address: number): void {
    if (address < 0 || address >= this.state.memory.length) {
      this.fail(
        'vm_bad_address',
        `Address ${address} is outside memory, which runs from 0 to ${this.state.memory.length - 1}.`,
        'Check the value of the register used to form this address.',
      );
    }
  }

  read(address: number): number {
    this.checkAddress(address);
    return this.state.memory[address] as number;
  }

  write(address: number, value: number): void {
    this.checkAddress(address);
    this.state.memory[address] = value;
    this.writes.push({ address, value });
  }

  addressOf(operand: VmOperand & { kind: 'mem' }): number {
    const direct = operand.address + (operand.base ? this.register(operand.base) : 0);
    return operand.indirect ? this.read(direct) : direct;
  }

  value(operand: VmOperand): number {
    switch (operand.kind) {
      case 'reg':
        return this.register(operand.name);
      case 'imm':
        return operand.value;
      case 'mem':
        return this.read(this.addressOf(operand));
      case 'label':
        return operand.target;
    }
  }

  assign(operand: VmOperand, value: number): void {
    if (operand.kind === 'reg') this.setRegister(operand.name, value);
    else if (operand.kind === 'mem') this.write(this.addressOf(operand), value);
  }

  push(value: number): void {
    const next = this.register('SP') - 1;
    if (next < this.program.dataEnd) {
      this.fail(
        'vm_stack_overflow',
        'The stack has grown into the named data, so the program has run out of memory.',
        'Very deep or endless recursion usually causes this. Check the base case.',
      );
    }
    this.setRegister('SP', next);
    this.write(next, value);
  }

  pop(): number {
    const sp = this.register('SP');
    if (sp >= this.state.memory.length) {
      this.fail(
        'vm_stack_underflow',
        'The program popped a value from an empty stack.',
        'Every POP needs an earlier PUSH on the same path.',
      );
    }
    this.setRegister('SP', sp + 1);
    return this.state.memory[sp] as number;
  }
}

const describe = (operand: VmOperand | undefined): string => {
  if (!operand) return '';
  switch (operand.kind) {
    case 'reg':
      return operand.name;
    case 'imm':
      return String(operand.value);
    case 'label':
      return operand.name;
    case 'mem': {
      if (operand.symbol && !operand.base) return operand.symbol;
      const place = operand.symbol ?? (operand.address === 0 ? '' : String(operand.address));
      return `${operand.indirect ? '*' : ''}${place}(${operand.base})`;
    }
  }
};

function runBinary(exec: Executor, instr: VmInstr): string {
  const opcode = instr.opcode as IsaBinaryOpcode;
  const operator = ISA_OPERATORS[opcode];
  const [dest, source, source2] = instr.operands;
  const stackForm = !dest;
  const right = stackForm ? exec.pop() : exec.value(source2 as VmOperand);
  const left = stackForm ? exec.pop() : exec.value(source as VmOperand);
  const result = vmEvalBinary(operator, left, right);
  if (result === null) {
    exec.fail(
      'vm_division_by_zero',
      `This divides ${left} by zero.`,
      'Check the divisor before dividing.',
    );
  }
  if (stackForm) {
    exec.push(result);
    return `Pop ${right} and ${left}, then push ${left} ${operator} ${right} = ${result}.`;
  }
  exec.assign(dest, result);
  return `${describe(dest)} = ${left} ${operator} ${right} = ${result}.`;
}

function branch(state: VmState, instr: VmInstr, taken: boolean, value: number): string {
  const target = instr.operands.at(-1) as VmOperand & { kind: 'label' };
  if (taken) state.pc = target.target;
  return `The tested value is ${value}, so ${taken ? `jump to ${target.name}` : 'carry on to the next line'}.`;
}

/** Runs the instruction at pc. Throws EngineError on a runtime error, with pc still on it. */
export function vmExecuteOne(program: VmProgram, state: VmState): VmEffect {
  const pc = state.pc;
  const instr = program.instrs[pc];
  if (!instr) {
    state.halted = true;
    return { explanation: 'Control ran off the end of the program, so it stops.', writes: [] };
  }
  const exec = new Executor(program, state, pc);
  const [first, second] = instr.operands;
  state.pc = pc + 1;
  let explanation: string;

  switch (instr.opcode) {
    case 'LD': {
      const value = exec.value(second as VmOperand);
      exec.assign(first as VmOperand, value);
      explanation = `Load ${value} from ${describe(second)} into ${describe(first)}.`;
      break;
    }
    case 'ST': {
      const value = exec.value(second as VmOperand);
      exec.assign(first as VmOperand, value);
      explanation = `Store ${value} from ${describe(second)} into ${describe(first)}.`;
      break;
    }
    case 'LEA': {
      const address = exec.addressOf(second as VmOperand & { kind: 'mem' });
      exec.assign(first as VmOperand, address);
      explanation = `${describe(first)} = the address of ${describe(second)}, which is ${address}.`;
      break;
    }
    case 'NEG':
    case 'NOT': {
      const operator = instr.opcode === 'NEG' ? '-' : '!';
      if (first) {
        const value = exec.value(second as VmOperand);
        const result = vmEvalUnary(operator, value);
        exec.assign(first, result);
        explanation = `${describe(first)} = ${operator}${value} = ${result}.`;
      } else {
        const value = exec.pop();
        const result = vmEvalUnary(operator, value);
        exec.push(result);
        explanation = `Pop ${value}, then push ${operator}${value} = ${result}.`;
      }
      break;
    }
    case 'BR':
      explanation = branch(state, instr, true, 1);
      break;
    case 'BEQZ':
    case 'BNEZ':
    case 'BLTZ':
    case 'BLEZ':
    case 'BGTZ':
    case 'BGEZ': {
      const value = instr.operands.length === 1 ? exec.pop() : exec.value(first as VmOperand);
      const taken =
        instr.opcode === 'BEQZ'
          ? value === 0
          : instr.opcode === 'BNEZ'
            ? value !== 0
            : instr.opcode === 'BLTZ'
              ? value < 0
              : instr.opcode === 'BLEZ'
                ? value <= 0
                : instr.opcode === 'BGTZ'
                  ? value > 0
                  : value >= 0;
      explanation = branch(state, instr, taken, value);
      break;
    }
    case 'PUSH': {
      const value = exec.value(first as VmOperand);
      exec.push(value);
      explanation = `Push ${value} onto the stack.`;
      break;
    }
    case 'POP':
      if (first) {
        const value = exec.pop();
        exec.assign(first, value);
        explanation = `Pop ${value} into ${describe(first)}.`;
      } else {
        explanation = `Pop and discard ${exec.pop()}.`;
      }
      break;
    case 'CALL': {
      const target = first as VmOperand & { kind: 'label' };
      exec.push(pc + 1);
      state.callStack.push({ function: target.name, returnTo: pc + 1, sp: exec.register('SP') });
      state.pc = target.target;
      explanation = `Push the return address ${pc + 1} and jump to ${target.name}.`;
      break;
    }
    case 'RET': {
      if (state.callStack.length === 0) {
        exec.fail(
          'vm_bad_return',
          'RET ran with no matching CALL.',
          'A function must be entered with CALL before it can return.',
        );
      }
      const returnTo = exec.pop();
      const frame = state.callStack.pop() as VmCallFrame;
      state.pc = returnTo;
      explanation = `Return from ${frame.function} to instruction ${returnTo}.`;
      break;
    }
    case 'ENTER': {
      const size = exec.value(first as VmOperand);
      exec.push(exec.register('FP'));
      exec.setRegister('FP', exec.register('SP'));
      const next = exec.register('SP') - size;
      if (next < program.dataEnd) {
        exec.fail(
          'vm_stack_overflow',
          'There is no room left on the stack for this frame.',
          'Very deep or endless recursion usually causes this. Check the base case.',
        );
      }
      // Fresh locals read as 0, not as whatever an earlier call left behind.
      state.memory.fill(0, next, exec.register('SP'));
      exec.setRegister('SP', next);
      explanation = `Save the old FP, point FP at the new frame, and reserve ${size} cell${size === 1 ? '' : 's'} for locals, cleared to 0.`;
      break;
    }
    case 'LEAVE':
      exec.setRegister('SP', exec.register('FP'));
      exec.setRegister('FP', exec.pop());
      explanation = 'Drop the frame and restore the old FP.';
      break;
    case 'CHK': {
      const index = exec.value(first as VmOperand);
      const limit = exec.value(second as VmOperand);
      if (index < 0 || index >= limit) {
        exec.fail(
          'vm_index_out_of_range',
          `Index ${index} is outside an array of size ${limit}.`,
          `Valid indexes run from 0 to ${limit - 1}.`,
        );
      }
      explanation = `${index} is a valid index for an array of size ${limit}.`;
      break;
    }
    case 'PRINT': {
      const value = first ? exec.value(first) : exec.pop();
      state.output.push(String(value));
      explanation = `Output ${value}.`;
      break;
    }
    case 'PRINTB': {
      const value = first ? exec.value(first) : exec.pop();
      const shown = value !== 0 ? 'true' : 'false';
      state.output.push(shown);
      explanation = `Output ${shown}.`;
      break;
    }
    case 'NOP':
      explanation = 'Do nothing.';
      break;
    case 'HALT':
      state.halted = true;
      explanation = 'The program stops here.';
      break;
    default:
      explanation = runBinary(exec, instr);
  }

  state.steps++;
  return { explanation, writes: exec.writes };
}
