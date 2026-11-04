import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr, type TacOperand } from '../ir/types';
import { optDefOf, optIsCommutative, optOperandsOf } from '../optimize/tac-util';
import { ISA_OPCODE_OF_OPERATOR } from './isa';
import {
  codegenBlockStatements,
  codegenDefaultLiveOnExit,
  codegenNextUse,
  type NextUseEntry,
  type NextUseRow,
} from './next-use';

export const CODEGEN_MAX_REGISTERS = 7;

export interface GetRegOptions {
  /** How many registers to use, R1 upward. The book's example uses 3. */
  registers?: number;
  liveOnExit?: readonly string[];
}

export interface GetRegState {
  /** The statement being translated. Null at the start and for the end-of-block stores. */
  statement: number | null;
  /** The instruction this step produced. Null when it only records a decision. */
  instruction: string | null;
  /** All code so far. */
  code: string[];
  /** Register descriptors: which names each register holds. */
  registers: { register: string; holds: string[] }[];
  /** Address descriptors: where each name's current value can be found. */
  addresses: { name: string; locations: string[] }[];
  /** Registers chosen for this statement so far. */
  choice: { rx: string | null; ry: string | null; rz: string | null };
}

export interface GetRegGroup {
  /** The statement, or "exit" for the stores at the end. */
  statement: string;
  code: string[];
}

export interface GetRegResult {
  statements: string[];
  rows: NextUseRow[];
  code: string[];
  /** The code grouped by statement, like the book's figure. */
  groups: GetRegGroup[];
  trace: Trace<GetRegState>;
}

/** Generates code for one block with the book's getReg, tracking both kinds of descriptor. */
class BlockGenerator {
  readonly code: string[] = [];
  readonly groups: GetRegGroup[] = [];
  readonly recorder = new TraceRecorder<GetRegState>();
  readonly registerNames: string[];
  readonly regDesc = new Map<string, Set<string>>();
  readonly addrDesc = new Map<string, Set<string>>();
  statement: number | null = null;
  choice: GetRegState['choice'] = { rx: null, ry: null, rz: null };
  private after: Readonly<Record<string, NextUseEntry>> = {};

  constructor(count: number, names: readonly string[]) {
    this.registerNames = Array.from({ length: count }, (_, i) => `R${i + 1}`);
    for (const register of this.registerNames) this.regDesc.set(register, new Set());
    for (const name of names) this.addrDesc.set(name, new Set());
  }

  setAfter(after: Readonly<Record<string, NextUseEntry>>): void {
    this.after = after;
  }

  private locations(name: string): Set<string> {
    let places = this.addrDesc.get(name);
    if (!places) {
      places = new Set();
      this.addrDesc.set(name, places);
    }
    return places;
  }

  record(title: string, explanation: string, instruction: string | null): void {
    this.recorder.add(title, explanation, {
      statement: this.statement,
      instruction,
      code: [...this.code],
      registers: this.registerNames.map((register) => ({
        register,
        holds: [...(this.regDesc.get(register) as Set<string>)],
      })),
      addresses: [...this.addrDesc].map(([name, locations]) => ({
        name,
        locations: [...locations],
      })),
      choice: { ...this.choice },
    });
  }

  private emit(instruction: string, explanation: string): void {
    this.code.push(instruction);
    (this.groups.at(-1) as GetRegGroup).code.push(instruction);
    this.record(instruction, explanation, instruction);
  }

  regOf(name: string): string | null {
    for (const [register, holds] of this.regDesc) {
      if (holds.has(name)) return register;
    }
    return null;
  }

  hasOtherCopy(name: string, register: string): boolean {
    return [...this.locations(name)].some((place) => place !== register);
  }

  /** Forget that this register holds anything: it is about to be overwritten. */
  private clear(register: string): void {
    const holds = this.regDesc.get(register) as Set<string>;
    for (const name of holds) this.locations(name).delete(register);
    holds.clear();
  }

  /** Book rule 1: LD R, x means R holds only x, and x can also be found in R. */
  private noteLoad(register: string, name: string): void {
    this.clear(register);
    (this.regDesc.get(register) as Set<string>).add(name);
    this.locations(name).add(register);
  }

  /** Book rule 3: after OP Rx, ... Rx holds only x, and x can be found only in Rx. */
  private noteResult(register: string, name: string): void {
    for (const [other, holds] of this.regDesc) {
      if (other !== register) holds.delete(name);
    }
    this.clear(register);
    (this.regDesc.get(register) as Set<string>).add(name);
    this.addrDesc.set(name, new Set([register]));
  }

  /** The stores needed before this register can be overwritten: the book's score. */
  private storesNeeded(
    register: string,
    dest: string | null,
    operands: readonly string[],
  ): string[] {
    const stores: string[] = [];
    for (const name of this.regDesc.get(register) as Set<string>) {
      const elsewhere = this.hasOtherCopy(name, register);
      const beingAssigned = name === dest && !operands.includes(name);
      const entry = this.after[name];
      const usedLater = entry ? entry.live : false;
      if (!elsewhere && !beingAssigned && usedLater) stores.push(name);
    }
    return stores;
  }

  /**
   * Book rule 3, with the book's choices left open made definite: fewest stores, then a register
   * holding no operand of this statement, then the lowest number. With those tie-breaks this gives
   * exactly the code in the book's worked example.
   */
  private pickRegister(
    avoid: readonly string[],
    dest: string | null,
    operands: readonly string[],
  ): string {
    const candidates = this.registerNames.filter((register) => !avoid.includes(register));
    const empty = candidates.find(
      (register) => (this.regDesc.get(register) as Set<string>).size === 0,
    );
    if (empty) return empty;

    let best = candidates[0] as string;
    let bestStores = Infinity;
    let bestHoldsOperand = true;
    for (const register of candidates) {
      const stores = this.storesNeeded(register, dest, operands).length;
      const holdsOperand = operands.some((name) =>
        (this.regDesc.get(register) as Set<string>).has(name),
      );
      if (stores < bestStores || (stores === bestStores && bestHoldsOperand && !holdsOperand)) {
        best = register;
        bestStores = stores;
        bestHoldsOperand = holdsOperand;
      }
    }

    for (const name of this.storesNeeded(best, dest, operands)) {
      this.locations(name).add(name);
      this.emit(
        `ST ${name}, ${best}`,
        `Every register is in use, and ${best} is the cheapest to free. ${name} is still needed and has no other copy, so it is saved to memory first.`,
      );
    }
    return best;
  }

  /** Finds a register for an operand, loading it unless it is already in one. */
  ensureInRegister(
    name: string,
    avoid: readonly string[],
    dest: string | null,
    operands: readonly string[],
  ): string {
    const existing = this.regOf(name);
    if (existing && !avoid.includes(existing)) return existing;
    const register = this.pickRegister(avoid, dest, operands);
    const source = existing ?? name;
    this.noteLoad(register, name);
    this.emit(
      `LD ${register}, ${source}`,
      `${name} is not in a usable register, so load it into ${register}.`,
    );
    return register;
  }

  /** Loads a constant into a register that holds no name afterward. */
  loadConstant(
    value: number,
    avoid: readonly string[],
    dest: string | null,
    operands: readonly string[],
  ): string {
    const register = this.pickRegister(avoid, dest, operands);
    this.clear(register);
    this.emit(
      `LD ${register}, #${value}`,
      `This operation needs the constant ${value} in a register, so load it into ${register}.`,
    );
    return register;
  }

  /** Book's rules for Rx. Reuse only what would otherwise be thrown away. */
  chooseDest(
    dest: string,
    sources: readonly (string | null)[],
    operands: readonly string[],
  ): string {
    for (const [register, holds] of this.regDesc) {
      if (holds.size === 1 && holds.has(dest)) return register;
    }
    for (const source of sources) {
      if (source === null) continue;
      const register = this.regOf(source);
      if (!register) continue;
      const holds = this.regDesc.get(register) as Set<string>;
      const entry = this.after[source];
      if (holds.size === 1 && entry?.nextUse === null && this.hasOtherCopy(source, register)) {
        return register;
      }
    }
    return this.pickRegister([], dest, operands);
  }

  emitResult(instruction: string, register: string, dest: string, explanation: string): void {
    this.noteResult(register, dest);
    this.emit(instruction, explanation);
  }

  emitPlain(instruction: string, explanation: string): void {
    this.emit(instruction, explanation);
  }

  /** Book rule 4: for x = y, Ry now holds x too, and x can only be found in Ry. */
  noteCopy(register: string, dest: string): void {
    for (const [other, holds] of this.regDesc) {
      if (other !== register) holds.delete(dest);
    }
    (this.regDesc.get(register) as Set<string>).add(dest);
    this.addrDesc.set(dest, new Set([register]));
  }

  storeLiveOnExit(liveOnExit: readonly string[]): void {
    for (const name of [...liveOnExit].toSorted()) {
      const places = this.locations(name);
      if (places.has(name) || places.size === 0) continue;
      const register = [...places][0] as string;
      places.add(name);
      this.emit(
        `ST ${name}, ${register}`,
        `${name} is live on exit, and its current value is only in ${register}, so it must be stored before the block ends.`,
      );
    }
  }

  beginGroup(statement: string): void {
    this.groups.push({ statement, code: [] });
  }
}

function checkRegisterCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > CODEGEN_MAX_REGISTERS) {
    throw new EngineError({
      code: 'bad_register_count',
      message: `This needs between 2 and ${CODEGEN_MAX_REGISTERS} registers, but was asked to use ${count}.`,
      hint: 'The book uses 3.',
    });
  }
}

const nameOf = (operand: TacOperand): string | null =>
  operand.kind === 'const' ? null : operand.name;

function operandNames(...operands: TacOperand[]): string[] {
  return operands.flatMap((operand) => (operand.kind === 'const' ? [] : [operand.name]));
}

function translateBinary(gen: BlockGenerator, instr: TacInstr & { op: 'binary' }): void {
  let { left, right } = instr;
  if (left.kind === 'const' && right.kind !== 'const' && optIsCommutative(instr.operator)) {
    [left, right] = [right, left];
  }
  const opcode = ISA_OPCODE_OF_OPERATOR[instr.operator];
  const operands = operandNames(left, right);

  const rightName = nameOf(right);
  const rightRegister = rightName ? gen.regOf(rightName) : null;
  const leftAvoid = rightRegister && rightName !== nameOf(left) ? [rightRegister] : [];
  const ry =
    left.kind === 'const'
      ? gen.loadConstant(left.value, leftAvoid, instr.dest, operands)
      : gen.ensureInRegister(left.name, leftAvoid, instr.dest, operands);
  gen.choice = { ...gen.choice, ry };

  let rz: string | null = null;
  if (right.kind !== 'const') {
    rz =
      rightName === nameOf(left)
        ? ry
        : gen.ensureInRegister(right.name, [ry], instr.dest, operands);
    gen.choice = { ...gen.choice, rz };
  }

  const rx = gen.chooseDest(instr.dest, [nameOf(left), rightName], operands);
  gen.choice = { ...gen.choice, rx };
  const source2 = right.kind === 'const' ? `#${right.value}` : (rz as string);
  gen.emitResult(
    `${opcode} ${rx}, ${ry}, ${source2}`,
    rx,
    instr.dest,
    `Compute ${instr.dest} into ${rx}. Now ${rx} holds only ${instr.dest}, and ${instr.dest}'s only current copy is in ${rx}.`,
  );
}

function translateStatement(gen: BlockGenerator, instr: TacInstr): void {
  switch (instr.op) {
    case 'binary':
      translateBinary(gen, instr);
      return;
    case 'unary': {
      const operands = operandNames(instr.arg);
      const ry =
        instr.arg.kind === 'const'
          ? gen.loadConstant(instr.arg.value, [], instr.dest, operands)
          : gen.ensureInRegister(instr.arg.name, [], instr.dest, operands);
      const rx = gen.chooseDest(instr.dest, [nameOf(instr.arg)], operands);
      gen.choice = { rx, ry, rz: null };
      gen.emitResult(
        `${instr.operator === '-' ? 'NEG' : 'NOT'} ${rx}, ${ry}`,
        rx,
        instr.dest,
        `Compute ${instr.dest} into ${rx}.`,
      );
      return;
    }
    case 'assign': {
      if (instr.src.kind === 'const') {
        const rx = gen.chooseDest(instr.dest, [], []);
        gen.choice = { rx, ry: null, rz: null };
        gen.emitResult(
          `LD ${rx}, #${instr.src.value}`,
          rx,
          instr.dest,
          `Load the constant into ${rx}, which now holds only ${instr.dest}.`,
        );
        return;
      }
      if (instr.src.name === instr.dest) return;
      const ry = gen.ensureInRegister(instr.src.name, [], instr.dest, [instr.src.name]);
      gen.choice = { rx: ry, ry, rz: null };
      gen.noteCopy(ry, instr.dest);
      gen.record(
        `${instr.dest} = ${instr.src.name}`,
        `A copy needs no new instruction. ${ry} holds ${instr.src.name}, and now holds ${instr.dest} as well. Memory is updated only if needed later.`,
        null,
      );
      return;
    }
    case 'load': {
      const operands = operandNames(instr.index);
      const ri =
        instr.index.kind === 'const'
          ? gen.loadConstant(instr.index.value, [], instr.dest, operands)
          : gen.ensureInRegister(instr.index.name, [], instr.dest, operands);
      const rx = gen.chooseDest(instr.dest, [nameOf(instr.index)], operands);
      gen.choice = { rx, ry: ri, rz: null };
      gen.emitResult(
        `LD ${rx}, ${instr.base}(${ri})`,
        rx,
        instr.dest,
        `Read the array cell into ${rx}, using ${ri} as the index.`,
      );
      return;
    }
    case 'store': {
      const operands = operandNames(instr.index, instr.src);
      const indexName = nameOf(instr.index);
      const indexRegister = indexName ? gen.regOf(indexName) : null;
      const srcAvoid = indexRegister && indexName !== nameOf(instr.src) ? [indexRegister] : [];
      const ry =
        instr.src.kind === 'const'
          ? gen.loadConstant(instr.src.value, srcAvoid, null, operands)
          : gen.ensureInRegister(instr.src.name, srcAvoid, null, operands);
      const ri =
        instr.index.kind === 'const'
          ? gen.loadConstant(instr.index.value, [ry], null, operands)
          : indexName === nameOf(instr.src)
            ? ry
            : gen.ensureInRegister(instr.index.name, [ry], null, operands);
      gen.choice = { rx: null, ry, rz: ri };
      gen.emitPlain(
        `ST ${instr.base}(${ri}), ${ry}`,
        `Write ${ry} to the array cell, using ${ri} as the index.`,
      );
      return;
    }
    default:
      throw new EngineError({
        code: 'getreg_unsupported',
        message: `This demo generates code for straight-line statements, and "${formatTac(instr)}" is not one.`,
        hint: 'Remove calls and parameters from the block.',
      });
  }
}

/**
 * The book's code generation for a basic block. Every name not defined first in the block starts
 * in memory. Book example, with 3 registers:
 *   t = a - b; u = a - c; v = t + u; a = d; d = v + u
 * The temporaries in that example are named t, u and v, so pass liveOnExit: ['a', 'b', 'c', 'd'].
 */
export function codegenGetReg(
  input: string | readonly TacInstr[],
  options: GetRegOptions = {},
): GetRegResult {
  const registers = options.registers ?? 3;
  checkRegisterCount(registers);
  const { body, jump } = codegenBlockStatements(input);
  const statements = jump ? [...body, jump] : body;
  const liveOnExit = options.liveOnExit ?? codegenDefaultLiveOnExit(statements);
  const { rows } = codegenNextUse(statements, { liveOnExit });
  const allNames = Object.keys((rows[0] as NextUseRow | undefined)?.after ?? {});

  // A name starts in memory, unless the block defines it before reading it and nothing outside
  // needs it. Such a temporary starts nowhere, as in the book's figure.
  const startsNowhere = new Set<string>();
  const seen = new Set<string>();
  for (const instr of statements) {
    for (const name of optOperandsOf(instr).flatMap((operand) => operandNames(operand))) {
      seen.add(name);
    }
    const def = optDefOf(instr);
    if (def !== null && !seen.has(def)) {
      seen.add(def);
      if (!liveOnExit.includes(def)) startsNowhere.add(def);
    }
  }

  const gen = new BlockGenerator(registers, allNames);
  for (const name of allNames) {
    if (!startsNowhere.has(name)) gen.addrDesc.get(name)?.add(name);
  }
  gen.record(
    'Start of the block',
    `All ${registers} registers are empty. Each variable's value is in its own memory location, and a temporary the block defines is nowhere yet.`,
    null,
  );

  body.forEach((instr, index) => {
    const row = rows[index] as NextUseRow;
    gen.statement = index;
    gen.choice = { rx: null, ry: null, rz: null };
    gen.setAfter(row.after);
    gen.beginGroup(row.text);
    gen.record(
      `Statement ${index + 1}: ${row.text}`,
      `Ask getReg for registers. Next-use information after this statement: ${row.attached.map((entry) => `${entry.name} ${entry.nextUse !== null ? `is next used at statement ${entry.nextUse + 1}` : entry.live ? 'is live on exit' : 'is not used again'}`).join('; ')}.`,
      null,
    );
    translateStatement(gen, instr);
  });

  gen.statement = null;
  gen.choice = { rx: null, ry: null, rz: null };
  gen.beginGroup('exit');

  if (jump) {
    const row = rows[body.length] as NextUseRow;
    gen.setAfter(row.after);
    let condRegister: string | null = null;
    if (jump.op === 'if') {
      condRegister =
        jump.cond.kind === 'const'
          ? gen.loadConstant(jump.cond.value, [], null, [])
          : gen.ensureInRegister(jump.cond.name, [], null, [jump.cond.name]);
    }
    // Stores go before the jump: past it, this block's code never runs.
    gen.storeLiveOnExit(liveOnExit);
    if (jump.op === 'goto') {
      gen.emitPlain(
        `BR ${jump.target}`,
        `Jump to ${jump.target}. Every live value is safely in memory first.`,
      );
    } else if (jump.op === 'if') {
      gen.emitPlain(
        `${jump.negate ? 'BEQZ' : 'BNEZ'} ${condRegister as string}, ${jump.target}`,
        'Branch on the condition. Every live value is safely in memory first.',
      );
    }
  } else {
    gen.storeLiveOnExit(liveOnExit);
  }

  gen.record(
    'End of the block',
    'Every value that is live on exit is now in its own memory location.',
    null,
  );

  return {
    statements: rows.map((row) => row.text),
    rows,
    code: gen.code,
    groups: gen.groups,
    trace: gen.recorder.finish(),
  };
}
