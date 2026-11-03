// Zod-free so the lab page can use these without the validator in its bundle.

export const LAB_LIMITS = {
  /** Wall-clock limit for the student's program. */
  runTimeoutMs: 5000,
  /** Compilers get longer, because g++ alone can take seconds on a slow disk. */
  buildTimeoutMs: 30_000,
  outputBytes: 1024 * 1024,
  memoryBytes: 256 * 1024 * 1024,
  fileBytes: 256 * 1024,
  stdinBytes: 256 * 1024,
  files: 20,
  /** Longer generated files are cut off before they reach the browser. */
  generatedFileBytes: 512 * 1024,
  /** How many matches the token stream keeps. */
  tokens: 5000,
} as const;

/** Lex + Yacc arrives with the bison pipeline in Milestone 5. */
export const LAB_PIPELINES = ['lex', 'c', 'cpp'] as const;
export type LabPipeline = (typeof LAB_PIPELINES)[number];

export const LAB_PIPELINE_LABELS: Readonly<Record<LabPipeline, string>> = {
  lex: 'Lex (flex, gcc, run)',
  c: 'C (gcc, run)',
  cpp: 'C++ (g++, run)',
};

/** "auto" uses the real tools when they are installed. */
export const LAB_ENGINES = ['auto', 'simulated'] as const;
export type LabEngineChoice = (typeof LAB_ENGINES)[number];
export type LabEngine = 'real' | 'simulated';

export const C_STANDARDS = ['c89', 'c99', 'c11', 'c17', 'gnu17'] as const;
export const CPP_STANDARDS = ['c++11', 'c++14', 'c++17', 'c++20'] as const;

/** Only these reach the compiler, so a flag can never write outside the run folder. */
export const COMPILER_FLAGS = ['-Wall', '-Wextra', '-pedantic', '-g', '-O1', '-O2', '-lm'] as const;
export type CompilerFlag = (typeof COMPILER_FLAGS)[number];

export interface LabFile {
  name: string;
  content: string;
}

export interface LabJob {
  pipeline: LabPipeline;
  engine: LabEngineChoice;
  files: LabFile[];
  stdin: string;
  /** Leaving this out uses the compiler's default. */
  standard?: string | undefined;
  flags: CompilerFlag[];
}

export type LabClientMessage =
  | { type: 'run'; job: LabJob }
  | { type: 'check'; exerciseId: string; job: LabJob }
  | { type: 'stop' };

export type LabOutcome =
  | 'ok'
  | 'failed'
  | 'crashed'
  | 'timeout'
  | 'output_limit'
  | 'memory_limit'
  | 'stopped'
  | 'missing_tool';

export type LabStream = 'stdout' | 'stderr';

export interface LabDiagnostic {
  /** The file as the student named it, or null for errors with no location. */
  file: string | null;
  line: number | null;
  column: number | null;
  severity: 'error' | 'warning' | 'note';
  tool: string;
  message: string;
  /** What this means in plain English, when the message is one we recognize. */
  explanation: string | null;
}

export interface LabGeneratedFile {
  name: string;
  content: string;
  truncated: boolean;
}

/** One rule firing. A null line is flex's default rule, which echoes an unmatched character. */
export interface LabTokenMatch {
  ruleLine: number | null;
  text: string;
}

export interface LabCheckResult {
  name: string;
  hidden: boolean;
  passed: boolean;
  outcome: LabOutcome;
  /** Left out for hidden tests, so they stay hidden. */
  input?: string;
  expected?: string;
  actual?: string;
}

export type LabEvent =
  | { type: 'started'; engine: LabEngine; pipeline: LabPipeline; note: string | null }
  | { type: 'step'; id: string; label: string; command: string }
  | { type: 'output'; step: string; stream: LabStream; data: string }
  | {
      type: 'step-end';
      step: string;
      outcome: LabOutcome;
      exitCode: number | null;
      durationMs: number;
      message: string | null;
    }
  | { type: 'diagnostics'; items: LabDiagnostic[] }
  | { type: 'generated'; files: LabGeneratedFile[] }
  | {
      type: 'tokens';
      matches: LabTokenMatch[];
      truncated: boolean;
      /** The pattern on each rule's line, to label the matches. */
      rules: { line: number; text: string }[];
    }
  /** What the Visual trace tab replays in the engine. Null rules means it could not be built. */
  | { type: 'visual'; rules: string | null; source: string; omitted: string[] }
  | { type: 'check'; results: LabCheckResult[]; passed: boolean }
  | { type: 'done'; outcome: LabOutcome; message: string }
  | { type: 'error'; code: string; message: string; hint: string | null; fix: string[] };

/** A lab exercise as the browser sees it: no solution, and no hidden tests. */
export interface LabExerciseView {
  id: string;
  module: string;
  topics: string[];
  order: number;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  brief: string;
  pipeline: LabPipeline;
  stdin: string;
  files: LabFile[];
  tests: { name: string; input: string; expected: string }[];
  hiddenTestCount: number;
  hints: string[];
}

export interface LabSolution {
  files: LabFile[];
  explanation: string;
}

export interface LabProgress {
  exerciseId: string;
  passedAt: string;
}

/** Workspaces are saved under an exercise id, or under this one for free practice. */
export const SCRATCH_WORKSPACE = 'scratch';

export interface LabWorkspace {
  files: LabFile[];
  stdin: string;
  pipeline: LabPipeline;
}

const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const FILE_EXTENSIONS = new Set(['l', 'y', 'c', 'cpp', 'h', 'hpp', 'txt', 'in']);
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** The tools write these, so a student's file with the same name would be overwritten. */
const GENERATED_NAMES = new Set(['lex.yy.c', 'y.tab.c', 'y.tab.h', 'y.output', 'lab_defaults.c']);

/**
 * Why this file name cannot be used, or null if it is fine. File names are a plain name and an
 * extension, so a name can never climb out of the run folder or reach a Windows device.
 */
export function labFileNameProblem(name: string): string | null {
  if (!FILE_NAME.test(name) || name.includes('..')) {
    return 'Use letters, digits, dots, dashes and underscores, with no folders.';
  }
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!FILE_EXTENSIONS.has(extension)) {
    return 'Use one of these endings: .l .y .c .cpp .h .hpp .txt .in';
  }
  if (WINDOWS_DEVICE.test(name)) return 'Windows reserves that name. Please choose another.';
  if (GENERATED_NAMES.has(name.toLowerCase())) {
    return 'The tools write a file with that name. Please choose another.';
  }
  return null;
}

/** Output comparison ignores line endings and spaces at the ends of lines. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}
