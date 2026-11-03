import {
  attempt,
  compileScanner,
  EngineError,
  flexToPlayground,
  locateOffset,
  parseFlexFile,
  runScanner,
  Utf8Decoder,
  type CompiledScanner,
} from '@compilerlab/engine';
import {
  LAB_LIMITS,
  normalizeOutput,
  type LabCheckResult,
  type LabDiagnostic,
  type LabEngine,
  type LabEvent,
  type LabExercise,
  type LabFile,
  type LabGeneratedFile,
  type LabJob,
  type LabOutcome,
  type LabPipeline,
  type LabStream,
  type LabTokenMatch,
} from '@compilerlab/shared';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { toolFix } from '../../../../scripts/lib/checks.mjs';
import { explainMessage, parseDiagnostics } from './diagnostics';
import { FlexTraceFilter } from './flex-trace';
import { describeCrash, runProcess } from './process';
import { createRunDirectory, sweepRuns, writeRunFiles } from './runs';
import type { LabToolchain, LabToolId, ToolCommand } from './toolchain';

export interface LabLimits {
  runTimeoutMs: number;
  buildTimeoutMs: number;
  outputBytes: number;
  memoryBytes: number;
}

export const DEFAULT_LAB_LIMITS: LabLimits = {
  runTimeoutMs: LAB_LIMITS.runTimeoutMs,
  buildTimeoutMs: LAB_LIMITS.buildTimeoutMs,
  outputBytes: LAB_LIMITS.outputBytes,
  memoryBytes: LAB_LIMITS.memoryBytes,
};

export interface JobContext {
  dataDir: string;
  toolchain: LabToolchain;
  limits: LabLimits;
  stop: AbortSignal;
  send: (event: LabEvent) => void;
  platform?: NodeJS.Platform;
}

interface RunResult {
  outcome: LabOutcome;
  exitCode: number | null;
  message: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Something that was built and can be run on any input, as many times as needed. */
interface BuiltProgram {
  run(stdin: string, stream: boolean): Promise<RunResult>;
  tokens(): { matches: LabTokenMatch[]; truncated: boolean } | null;
  ruleTexts: { line: number; text: string }[];
  visual: { rules: string | null; omitted: string[] } | null;
}

const SOURCE_EXTENSION = /\.(c|cpp)$/i;

function limitMessage(
  outcome: LabOutcome,
  limits: LabLimits,
  what = 'Your program',
): string | null {
  switch (outcome) {
    case 'timeout':
      return `${what} ran for ${limits.runTimeoutMs / 1000} seconds and was stopped. An infinite loop is the usual cause.`;
    case 'output_limit':
      return `${what} printed more than ${Math.round(limits.outputBytes / (1024 * 1024))} MB, so it was stopped. A loop that never ends is the usual cause.`;
    case 'memory_limit':
      return `${what} used more than ${Math.round(limits.memoryBytes / (1024 * 1024))} MB of memory, so it was stopped.`;
    case 'stopped':
      return 'Stopped.';
    default:
      return null;
  }
}

function positionDiagnostic(
  source: string,
  file: string,
  error: EngineError,
  tool: string,
): LabDiagnostic {
  const { message, hint, position } = error.info;
  const where = position === undefined ? null : locateOffset(source, position);
  return {
    file: where ? file : null,
    line: where?.line ?? null,
    column: where?.column ?? null,
    severity: 'error',
    tool,
    message,
    explanation: hint ?? explainMessage('gcc', message),
  };
}

/** Whether a .l file brings its own yywrap and main, which libfl would otherwise provide. */
export function missingFlexDefaults(source: string): { yywrap: boolean; main: boolean } {
  return {
    yywrap: !/%option[^\n]*\bnoyywrap\b/.test(source) && !/\byywrap\s*\(/.test(source),
    main: !/\bmain\s*\(/.test(source),
  };
}

/**
 * libfl is hard to install on some systems, so its two small functions are generated when the
 * .l file needs them. A .l file that works with -lfl works here too.
 */
function flexDefaultsSource(needs: { yywrap: boolean; main: boolean }): string | null {
  if (!needs.yywrap && !needs.main) return null;
  const parts = ['/* Written by CompilerLab, in place of linking with -lfl. */'];
  if (needs.yywrap) parts.push('int yywrap(void) { return 1; }');
  if (needs.main) {
    parts.push('int yylex(void);', 'int main(void) { while (yylex() != 0) { } return 0; }');
  }
  return `${parts.join('\n')}\n`;
}

async function readGenerated(directory: string, name: string): Promise<LabGeneratedFile | null> {
  try {
    const file = await open(join(directory, name), 'r');
    try {
      const limit = LAB_LIMITS.generatedFileBytes;
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
      return {
        name,
        content: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'),
        truncated: bytesRead > limit,
      };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

class Job {
  private readonly diagnostics: LabDiagnostic[] = [];

  constructor(
    private readonly request: LabJob,
    private readonly context: JobContext,
  ) {}

  private get limits(): LabLimits {
    return this.context.limits;
  }

  private send(event: LabEvent): void {
    this.context.send(event);
  }

  private addDiagnostics(items: readonly LabDiagnostic[]): void {
    if (items.length === 0) return;
    this.diagnostics.push(...items);
    this.send({ type: 'diagnostics', items: [...this.diagnostics] });
  }

  private flexFile(): LabFile | null {
    const files = this.request.files.filter((file) => /\.l$/i.test(file.name));
    if (files.length === 1) return files[0] as LabFile;
    this.send({
      type: 'error',
      code: files.length === 0 ? 'no_lex_file' : 'many_lex_files',
      message:
        files.length === 0
          ? 'The Lex pipeline needs a .l file, and this workspace has none.'
          : `The Lex pipeline uses one .l file, and this workspace has ${files.length}.`,
      hint: files.length === 0 ? 'Add a file ending in .l.' : 'Keep one, or rename the others.',
      fix: [],
    });
    return null;
  }

  private toolsFor(pipeline: LabPipeline): { id: LabToolId; label: string }[] {
    if (pipeline === 'lex') {
      return [
        { id: 'flex', label: 'flex' },
        { id: 'gcc', label: 'gcc' },
      ];
    }
    return pipeline === 'c' ? [{ id: 'gcc', label: 'gcc' }] : [{ id: 'gpp', label: 'g++' }];
  }

  /** Decides between real tools and Simulated mode. Null means this job cannot run at all. */
  private async chooseEngine(): Promise<
    | { engine: 'real'; tools: Map<LabToolId, ToolCommand> }
    | { engine: 'simulated'; note: string }
    | null
  > {
    const { pipeline, engine } = this.request;
    if (engine === 'simulated') {
      if (pipeline === 'lex') {
        return {
          engine: 'simulated',
          note: 'You chose Simulated mode. This did not use real flex or gcc.',
        };
      }
      this.send({
        type: 'error',
        code: 'simulated_lex_only',
        message: 'Simulated mode only runs Lex programs. C and C++ programs need a real compiler.',
        hint: 'Install gcc and g++ with the commands below.',
        fix: toolFix(['gcc', 'g++'], this.context.platform ?? process.platform),
      });
      return null;
    }
    const wanted = this.toolsFor(pipeline);
    const found = await Promise.all(wanted.map(({ id }) => this.context.toolchain.find(id)));
    const missing = wanted.filter((_, index) => !found[index]).map(({ label }) => label);
    if (missing.length === 0) {
      return {
        engine: 'real',
        tools: new Map(wanted.map(({ id }, index) => [id, found[index] as ToolCommand])),
      };
    }
    if (pipeline === 'lex') {
      return {
        engine: 'simulated',
        note: `${missing.join(' and ')} ${missing.length === 1 ? 'was' : 'were'} not found, so this ran in the built-in teaching engine, not the real tools.`,
      };
    }
    this.send({
      type: 'error',
      code: 'missing_tool',
      message: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} needed to compile this, and ${missing.length === 1 ? 'was' : 'were'} not found.`,
      hint: 'Simulated mode only covers Lex programs. Install the compiler with the commands below, or set its path in Settings.',
      fix: toolFix(missing, this.context.platform ?? process.platform),
    });
    return null;
  }

  // ---- Real tools ----

  private async runStep(
    id: string,
    label: string,
    tool: ToolCommand,
    args: readonly string[],
    directory: string,
    timeoutMs: number,
  ): Promise<RunResult> {
    this.send({ type: 'step', id, label, command: [label, ...args].join(' ') });
    let stdout = '';
    let stderr = '';
    const result = await runProcess({
      command: tool.command,
      args: [...tool.prefixArgs, ...args],
      cwd: directory,
      env: this.jobEnvironment(directory),
      timeoutMs,
      outputBytes: this.limits.outputBytes,
      memoryBytes: null,
      stop: this.context.stop,
      onOutput: (stream, data) => {
        if (stream === 'stdout') stdout += data;
        else stderr += data;
        this.send({ type: 'output', step: id, stream, data });
      },
    });
    const message =
      result.outcome === 'missing_tool'
        ? `${label} could not be started: ${result.startError}`
        : limitMessage(result.outcome, this.limits, label);
    this.send({
      type: 'step-end',
      step: id,
      outcome: result.outcome,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      message,
    });
    return { ...result, message, stdout, stderr };
  }

  private jobEnvironment(directory: string): NodeJS.ProcessEnv {
    // Compilers put their temporary files here, so a sweep cleans those up too.
    return {
      ...this.context.toolchain.environment(),
      TMP: directory,
      TEMP: directory,
      TMPDIR: directory,
    };
  }

  private finishBuild(result: RunResult, message: string): void {
    this.send({ type: 'done', outcome: result.outcome, message: result.message ?? message });
  }

  private async buildReal(tools: Map<LabToolId, ToolCommand>): Promise<BuiltProgram | null> {
    const { pipeline, files, flags, standard } = this.request;
    const directory = await createRunDirectory(this.context.dataDir);
    await writeRunFiles(directory, files);

    const linkOnly = flags.filter((flag) => flag === '-lm');
    const compileFlags = flags.filter((flag) => flag !== '-lm');
    const std = standard ? [`-std=${standard}`] : [];
    const generated: LabGeneratedFile[] = [];
    let sources: string[];
    let flexSource: LabFile | null = null;

    if (pipeline === 'lex') {
      flexSource = this.flexFile();
      if (!flexSource) return null;
      // -d makes the scanner report each match, which is how the token stream is real.
      const flex = await this.runStep(
        'flex',
        'flex',
        tools.get('flex') as ToolCommand,
        ['-d', flexSource.name],
        directory,
        this.limits.buildTimeoutMs,
      );
      this.addDiagnostics(parseDiagnostics('flex', flex.stdout + flex.stderr));
      if (flex.outcome !== 'ok') {
        this.finishBuild(flex, 'flex could not read this file. The Build log tab explains why.');
        return null;
      }
      const scanner = await readGenerated(directory, 'lex.yy.c');
      if (scanner) generated.push(scanner);
      const defaults = flexDefaultsSource(missingFlexDefaults(flexSource.content));
      sources = ['lex.yy.c', ...files.filter((file) => /\.c$/i.test(file.name)).map((f) => f.name)];
      if (defaults) {
        await writeRunFiles(directory, [{ name: 'lab_defaults.c', content: defaults }]);
        sources.push('lab_defaults.c');
        generated.push({ name: 'lab_defaults.c', content: defaults, truncated: false });
      }
      this.send({ type: 'generated', files: generated });
    } else {
      sources = files
        .filter((file) => (pipeline === 'c' ? /\.c$/i : SOURCE_EXTENSION).test(file.name))
        .map((file) => file.name);
      if (sources.length === 0) {
        this.send({
          type: 'error',
          code: 'no_source_file',
          message: `The ${pipeline === 'c' ? 'C' : 'C++'} pipeline needs a ${pipeline === 'c' ? '.c' : '.cpp'} file, and this workspace has none.`,
          hint: 'Add one, or choose a different pipeline.',
          fix: [],
        });
        return null;
      }
    }

    const compilerId: LabToolId = pipeline === 'cpp' ? 'gpp' : 'gcc';
    const compilerLabel = pipeline === 'cpp' ? 'g++' : 'gcc';
    const compile = await this.runStep(
      compilerId,
      compilerLabel,
      tools.get(compilerId) as ToolCommand,
      [...std, ...compileFlags, ...sources, '-o', 'program', ...linkOnly],
      directory,
      this.limits.buildTimeoutMs,
    );
    this.addDiagnostics(parseDiagnostics(compilerLabel, compile.stdout + compile.stderr));
    if (compile.outcome !== 'ok') {
      this.finishBuild(compile, 'The code did not compile. The Build log tab explains why.');
      return null;
    }

    const program = this.context.toolchain.program(directory);
    const isLex = pipeline === 'lex';
    let lastFilter: FlexTraceFilter | null = null;
    const file = flexSource ? attempt(() => parseFlexFile(flexSource.content)) : null;
    return {
      ruleTexts: file?.ok ? file.value.rules.map(({ line, text }) => ({ line, text })) : [],
      visual: !isLex
        ? null
        : file?.ok
          ? flexToPlayground(file.value)
          : {
              rules: null,
              omitted: [
                file && !file.ok
                  ? `The teaching engine could not read this file: ${file.error.message}`
                  : 'The teaching engine could not read this file.',
              ],
            },
      tokens: () =>
        lastFilter ? { matches: lastFilter.matches, truncated: lastFilter.truncated } : null,
      run: async (stdin, stream) => {
        if (isLex) lastFilter = new FlexTraceFilter();
        return await this.runCompiled(program, directory, stdin, stream, lastFilter);
      },
    };
  }

  private async runCompiled(
    program: ToolCommand,
    directory: string,
    stdin: string,
    stream: boolean,
    filter: FlexTraceFilter | null,
  ): Promise<RunResult> {
    if (stream) this.send({ type: 'step', id: 'run', label: 'Run', command: './program < input' });
    let stdout = '';
    let stderr = '';
    const result = await runProcess({
      command: program.command,
      args: program.prefixArgs,
      cwd: directory,
      env: this.jobEnvironment(directory),
      stdin,
      timeoutMs: this.limits.runTimeoutMs,
      outputBytes: this.limits.outputBytes,
      memoryBytes: this.limits.memoryBytes,
      stop: this.context.stop,
      ...(filter ? { filterStderr: filter } : {}),
      onOutput: (name, data) => {
        if (name === 'stdout') stdout += data;
        else stderr += data;
        if (stream) this.send({ type: 'output', step: 'run', stream: name, data });
      },
    });
    const message =
      result.outcome === 'crashed'
        ? describeCrash(result.exitCode, result.signal)
        : result.outcome === 'failed'
          ? `Your program exited with code ${result.exitCode}.`
          : result.outcome === 'missing_tool'
            ? `The program could not be started: ${result.startError}`
            : limitMessage(result.outcome, this.limits);
    if (stream) {
      this.send({
        type: 'step-end',
        step: 'run',
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        message,
      });
    }
    return {
      outcome: result.outcome,
      exitCode: result.exitCode,
      message,
      stdout,
      stderr,
      durationMs: result.durationMs,
    };
  }

  // ---- Simulated mode ----

  private buildSimulated(): BuiltProgram | null {
    const flexSource = this.flexFile();
    if (!flexSource) return null;
    const started = performance.now();
    this.send({
      type: 'step',
      id: 'flex',
      label: 'Read the scanner',
      command: `built-in mini-Lex: ${flexSource.name}`,
    });
    let scanner: CompiledScanner;
    try {
      scanner = compileScanner(flexSource.content);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      const diagnostic = positionDiagnostic(flexSource.content, flexSource.name, error, 'mini-Lex');
      this.addDiagnostics([diagnostic]);
      this.send({
        type: 'step-end',
        step: 'flex',
        outcome: 'failed',
        exitCode: 1,
        durationMs: Math.round(performance.now() - started),
        message: diagnostic.message,
      });
      this.send({
        type: 'done',
        outcome: 'failed',
        message: 'This file could not be read. The Build log tab explains why.',
      });
      return null;
    }
    this.send({
      type: 'step-end',
      step: 'flex',
      outcome: 'ok',
      exitCode: 0,
      durationMs: Math.round(performance.now() - started),
      message: null,
    });

    let matches: LabTokenMatch[] = [];
    let truncated = false;
    return {
      ruleTexts: scanner.file.rules.map(({ line, text }) => ({ line, text })),
      visual: flexToPlayground(scanner.file),
      tokens: () => ({ matches, truncated }),
      run: async (stdin, stream) => {
        matches = [];
        truncated = false;
        return await this.runSimulated(scanner, flexSource, stdin, stream, (match) => {
          if (matches.length >= LAB_LIMITS.tokens) truncated = true;
          else matches.push(match);
        });
      },
    };
  }

  private async runSimulated(
    scanner: CompiledScanner,
    file: LabFile,
    stdin: string,
    stream: boolean,
    onMatch: (match: LabTokenMatch) => void,
  ): Promise<RunResult> {
    const started = performance.now();
    if (stream) {
      this.send({ type: 'step', id: 'run', label: 'Run', command: 'built-in scanner < input' });
    }
    const decoders: Record<LabStream, Utf8Decoder> = {
      stdout: new Utf8Decoder(),
      stderr: new Utf8Decoder(),
    };
    const collected: Record<LabStream, string> = { stdout: '', stderr: '' };
    const batches: Record<LabStream, string> = { stdout: '', stderr: '' };
    let written = 0;
    const flush = () => {
      for (const name of ['stdout', 'stderr'] as const) {
        if (batches[name] && stream) {
          this.send({ type: 'output', step: 'run', stream: name, data: batches[name] });
        }
        batches[name] = '';
      }
    };
    const steps = runScanner(scanner, stdin, {
      write: (name, bytes) => {
        if (written >= this.limits.outputBytes) return;
        const room = this.limits.outputBytes - written;
        const allowed = bytes.length <= room ? bytes : bytes.slice(0, room);
        written += allowed.length;
        const text = decoders[name].write(allowed);
        collected[name] += text;
        batches[name] += text;
      },
      onMatch,
    });

    const deadline = started + this.limits.runTimeoutMs;
    let outcome: LabOutcome = 'ok';
    let exitCode: number | null = null;
    let message: string | null = null;
    try {
      // Small slices of work, so Stop and everything else on the server stay responsive.
      for (let done = false; !done;) {
        const sliceEnd = performance.now() + 10;
        do {
          for (let i = 0; i < 500 && !done; i++) {
            const state = steps.next();
            if (state.done) {
              exitCode = state.value;
              done = true;
            }
          }
        } while (!done && performance.now() < sliceEnd && written < this.limits.outputBytes);
        flush();
        if (done) break;
        const reason = this.context.stop.aborted
          ? 'stopped'
          : written >= this.limits.outputBytes
            ? 'output_limit'
            : performance.now() > deadline
              ? 'timeout'
              : null;
        if (reason) {
          outcome = reason;
          message = limitMessage(reason, this.limits);
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (outcome === 'ok' && exitCode !== 0 && exitCode !== null) {
        outcome = 'failed';
        message = `Your program exited with code ${exitCode}.`;
      }
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      outcome = 'crashed';
      const diagnostic = positionDiagnostic(file.content, file.name, error, 'mini-C');
      message = diagnostic.message;
      if (stream) this.addDiagnostics([diagnostic]);
    }
    for (const name of ['stdout', 'stderr'] as const) {
      const rest = decoders[name].flush();
      collected[name] += rest;
      batches[name] += rest;
    }
    flush();
    const durationMs = Math.round(performance.now() - started);
    if (stream) {
      this.send({ type: 'step-end', step: 'run', outcome, exitCode, durationMs, message });
    }
    return { outcome, exitCode, message, ...collected, durationMs };
  }

  // ---- The two kinds of job ----

  private async build(): Promise<{ program: BuiltProgram; engine: LabEngine } | null> {
    await sweepRuns(this.context.dataDir);
    const choice = await this.chooseEngine();
    if (!choice) return null;
    this.send({
      type: 'started',
      engine: choice.engine,
      pipeline: this.request.pipeline,
      note: choice.engine === 'simulated' ? choice.note : null,
    });
    const program =
      choice.engine === 'simulated' ? this.buildSimulated() : await this.buildReal(choice.tools);
    return program ? { program, engine: choice.engine } : null;
  }

  private sendVisual(program: BuiltProgram, stdin: string): void {
    if (!program.visual) return;
    this.send({
      type: 'visual',
      rules: program.visual.rules,
      source: stdin,
      omitted: program.visual.omitted,
    });
  }

  private sendTokens(program: BuiltProgram): void {
    const tokens = program.tokens();
    if (tokens) {
      this.send({ type: 'tokens', ...tokens, rules: program.ruleTexts });
    }
  }

  async runOnce(): Promise<void> {
    const built = await this.build();
    if (!built) return;
    const { program } = built;
    this.sendVisual(program, this.request.stdin);
    const result = await program.run(this.request.stdin, true);
    this.sendTokens(program);
    this.send({
      type: 'done',
      outcome: result.outcome,
      message: result.message ?? 'Finished.',
    });
  }

  /** Builds once, then runs every test. Returns whether they all passed. */
  async check(exercise: LabExercise): Promise<boolean> {
    const built = await this.build();
    if (!built) return false;
    const { program } = built;
    const results: LabCheckResult[] = [];
    this.send({
      type: 'step',
      id: 'tests',
      label: 'Run the tests',
      command: `${exercise.tests.length} tests`,
    });
    const started = performance.now();
    let stopped = false;
    for (const test of exercise.tests) {
      const result = await program.run(test.input, false);
      if (result.outcome === 'stopped') {
        stopped = true;
        break;
      }
      const passed =
        result.outcome === 'ok' &&
        normalizeOutput(result.stdout) === normalizeOutput(test.expected);
      results.push({
        name: test.name,
        hidden: test.hidden,
        passed,
        outcome: result.outcome,
        ...(test.hidden
          ? {}
          : { input: test.input, expected: test.expected, actual: result.stdout }),
      });
    }
    const passed = !stopped && results.every((result) => result.passed);
    this.send({
      type: 'step-end',
      step: 'tests',
      outcome: stopped ? 'stopped' : passed ? 'ok' : 'failed',
      exitCode: null,
      durationMs: Math.round(performance.now() - started),
      message: null,
    });
    this.send({ type: 'check', results, passed });
    const count = results.filter((result) => result.passed).length;
    this.send({
      type: 'done',
      outcome: stopped ? 'stopped' : passed ? 'ok' : 'failed',
      message: stopped
        ? 'Stopped.'
        : passed
          ? `All ${results.length} tests passed.`
          : `${count} of ${results.length} tests passed.`,
    });
    return passed;
  }
}

export function runLabJob(job: LabJob, context: JobContext): Promise<void> {
  return new Job(job, context).runOnce();
}

export function checkLabJob(
  job: LabJob,
  exercise: LabExercise,
  context: JobContext,
): Promise<boolean> {
  return new Job(job, context).check(exercise);
}
