import { codegenFormatExpr, codegenParseExpr, type CgExpr } from '../codegen/expr';
import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { vmEvalBinary, vmEvalUnary } from '../vm/arith';

export type RtParamMode = 'value' | 'reference' | 'copy-restore' | 'name';

export const RT_PARAM_MODES: readonly RtParamMode[] = [
  'value',
  'reference',
  'copy-restore',
  'name',
];

const MAX_BODY_STATEMENTS = 50;

/** The same small program runs under each mode. Statements and arguments are text. */
export interface RtParamProgram {
  /** The caller's scalar variables. */
  variables: Record<string, number>;
  /** The caller's arrays, indexed from 0. */
  arrays?: Record<string, number[]>;
  procedure: {
    name: string;
    params: string[];
    /** Locals of the procedure, starting at 0. */
    locals?: string[];
    /** Assignments, like: temp = x   or   a[i] = temp */
    body: string[];
  };
  /** The arguments of the one call, like: i, a[i] */
  args: string[];
}

/** The classic: swap by name swaps the wrong cell, because a[i] is re-evaluated after i changes. */
export const RT_PARAM_SAMPLE_SWAP: RtParamProgram = {
  variables: { i: 1 },
  arrays: { a: [10, 2, 30] },
  procedure: {
    name: 'swap',
    params: ['x', 'y'],
    locals: ['temp'],
    body: ['temp = x', 'x = y', 'y = temp'],
  },
  args: ['i', 'a[i]'],
};

/** Separates reference from copy-restore: the copy written back at return overwrites a's new value. */
export const RT_PARAM_SAMPLE_ALIAS: RtParamProgram = {
  variables: { a: 1 },
  procedure: { name: 'q', params: ['x'], body: ['x = 2', 'a = 0'] },
  args: ['a'],
};

export interface RtParamBinding {
  param: string;
  how: 'copy' | 'location' | 'thunk';
  /** The memory place bound, for location binding and for copy-restore's copy back. */
  location: string | null;
  /** The argument text, re-evaluated at each use under call by name. */
  expression: string | null;
}

export interface RtParamState {
  mode: RtParamMode;
  phase: 'call' | 'statement' | 'restore' | 'done';
  /** Index into the procedure's body, when running a statement. */
  statement: number | null;
  variables: Record<string, number>;
  arrays: Record<string, number[]>;
  /** Cells that belong to this activation: locals and copied parameters. */
  locals: Record<string, number>;
  bindings: RtParamBinding[];
  /** Places read and written in this step, so a display can highlight them. */
  reads: string[];
  writes: string[];
}

export interface RtParamRun {
  mode: RtParamMode;
  finalVariables: Record<string, number>;
  finalArrays: Record<string, number[]>;
  trace: Trace<RtParamState>;
}

export interface RtParamComparison {
  /** One run per mode, in RT_PARAM_MODES order. */
  runs: RtParamRun[];
  /** Plain-language final state of each mode. */
  summary: { mode: RtParamMode; result: string }[];
}

interface Assignment {
  target: CgExpr & { kind: 'var' | 'index' };
  value: CgExpr;
  text: string;
}

function parseBody(body: readonly string[]): Assignment[] {
  if (body.length > MAX_BODY_STATEMENTS) {
    throw new EngineError({
      code: 'rt_param_too_long',
      message: `This procedure has more than ${MAX_BODY_STATEMENTS} statements.`,
      hint: 'Try a shorter procedure.',
    });
  }
  return body.map((text) => {
    const match = /^(.*?[^=!<>])=(?!=)(.*)$/.exec(text);
    if (!match) {
      throw new EngineError({
        code: 'rt_param_bad_statement',
        message: `"${text}" is not an assignment.`,
        hint: 'Write statements like: x = y + 1',
      });
    }
    const target = codegenParseExpr(match[1] as string, { allowIndex: true });
    if (target.kind !== 'var' && target.kind !== 'index') {
      throw new EngineError({
        code: 'rt_param_bad_statement',
        message: `"${(match[1] as string).trim()}" cannot be assigned to.`,
        hint: 'Assign to a name or an array cell.',
      });
    }
    return {
      target,
      value: codegenParseExpr(match[2] as string, { allowIndex: true }),
      text: text.trim(),
    };
  });
}

type Place = { kind: 'var'; name: string } | { kind: 'cell'; name: string; index: number };

const showPlace = (place: Place) =>
  place.kind === 'var' ? place.name : `${place.name}[${place.index}]`;

/** Runs the program once under one mode. */
function runMode(
  program: RtParamProgram,
  mode: RtParamMode,
  body: readonly Assignment[],
): RtParamRun {
  const variables = { ...program.variables };
  const arrays = Object.fromEntries(
    Object.entries(program.arrays ?? {}).map(([name, values]) => [name, [...values]]),
  );
  const locals: Record<string, number> = {};
  const { params } = program.procedure;
  const args = program.args.map((text) => codegenParseExpr(text, { allowIndex: true }));
  if (args.length !== params.length) {
    throw new EngineError({
      code: 'rt_param_wrong_arguments',
      message: `${program.procedure.name} takes ${params.length} argument${params.length === 1 ? '' : 's'}, but the call passes ${args.length}.`,
      hint: 'Match the call to the parameter list.',
    });
  }
  for (const name of program.procedure.locals ?? []) locals[name] = 0;

  const places = new Map<string, Place>();
  const thunks = new Map<string, CgExpr>();
  const bindings: RtParamBinding[] = [];
  const reads: string[] = [];
  const writes: string[] = [];

  const readPlace = (place: Place): number => {
    reads.push(showPlace(place));
    if (place.kind === 'var') {
      const value = variables[place.name];
      if (value === undefined) {
        throw new EngineError({
          code: 'rt_param_unknown_variable',
          message: `${place.name} is not declared.`,
          hint: `Add ${place.name} to the program's variables.`,
        });
      }
      return value;
    }
    const array = arrays[place.name];
    if (!array) {
      throw new EngineError({
        code: 'rt_param_unknown_array',
        message: `${place.name} is not a declared array.`,
        hint: `Add ${place.name} to the program's arrays.`,
      });
    }
    const value = array[place.index];
    if (value === undefined) {
      throw new EngineError({
        code: 'rt_param_bad_index',
        message: `${showPlace(place)} is outside the array, which has ${array.length} cells.`,
        hint: `Valid indexes run from 0 to ${array.length - 1}.`,
      });
    }
    return value;
  };

  const writePlace = (place: Place, value: number): void => {
    readPlace(place); // Checks that the place exists, with the same readable errors.
    reads.pop();
    writes.push(showPlace(place));
    if (place.kind === 'var') variables[place.name] = value;
    else (arrays[place.name] as number[])[place.index] = value;
  };

  /** Evaluates in the caller's scope: thunks and arguments never see the callee's locals. */
  const placeInCaller = (node: CgExpr): Place | null => {
    if (node.kind === 'var') return { kind: 'var', name: node.name };
    if (node.kind === 'index')
      return { kind: 'cell', name: node.name, index: evalIn(node.index, false) };
    return null;
  };

  const evalIn = (node: CgExpr, inCallee: boolean): number => {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'var': {
        if (inCallee) {
          const name = node.name;
          const thunk = thunks.get(name);
          if (thunk) return evalIn(thunk, false);
          const place = places.get(name);
          if (place) return readPlace(place);
          if (Object.hasOwn(locals, name)) {
            reads.push(name);
            return locals[name] as number;
          }
        }
        return readPlace({ kind: 'var', name: node.name });
      }
      case 'index':
        return readPlace({ kind: 'cell', name: node.name, index: evalIn(node.index, inCallee) });
      case 'unary':
        return vmEvalUnary(node.operator, evalIn(node.arg, inCallee));
      case 'binary': {
        const result = vmEvalBinary(
          node.operator,
          evalIn(node.left, inCallee),
          evalIn(node.right, inCallee),
        );
        if (result === null) {
          throw new EngineError({
            code: 'rt_param_division_by_zero',
            message: `This divides by zero: ${codegenFormatExpr(node)}`,
            hint: 'Check the divisor.',
          });
        }
        return result;
      }
    }
  };

  const recorder = new TraceRecorder<RtParamState>();
  const record = (
    phase: RtParamState['phase'],
    statement: number | null,
    title: string,
    explanation: string,
  ) => {
    recorder.add(title, explanation, {
      mode,
      phase,
      statement,
      variables: { ...variables },
      arrays: Object.fromEntries(
        Object.entries(arrays).map(([name, values]) => [name, [...values]]),
      ),
      locals: { ...locals },
      bindings: [...bindings],
      reads: [...reads],
      writes: [...writes],
    });
    reads.length = 0;
    writes.length = 0;
  };

  const restores: { param: string; place: Place }[] = [];
  params.forEach((param, index) => {
    const arg = args[index] as CgExpr;
    const text = program.args[index] as string;
    if (mode === 'name') {
      thunks.set(param, arg);
      bindings.push({ param, how: 'thunk', location: null, expression: text });
      record(
        'call',
        null,
        `${param} stands for ${text}`,
        `Call by name passes no value. Each use of ${param} acts as if the text ${text} were written there, and is evaluated in the caller's scope at that moment.`,
      );
      return;
    }
    if (mode === 'value') {
      locals[param] = evalIn(arg, false);
      bindings.push({ param, how: 'copy', location: null, expression: null });
      record(
        'call',
        null,
        `${param} = ${locals[param]}`,
        `Call by value evaluates ${text} and copies the result into ${param}. The procedure cannot change the caller's variable through ${param}.`,
      );
      return;
    }
    const place = placeInCaller(arg);
    if (mode === 'reference') {
      if (place) {
        places.set(param, place);
        bindings.push({ param, how: 'location', location: showPlace(place), expression: null });
        record(
          'call',
          null,
          `${param} refers to ${showPlace(place)}`,
          `Call by reference works out which cell ${text} means right now and passes its address. From here on, ${param} is another name for ${showPlace(place)}.`,
        );
      } else {
        locals[param] = evalIn(arg, false);
        bindings.push({ param, how: 'copy', location: null, expression: null });
        record(
          'call',
          null,
          `${param} refers to a temporary`,
          `${text} is not a variable, so it is computed into a temporary cell, and ${param} refers to that. Changes to it are lost at return.`,
        );
      }
      return;
    }
    locals[param] = evalIn(arg, false);
    if (place) {
      restores.push({ param, place });
      bindings.push({ param, how: 'copy', location: showPlace(place), expression: null });
      record(
        'call',
        null,
        `${param} = ${locals[param]}, from ${showPlace(place)}`,
        `Copy-restore copies in ${text} now, and also remembers the cell ${showPlace(place)}, so the final value can be copied back at return.`,
      );
    } else {
      bindings.push({ param, how: 'copy', location: null, expression: null });
      record(
        'call',
        null,
        `${param} = ${locals[param]}`,
        `${text} is not a variable, so there is nowhere to copy back to at return.`,
      );
    }
  });

  body.forEach(({ target, value, text }, index) => {
    const result = evalIn(value, true);
    let where: string;
    if (target.kind === 'var' && thunks.has(target.name)) {
      const thunk = thunks.get(target.name) as CgExpr;
      const place = placeInCaller(thunk);
      if (!place) {
        throw new EngineError({
          code: 'rt_param_bad_name_target',
          message: `${target.name} stands for ${codegenFormatExpr(thunk)}, which cannot be assigned to.`,
          hint: 'Under call by name, an assigned parameter must stand for a variable or array cell.',
        });
      }
      writePlace(place, result);
      where = `${target.name} stands for ${codegenFormatExpr(thunk)}, which means ${showPlace(place)} right now`;
    } else if (target.kind === 'var' && places.has(target.name)) {
      const place = places.get(target.name) as Place;
      writePlace(place, result);
      where = `${target.name} refers to ${showPlace(place)}`;
    } else if (target.kind === 'var' && Object.hasOwn(locals, target.name)) {
      locals[target.name] = result;
      writes.push(target.name);
      where = `${target.name} is this activation's own cell`;
    } else {
      const place: Place =
        target.kind === 'var'
          ? { kind: 'var', name: target.name }
          : { kind: 'cell', name: target.name, index: evalIn(target.index, true) };
      writePlace(place, result);
      where = `${showPlace(place)} is the caller's own variable`;
    }
    record(
      'statement',
      index,
      text,
      `The right side evaluates to ${result}. ${where}, so that is where the value goes.`,
    );
  });

  for (const { param, place } of restores) {
    writePlace(place, locals[param] as number);
    record(
      'restore',
      null,
      `${showPlace(place)} = ${locals[param]}`,
      `At return, copy-restore writes the final value of ${param} back to the cell remembered at the call.`,
    );
  }
  record(
    'done',
    null,
    'Back in the caller',
    'The call is over. Compare the final values across the modes.',
  );

  return { mode, finalVariables: variables, finalArrays: arrays, trace: recorder.finish() };
}

function showFinal(run: RtParamRun): string {
  const parts = [
    ...Object.entries(run.finalVariables).map(([name, value]) => `${name} = ${value}`),
    ...Object.entries(run.finalArrays).map(([name, values]) => `${name} = [${values.join(', ')}]`),
  ];
  return parts.join(', ');
}

/** Runs the same program under value, reference, copy-restore and name. */
export function rtParamCompare(program: RtParamProgram = RT_PARAM_SAMPLE_SWAP): RtParamComparison {
  const body = parseBody(program.procedure.body);
  const runs = RT_PARAM_MODES.map((mode) => runMode(program, mode, body));
  return {
    runs,
    summary: runs.map((run) => ({ mode: run.mode, result: showFinal(run) })),
  };
}
