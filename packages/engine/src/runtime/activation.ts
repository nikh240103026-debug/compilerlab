import { codegenParseExpr, type CgExpr } from '../codegen/expr';
import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { vmEvalBinary, vmEvalUnary } from '../vm/arith';
import type { RtProcedure, RtProgram, RtStatement } from './activation-model';

export const RT_MAX_CALL_DEPTH = 64;
export const RT_MAX_STEPS = 4000;

export type RtSlotKind =
  'return-value' | 'param' | 'control-link' | 'access-link' | 'return-address' | 'local';

export interface RtSlot {
  kind: RtSlotKind;
  name: string;
  /** A number for a variable, or a frame id for a link. Null when not set yet. */
  value: number | null;
  /** The address of this cell in the simulated stack. */
  address: number;
}

export interface RtFrameView {
  id: number;
  proc: string;
  /** Nesting depth of the procedure in the source, with the outermost at 1. */
  depth: number;
  /** Frame id of the caller. */
  controlLink: number | null;
  /** Frame id of the enclosing procedure's most recent activation. */
  accessLink: number | null;
  /** Readable place to resume in the caller. */
  returnAddress: string | null;
  /** The cells in layout order, following the book's picture of an activation record. */
  slots: RtSlot[];
  baseAddress: number;
}

export type RtEvent = 'start' | 'call' | 'assign' | 'branch' | 'print' | 'return' | 'finish';

export interface RtActivationState {
  event: RtEvent;
  /** The stack, oldest frame first. */
  frames: RtFrameView[];
  /** The frame running now. */
  current: number | null;
  /** Frames visited through access links in the variable lookup this step made, in order. */
  accessWalk: number[];
  /** Links followed to set the new frame's access link. */
  linkHops: number;
  output: string[];
}

export interface RtActivationResult {
  output: string[];
  /** The deepest the stack ever got. */
  maxDepth: number;
  /** How many activations ran in total. */
  totalCalls: number;
  trace: Trace<RtActivationState>;
}

interface ProcInfo {
  proc: RtProcedure;
  parent: ProcInfo | null;
  depth: number;
}

interface Frame {
  id: number;
  info: ProcInfo;
  values: Map<string, number>;
  params: string[];
  locals: string[];
  control: Frame | null;
  access: Frame | null;
  returnAddress: string | null;
  returnValue: number | null;
  base: number;
}

function buildProcTable(root: RtProgram): ProcInfo {
  const walk = (proc: RtProcedure, parent: ProcInfo | null, depth: number): ProcInfo => {
    if (depth > 16) {
      throw new EngineError({
        code: 'rt_too_deep',
        message: 'These procedures are nested more than 16 levels deep.',
        hint: 'Use fewer levels of nesting.',
      });
    }
    const info: ProcInfo = { proc, parent, depth };
    for (const nested of proc.nested ?? []) walk(nested, info, depth + 1);
    return info;
  };
  return walk(root, null, 1);
}

/** Lexical scope: look in this procedure's nested list, then outward through enclosing ones. */
function resolveProc(caller: ProcInfo, name: string): ProcInfo {
  for (let scope: ProcInfo | null = caller; scope; scope = scope.parent) {
    if (scope.proc.name === name) return scope;
    const nested = (scope.proc.nested ?? []).find((proc) => proc.name === name);
    if (nested) return { proc: nested, parent: scope, depth: scope.depth + 1 };
  }
  throw new EngineError({
    code: 'rt_unknown_procedure',
    message: `${caller.proc.name} calls ${name}, but no procedure of that name is in scope there.`,
    hint: 'A procedure can call itself, its own nested procedures, and those of the procedures around it.',
  });
}

function nameOfLocal(local: string | { name: string; value: number }): string {
  return typeof local === 'string' ? local : local.name;
}

/** Runs a program description, recording the stack at each step. */
export function rtSimulateActivations(program: RtProgram): RtActivationResult {
  const rootInfo = buildProcTable(program);
  const recorder = new TraceRecorder<RtActivationState>();
  const stack: Frame[] = [];
  const output: string[] = [];
  const parsed = new Map<string, CgExpr>();
  let steps = 0;
  let nextFrameId = 0;
  let maxDepth = 0;
  let totalCalls = 0;

  const frameSize = (frame: Frame) => 4 + frame.params.length + frame.locals.length;

  const viewFrame = (frame: Frame): RtFrameView => {
    let address = frame.base;
    const slot = (kind: RtSlotKind, name: string, value: number | null): RtSlot => ({
      kind,
      name,
      value,
      address: address++,
    });
    const slots = [
      slot('return-value', 'return value', frame.returnValue),
      ...frame.params.map((name) => slot('param', name, frame.values.get(name) ?? null)),
      slot('control-link', 'control link', frame.control?.id ?? null),
      slot('access-link', 'access link', frame.access?.id ?? null),
      slot('return-address', 'return address', null),
      ...frame.locals.map((name) => slot('local', name, frame.values.get(name) ?? null)),
    ];
    return {
      id: frame.id,
      proc: frame.info.proc.name,
      depth: frame.info.depth,
      controlLink: frame.control?.id ?? null,
      accessLink: frame.access?.id ?? null,
      returnAddress: frame.returnAddress,
      slots,
      baseAddress: frame.base,
    };
  };

  const record = (
    event: RtEvent,
    title: string,
    explanation: string,
    accessWalk: number[] = [],
    linkHops = 0,
  ) => {
    if (++steps > RT_MAX_STEPS) {
      throw new EngineError({
        code: 'rt_too_many_steps',
        message: `This program ran for more than ${RT_MAX_STEPS} steps, so it may never finish.`,
        hint: 'Check that recursive calls reach a base case.',
      });
    }
    recorder.add(title, explanation, {
      event,
      frames: stack.map(viewFrame),
      current: stack.at(-1)?.id ?? null,
      accessWalk,
      linkHops,
      output: [...output],
    });
  };

  /** Finds a variable by walking access links outward, as compiled code for a nested language does. */
  const lookup = (frame: Frame, name: string, walk: number[]): Frame => {
    for (let at: Frame | null = frame; at; at = at.access) {
      walk.push(at.id);
      if (at.values.has(name)) return at;
    }
    throw new EngineError({
      code: 'rt_unknown_variable',
      message: `${frame.info.proc.name} uses ${name}, but no enclosing procedure declares it.`,
      hint: `Declare ${name} as a parameter or local of ${frame.info.proc.name} or a procedure around it.`,
    });
  };

  const evaluate = (text: string, frame: Frame, walk: number[]): number => {
    let ast = parsed.get(text);
    if (!ast) {
      ast = codegenParseExpr(text);
      parsed.set(text, ast);
    }
    const run = (node: CgExpr): number => {
      switch (node.kind) {
        case 'num':
          return node.value;
        case 'var': {
          const place = lookup(frame, node.name, walk);
          return place.values.get(node.name) as number;
        }
        case 'index':
          return 0;
        case 'unary':
          return vmEvalUnary(node.operator, run(node.arg));
        case 'binary': {
          const result = vmEvalBinary(node.operator, run(node.left), run(node.right));
          if (result === null) {
            throw new EngineError({
              code: 'rt_division_by_zero',
              message: `${frame.info.proc.name} divides by zero in: ${text}`,
              hint: 'Check the divisor.',
            });
          }
          return result;
        }
      }
    };
    return run(ast);
  };

  const accessLinkFor = (
    caller: Frame | null,
    callee: ProcInfo,
  ): { link: Frame | null; hops: number } => {
    if (!caller) return { link: null, hops: 0 };
    const callerDepth = caller.info.depth;
    if (callee.depth === callerDepth + 1) return { link: caller, hops: 0 };
    // The book's rule: follow callerDepth - calleeDepth + 1 links from the caller.
    const hops = callerDepth - callee.depth + 1;
    let at: Frame | null = caller;
    for (let i = 0; i < hops && at; i++) at = at.access;
    return { link: at, hops };
  };

  const callProc = (
    info: ProcInfo,
    args: number[],
    caller: Frame | null,
    returnAddress: string | null,
  ): number | null => {
    const params = info.proc.params ?? [];
    if (args.length !== params.length) {
      throw new EngineError({
        code: 'rt_wrong_arguments',
        message: `${info.proc.name} takes ${params.length} argument${params.length === 1 ? '' : 's'}, but was called with ${args.length}.`,
        hint: 'Match the call to the parameter list.',
      });
    }
    if (stack.length >= RT_MAX_CALL_DEPTH) {
      throw new EngineError({
        code: 'rt_stack_overflow',
        message: `The stack grew past ${RT_MAX_CALL_DEPTH} frames, so this recursion may never end.`,
        hint: 'Check that recursive calls reach a base case.',
      });
    }

    const locals = info.proc.locals ?? [];
    const { link, hops } = accessLinkFor(caller, info);
    const top = stack.at(-1);
    const frame: Frame = {
      id: nextFrameId++,
      info,
      values: new Map(),
      params,
      locals: locals.map(nameOfLocal),
      control: caller,
      access: link,
      returnAddress,
      returnValue: null,
      base: top ? top.base + frameSize(top) : 0,
    };
    params.forEach((name, index) => frame.values.set(name, args[index] as number));
    for (const local of locals) {
      frame.values.set(nameOfLocal(local), typeof local === 'string' ? 0 : local.value);
    }

    stack.push(frame);
    maxDepth = Math.max(maxDepth, stack.length);
    totalCalls++;

    if (caller) {
      const linkNote = !link
        ? 'It has no access link.'
        : link === caller
          ? `${info.proc.name} is nested directly inside ${caller.info.proc.name}, so its access link points at the caller's frame.`
          : `${info.proc.name} is at depth ${info.depth} and ${caller.info.proc.name} at depth ${caller.info.depth}, so follow ${hops} access link${hops === 1 ? '' : 's'} from the caller to find the frame of the enclosing procedure.`;
      record(
        'call',
        `Call ${info.proc.name}`,
        `Push a frame: parameters, then the control link to the caller's frame, then the access link, then the return address, then locals. ${linkNote}`,
        [],
        hops,
      );
    } else {
      record(
        'start',
        `Start in ${info.proc.name}`,
        'The first frame goes on the stack. The outermost procedure has no caller, so it has no control link or access link.',
      );
    }

    const result = runBody(info.proc.body, frame);
    frame.returnValue = result;
    record(
      'return',
      `Return from ${info.proc.name}`,
      `${result === null ? 'No value comes back.' : `The value ${result} goes to the return-value cell.`} The control link says which frame resumes, and the return address says where in its code.`,
    );
    stack.pop();
    return result;
  };

  const runStatement = (
    statement: RtStatement,
    frame: Frame,
    label: string,
  ): { returned: boolean; value: number | null } => {
    const proc = frame.info.proc.name;
    switch (statement.kind) {
      case 'assign': {
        const walk: number[] = [];
        const value = evaluate(statement.value, frame, walk);
        const place = lookup(frame, statement.name, walk);
        place.values.set(statement.name, value);
        const nonLocal = place !== frame;
        record(
          'assign',
          `${statement.name} = ${value}`,
          nonLocal
            ? `${statement.name} is not in this frame, so follow access links out to the frame of ${place.info.proc.name} and write it there.`
            : `Evaluate ${statement.value} and store it in this frame.`,
          walk,
        );
        return { returned: false, value: null };
      }
      case 'call': {
        const walk: number[] = [];
        const args = (statement.args ?? []).map((arg) => evaluate(arg, frame, walk));
        const callee = resolveProc(frame.info, statement.proc);
        const result = callProc(callee, args, frame, `${proc}, ${label}`);
        if (statement.assignTo) {
          const place = lookup(frame, statement.assignTo, walk);
          place.values.set(statement.assignTo, result ?? 0);
          record(
            'assign',
            `${statement.assignTo} = ${result ?? 0}`,
            `Back in ${proc}. Pop the callee's frame and copy its return value into ${statement.assignTo}.`,
            walk,
          );
        }
        return { returned: false, value: null };
      }
      case 'if': {
        const walk: number[] = [];
        const value = evaluate(statement.condition, frame, walk);
        const taken = value !== 0;
        record(
          'branch',
          `if ${statement.condition}`,
          `The condition is ${taken ? 'true' : 'false'}, so ${taken ? 'run the first branch' : statement.else ? 'run the else branch' : 'skip the branch'}.`,
          walk,
        );
        const body = taken ? statement.then : (statement.else ?? []);
        return runList(body, frame, taken ? `${label} (then)` : `${label} (else)`);
      }
      case 'return': {
        const walk: number[] = [];
        const value = statement.value === undefined ? null : evaluate(statement.value, frame, walk);
        return { returned: true, value };
      }
      case 'print': {
        const walk: number[] = [];
        const value = evaluate(statement.value, frame, walk);
        output.push(String(value));
        record('print', `print ${value}`, `Output the value of ${statement.value}.`, walk);
        return { returned: false, value: null };
      }
    }
  };

  const runList = (
    statements: readonly RtStatement[],
    frame: Frame,
    label: string,
  ): { returned: boolean; value: number | null } => {
    for (const [index, statement] of statements.entries()) {
      const place = `statement ${index + 1}`;
      const outcome = runStatement(statement, frame, label === '' ? place : `${label}, ${place}`);
      if (outcome.returned) return outcome;
    }
    return { returned: false, value: null };
  };

  const runBody = (statements: readonly RtStatement[], frame: Frame): number | null =>
    runList(statements, frame, '').value;

  callProc(rootInfo, [], null, null);
  record(
    'finish',
    'Program finished',
    `${totalCalls} activation${totalCalls === 1 ? '' : 's'} ran, and the stack was at most ${maxDepth} frame${maxDepth === 1 ? '' : 's'} deep.`,
  );

  return { output, maxDepth, totalCalls, trace: recorder.finish() };
}
