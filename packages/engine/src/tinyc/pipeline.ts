import { EngineError, type EngineErrorInfo } from '../core/result';
import type { Trace } from '../core/trace';
import type { VmProgram } from '../vm/assembler';
import { vmAssemble } from '../vm/assembler';
import { vmExecute, type VmSnapshot } from '../vm/run';
import type { TinyProgram } from './ast';
import { tinycAstTree, type TinyAstNode } from './ast-view';
import { tinycCodegen, type TinyCodegenResult } from './codegen';
import { tinycGenerateIr, type TinyIr } from './ir';
import { tinycLex, type TinyToken } from './lexer';
import { tinycOptimize, type TinyOptimized, type TinyOptimizeOptions } from './optimizer';
import { tinycParse } from './parser';
import { tinycCheck, type TinySemanticResult } from './semantic';

/** Generous, so recursion can go deep before it runs into the stack limit. */
export const TINYC_DEFAULT_MEMORY = 65_536;

export const TINYC_STAGES = [
  { id: 'lexer', label: 'Lexer' },
  { id: 'parser', label: 'Parser' },
  { id: 'ast', label: 'AST' },
  { id: 'semantic', label: 'Semantic checks' },
  { id: 'ir', label: 'IR (three-address code)' },
  { id: 'optimizer', label: 'Optimizer' },
  { id: 'codegen', label: 'Code generation' },
  { id: 'vm', label: 'VM' },
] as const;

export type TinyStageId = (typeof TINYC_STAGES)[number]['id'];

export interface TinyCompileOptions extends TinyOptimizeOptions {
  /** Turn off to run the code exactly as the IR stage generated it. On by default. */
  optimize?: boolean;
}

export interface TinyCompileResult {
  source: string;
  tokens: TinyToken[];
  ast: TinyProgram;
  astTree: TinyAstNode;
  semantic: TinySemanticResult;
  /** The code as first generated, with a source range for each instruction. */
  ir: TinyIr;
  /** The code after optimizing. The same as ir, in shape, when optimize is off. */
  optimized: TinyOptimized;
  /** Assembly generated from the optimized code. */
  codegen: TinyCodegenResult;
  /** The assembled program, ready for vmExecute. */
  program: VmProgram;
}

function compileAll(
  source: string,
  options: TinyCompileOptions,
  onStage: (id: TinyStageId, part: Partial<TinyCompileResult>) => void,
): TinyCompileResult {
  const tokens = tinycLex(source);
  onStage('lexer', { source, tokens });
  const ast = tinycParse(tokens);
  onStage('parser', { ast });
  const astTree = tinycAstTree(ast);
  onStage('ast', { astTree });
  const semantic = tinycCheck(ast);
  onStage('semantic', { semantic });
  const ir = tinycGenerateIr(semantic);
  onStage('ir', { ir });
  const optimized: TinyOptimized =
    options.optimize === false
      ? { functions: ir.functions.map((fn) => ({ ...fn, pipeline: null })) }
      : tinycOptimize(ir, options);
  onStage('optimizer', { optimized });
  const codegen = tinycCodegen(optimized);
  onStage('codegen', { codegen });
  const program = vmAssemble(codegen.assembly);
  onStage('vm', { program });
  return { source, tokens, ast, astTree, semantic, ir, optimized, codegen, program };
}

/** Runs all the stages and returns each one's result. A bad program throws an EngineError. */
export function compileTinyC(source: string, options: TinyCompileOptions = {}): TinyCompileResult {
  return compileAll(source, options, () => {});
}

export interface TinyStageReport {
  id: TinyStageId;
  label: string;
  status: 'ok' | 'failed' | 'not-reached';
}

export interface TinyStagesResult {
  stages: TinyStageReport[];
  /** Everything from the stages that finished. */
  partial: Partial<TinyCompileResult>;
  /** Why compilation stopped, if it did. */
  error: EngineErrorInfo | null;
}

/** Like compileTinyC, but a bad program comes back as data showing how far it got. */
export function tinycCompileStages(
  source: string,
  options: TinyCompileOptions = {},
): TinyStagesResult {
  const finished = new Set<TinyStageId>();
  let partial: Partial<TinyCompileResult> = {};
  let error: EngineErrorInfo | null = null;
  try {
    compileAll(source, options, (id, part) => {
      finished.add(id);
      partial = { ...partial, ...part };
    });
  } catch (caught) {
    if (!(caught instanceof EngineError)) throw caught;
    error = caught.info;
  }
  let failureShown = false;
  const stages = TINYC_STAGES.map(({ id, label }): TinyStageReport => {
    if (finished.has(id)) return { id, label, status: 'ok' };
    if (error && !failureShown) {
      failureShown = true;
      return { id, label, status: 'failed' };
    }
    return { id, label, status: 'not-reached' };
  });
  return { stages, partial, error };
}

export interface TinyRunOptions extends TinyCompileOptions {
  maxSteps?: number;
  maxTraceSteps?: number;
  memorySize?: number;
}

export interface TinyExecution {
  /** What the program printed, one entry per print, up to any error. */
  output: string[];
  steps: number;
  /** VM snapshots for the player. Their positions refer to the generated assembly. */
  trace: Trace<VmSnapshot>;
  traceTruncated: boolean;
  /** Null when the program ran to the end. The position is in the TinyC source. */
  error: EngineErrorInfo | null;
}

function lineOf(source: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Optimized code has lost its link to the source, so a runtime error is located by running the
 * plain IR version, which keeps a source range per instruction. Optimizing does not change what a
 * program does, so that version stops at the same place in the source.
 */
function sourceSpanOf(
  compiled: TinyCompileResult,
  options: TinyRunOptions,
  code: string,
): { position: number; length: number } {
  const plain = tinycCodegen(compiled.ir);
  const run = vmExecute(vmAssemble(plain.assembly), {
    memorySize: options.memorySize ?? TINYC_DEFAULT_MEMORY,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    maxTraceSteps: 0,
  });
  const fallback = { position: 0, length: 1 };
  if (run.error?.code !== code || run.errorPc === null) return fallback;
  const place = plain.instructionMap[run.errorPc];
  if (!place) return fallback;
  const fn = compiled.ir.functions.find((candidate) => candidate.name === place.function);
  const span =
    place.tacIndex >= 0
      ? fn?.spans[place.tacIndex]
      : compiled.ast.functions.find((candidate) => candidate.name === place.function);
  return span ? { position: span.position, length: Math.max(span.length, 1) } : fallback;
}

/** Runs a compiled program. A runtime error comes back in the result, with its source position. */
export function tinycExecute(
  compiled: TinyCompileResult,
  options: TinyRunOptions = {},
): TinyExecution {
  const result = vmExecute(compiled.program, {
    memorySize: options.memorySize ?? TINYC_DEFAULT_MEMORY,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxTraceSteps === undefined ? {} : { maxTraceSteps: options.maxTraceSteps }),
  });

  let error: EngineErrorInfo | null = null;
  if (result.error) {
    const span = sourceSpanOf(compiled, options, result.error.code);
    // The VM's message points at an assembly line. The student wrote TinyC, so point at that.
    const message = result.error.message.replace(/^Line \d+ \(.*?\): /, '');
    error = {
      ...result.error,
      message: `Line ${lineOf(compiled.source, span.position)}: ${message}`,
      ...span,
    };
  }

  return {
    output: result.output,
    steps: result.steps,
    trace: result.trace,
    traceTruncated: result.traceTruncated,
    error,
  };
}

export interface TinyRunResult extends TinyExecution {
  compiled: TinyCompileResult;
}

/** Compiles and runs. Any error, at compile time or at run time, throws an EngineError. */
export function runTinyC(source: string, options: TinyRunOptions = {}): TinyRunResult {
  const compiled = compileTinyC(source, options);
  const execution = tinycExecute(compiled, options);
  if (execution.error) throw new EngineError(execution.error);
  return { ...execution, compiled };
}
