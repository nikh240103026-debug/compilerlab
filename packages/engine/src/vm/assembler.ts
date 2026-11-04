import { ISA_OPERATORS, type IsaBinaryOpcode, type IsaOpcode } from '../codegen/isa';
import { EngineError } from '../core/result';

export const VM_MAX_ASM_LINES = 20_000;
export const VM_MAX_DATA_CELLS = 16_384;

export type VmOperand =
  | { kind: 'reg'; name: string }
  | { kind: 'imm'; value: number }
  /** The address is `address` plus the value of `base`. With `indirect`, read that cell for it. */
  | { kind: 'mem'; address: number; base: string | null; indirect: boolean; symbol: string | null }
  | { kind: 'label'; name: string; target: number };

export interface VmInstr {
  opcode: IsaOpcode;
  operands: VmOperand[];
  /** 1-based source line. */
  line: number;
  /** Where the line's code starts in the source, as a UTF-16 offset. */
  offset: number;
  length: number;
  text: string;
}

export interface VmDataSymbol {
  address: number;
  size: number;
  initial: number[];
}

export interface VmProgram {
  instrs: VmInstr[];
  /** Instruction index of each label. */
  labels: Record<string, number>;
  /** Named memory, in address order from 0. */
  symbols: Record<string, VmDataSymbol>;
  /** First address past the named memory. The stack may not grow below this. */
  dataEnd: number;
  source: string;
}

interface RawLine {
  opcode: string;
  operands: { text: string; offset: number }[];
  line: number;
  offset: number;
  text: string;
}

const REGISTER = /^(R[0-7]|SP|FP)$/i;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
const ADDRESSED = /^(\*?)(-?\d+|[A-Za-z_$][A-Za-z0-9_$.]*)?\((R[0-7]|SP|FP)\)$/i;

function failAt(
  line: number,
  message: string,
  offset: number,
  length: number,
  hint: string,
): never {
  throw new EngineError({
    code: 'asm_error',
    message: `Line ${line}: ${message}`,
    hint,
    position: offset,
    length,
  });
}

const OPCODES = new Set<string>([
  ...Object.keys(ISA_OPERATORS),
  'LD',
  'ST',
  'LEA',
  'NEG',
  'NOT',
  'BR',
  'BEQZ',
  'BNEZ',
  'BLTZ',
  'BLEZ',
  'BGTZ',
  'BGEZ',
  'PUSH',
  'POP',
  'CALL',
  'RET',
  'ENTER',
  'LEAVE',
  'CHK',
  'PRINT',
  'PRINTB',
  'NOP',
  'HALT',
]);

/** Allowed operand kinds per position, for each accepted form of an opcode. */
type Form = readonly (readonly VmOperand['kind'][])[];
const REG = ['reg'] as const;
const VALUE = ['reg', 'imm'] as const;
const LABEL = ['label'] as const;
const MEM = ['mem'] as const;

function formsOf(opcode: IsaOpcode): readonly Form[] {
  if (opcode in ISA_OPERATORS) {
    return [[], [REG, REG, VALUE]];
  }
  switch (opcode as Exclude<IsaOpcode, IsaBinaryOpcode>) {
    case 'LD':
      return [[REG, ['reg', 'imm', 'mem']]];
    case 'ST':
      return [[MEM, REG]];
    case 'LEA':
      return [[REG, MEM]];
    case 'NEG':
    case 'NOT':
      return [[], [REG, REG]];
    case 'BR':
    case 'CALL':
      return [[LABEL]];
    case 'BEQZ':
    case 'BNEZ':
      return [[LABEL], [REG, LABEL]];
    case 'BLTZ':
    case 'BLEZ':
    case 'BGTZ':
    case 'BGEZ':
      return [[REG, LABEL]];
    case 'PUSH':
      return [[['reg', 'imm', 'mem']]];
    case 'POP':
      return [[], [['reg', 'mem']]];
    case 'RET':
    case 'LEAVE':
    case 'NOP':
    case 'HALT':
      return [[]];
    case 'ENTER':
      return [[['imm']]];
    case 'CHK':
      return [[REG, VALUE]];
    case 'PRINT':
    case 'PRINTB':
      return [[], [REG]];
  }
}

function formatForms(opcode: string, forms: readonly Form[]): string {
  const showKind = (kinds: readonly string[]) =>
    kinds
      .map((kind) =>
        kind === 'reg'
          ? 'a register'
          : kind === 'imm'
            ? 'a constant like #5'
            : kind === 'mem'
              ? 'a memory operand'
              : 'a label',
      )
      .join(' or ');
  return forms
    .map((form) =>
      form.length === 0
        ? `${opcode} alone`
        : `${opcode} with ${form.map(showKind).join(', then ')}`,
    )
    .join('; or ');
}

/** Splits lines into labels, directives and instructions, without judging operands yet. */
function splitSource(source: string, data: (line: RawLine) => void, labels: Map<string, number>) {
  const raw: RawLine[] = [];
  const lines = source.split('\n');
  if (lines.length > VM_MAX_ASM_LINES) {
    throw new EngineError({
      code: 'asm_too_long',
      message: `This program has more than ${VM_MAX_ASM_LINES} lines.`,
      hint: 'Try a shorter program.',
    });
  }
  let lineOffset = 0;
  lines.forEach((fullLine, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const commentAt = fullLine.search(/;|\/\//);
    let code = commentAt === -1 ? fullLine : fullLine.slice(0, commentAt);
    let codeOffset = lineOffset;

    // Peel off any labels at the start of the line.
    for (;;) {
      const match = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*:/.exec(code);
      if (!match) break;
      const name = match[1] as string;
      const nameOffset = codeOffset + match[0].indexOf(name);
      if (labels.has(name)) {
        failAt(
          lineNumber,
          `The label ${name} is defined twice.`,
          nameOffset,
          name.length,
          'Give each label its own name.',
        );
      }
      labels.set(name, raw.length);
      codeOffset += match[0].length;
      code = code.slice(match[0].length);
    }

    const trimmed = code.trim();
    if (trimmed !== '') {
      const start = codeOffset + code.indexOf(trimmed);
      const opcodeMatch = /^\S+/.exec(trimmed) as RegExpExecArray;
      const opcode = opcodeMatch[0];
      const rest = trimmed.slice(opcode.length);
      const operands: RawLine['operands'] = [];
      if (rest.trim() !== '') {
        let at = start + opcode.length;
        for (const part of rest.split(',')) {
          const text = part.trim();
          const offset = at + part.indexOf(text);
          if (text === '') {
            failAt(
              lineNumber,
              'There is an empty operand here.',
              at,
              Math.max(part.length, 1),
              'Separate operands with single commas, like: ADD R1, R2, R3',
            );
          }
          operands.push({ text, offset });
          at += part.length + 1;
        }
      }
      const parsed: RawLine = { opcode, operands, line: lineNumber, offset: start, text: trimmed };
      if (opcode.startsWith('.')) data(parsed);
      else raw.push(parsed);
    }
    lineOffset += fullLine.length + 1;
  });
  return raw;
}

interface Symbols {
  table: Record<string, VmDataSymbol>;
  next: number;
}

function reserve(symbols: Symbols, name: string, size: number, initial: number[]): VmDataSymbol {
  const symbol: VmDataSymbol = { address: symbols.next, size, initial };
  symbols.table[name] = symbol;
  symbols.next += size;
  return symbol;
}

/** .data x       reserves one cell. .data a 10   reserves ten. .data x = 5   sets a start value. */
function parseDirective(line: RawLine, symbols: Symbols): void {
  const fail = (message: string): never =>
    failAt(line.line, message, line.offset, line.text.length, 'Write a directive like: .data a 10');
  if (line.opcode !== '.data') {
    fail(`${line.opcode} is not a directive. The only directive is .data.`);
  }
  const match = /^\.data\s+([A-Za-z_$][A-Za-z0-9_$.]*)(?:\s+(\d+))?(?:\s*=\s*(.+))?$/.exec(
    line.text,
  );
  if (!match) return void fail('This .data line is not in a form the assembler knows.');
  const name = match[1] as string;
  if (symbols.table[name]) fail(`${name} is declared twice.`);
  const initial = match[3]
    ? match[3].split(',').map((value) => {
        const number = Number(value.trim());
        if (!Number.isInteger(number)) fail(`"${value.trim()}" is not a whole number.`);
        return number | 0;
      })
    : [];
  const size = match[2] ? Number(match[2]) : Math.max(initial.length, 1);
  if (size < 1 || symbols.next + size > VM_MAX_DATA_CELLS) {
    fail(`${name} does not fit: named memory is limited to ${VM_MAX_DATA_CELLS} cells.`);
  }
  if (initial.length > size) fail(`${name} has ${size} cells but ${initial.length} start values.`);
  reserve(symbols, name, size, initial);
}

/** Direct names are declared by first use, like the book's examples that just say LD R1, x. */
function symbolAddress(symbols: Symbols, name: string): number {
  const known = symbols.table[name];
  return known ? known.address : reserve(symbols, name, 1, []).address;
}

function parseOperand(
  text: string,
  wantsLabel: boolean,
  symbols: Symbols,
  labels: ReadonlyMap<string, number>,
  fail: (message: string, hint: string) => never,
): VmOperand {
  if (wantsLabel) {
    if (!NAME.test(text)) fail(`"${text}" is not a label.`, 'A label is a name like loop.');
    const target = labels.get(text);
    if (target === undefined) {
      fail(`There is no label named ${text}.`, `Add a line "${text}:" where this should jump to.`);
    }
    return { kind: 'label', name: text, target: target as number };
  }
  if (REGISTER.test(text)) return { kind: 'reg', name: text.toUpperCase() };
  if (/^#-?\d+$/.test(text)) return { kind: 'imm', value: Number(text.slice(1)) | 0 };
  if (/^-?\d+$/.test(text)) return { kind: 'imm', value: Number(text) | 0 };

  const indirectRegister = /^\*(R[0-7]|SP|FP)$/i.exec(text);
  if (indirectRegister) {
    return {
      kind: 'mem',
      address: 0,
      base: (indirectRegister[1] as string).toUpperCase(),
      indirect: false,
      symbol: null,
    };
  }

  const addressed = ADDRESSED.exec(text);
  if (addressed) {
    const [, star, place, base] = addressed;
    const isName = place !== undefined && !/^-?\d/.test(place);
    return {
      kind: 'mem',
      address: isName ? symbolAddress(symbols, place) : Number(place ?? 0),
      base: (base as string).toUpperCase(),
      indirect: star === '*',
      symbol: isName ? place : null,
    };
  }

  if (NAME.test(text)) {
    return {
      kind: 'mem',
      address: symbolAddress(symbols, text),
      base: null,
      indirect: false,
      symbol: text,
    };
  }
  fail(`"${text}" is not an operand.`, 'Operands look like R1, #5, x, a(R1), -2(FP) or *R1.');
}

function matchesForm(operands: readonly VmOperand[], form: Form): boolean {
  return (
    operands.length === form.length &&
    operands.every((operand, index) => (form[index] as readonly string[]).includes(operand.kind))
  );
}

/**
 * Turns assembly text into a program. Errors name the line and carry the source position.
 * Comments start with ; or //. A label is a name and a colon, on its own line or before code.
 */
export function vmAssemble(source: string): VmProgram {
  // No prototype, so a variable named "constructor" is not mistaken for one already declared.
  const symbols: Symbols = { table: Object.create(null) as Symbols['table'], next: 0 };
  const labels = new Map<string, number>();
  const raw = splitSource(source, (line) => parseDirective(line, symbols), labels);

  const instrs: VmInstr[] = raw.map((line) => {
    const opcode = line.opcode.toUpperCase();
    if (!OPCODES.has(opcode)) {
      failAt(
        line.line,
        `${line.opcode} is not an instruction.`,
        line.offset,
        line.opcode.length,
        'The instruction reference lists every opcode.',
      );
    }
    const isaOpcode = opcode as IsaOpcode;
    const forms = formsOf(isaOpcode);
    const lastIsLabel = forms.some((form) =>
      (form.at(-1) as readonly string[] | undefined)?.includes('label'),
    );
    const operands = line.operands.map(({ text, offset }, index) =>
      parseOperand(
        text,
        lastIsLabel && index === line.operands.length - 1,
        symbols,
        labels,
        (message, hint): never => failAt(line.line, message, offset, text.length, hint),
      ),
    );
    if (!forms.some((form) => matchesForm(operands, form))) {
      failAt(
        line.line,
        `${opcode} cannot take these operands. It takes ${formatForms(opcode, forms)}.`,
        line.offset,
        line.text.length,
        'Check the operands against the instruction reference.',
      );
    }
    return {
      opcode: isaOpcode,
      operands,
      line: line.line,
      offset: line.offset,
      length: line.text.length,
      text: line.text,
    };
  });

  if (instrs.length === 0) {
    throw new EngineError({
      code: 'asm_empty',
      message: 'This program has no instructions.',
      hint: 'Write an instruction like: LD R1, #5',
    });
  }
  if (symbols.next > VM_MAX_DATA_CELLS) {
    throw new EngineError({
      code: 'asm_error',
      message: `This program names more than ${VM_MAX_DATA_CELLS} memory cells.`,
      hint: 'Use fewer variables.',
    });
  }
  return {
    instrs,
    labels: Object.fromEntries(labels),
    symbols: symbols.table,
    dataEnd: symbols.next,
    source,
  };
}

export function vmIsRegisterName(text: string): boolean {
  return REGISTER.test(text);
}
