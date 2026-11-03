import { loadLabExercises } from '@compilerlab/content';
import type { LabEvent, LabJob } from '@compilerlab/shared';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../config';
import { removeTestFolder } from './fake-tools';
import { checkLabJob, DEFAULT_LAB_LIMITS, runLabJob } from './job';
import { realToolchain } from './toolchain';

function installed(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasLexTools = installed('flex') && installed('gcc');
const hasGcc = installed('gcc');
const hasGpp = installed('g++');

const rootDir = findRepoRoot(import.meta.dirname);
const dataDir = mkdtempSync(join(tmpdir(), 'compilerlab-real-tools-'));
afterAll(() => removeTestFolder(dataDir), 15_000);

const toolchain = realToolchain({ flex: '', bison: '', gcc: '', gpp: '', make: '' });

function contextFor(events: LabEvent[]) {
  return {
    dataDir,
    toolchain,
    limits: DEFAULT_LAB_LIMITS,
    stop: new AbortController().signal,
    send: (event: LabEvent) => events.push(event),
  };
}

async function run(job: LabJob) {
  const events: LabEvent[] = [];
  await runLabJob(job, contextFor(events));
  return events;
}

const job = (fields: Partial<LabJob>): LabJob => ({
  pipeline: 'c',
  engine: 'auto',
  files: [],
  stdin: '',
  flags: [],
  ...fields,
});
const ofType = <T extends LabEvent['type']>(events: readonly LabEvent[], type: T) =>
  events.filter((event): event is Extract<LabEvent, { type: T }> => event.type === type);
const stdoutOf = (events: readonly LabEvent[]) =>
  ofType(events, 'output')
    .filter((event) => event.step === 'run' && event.stream === 'stdout')
    .map((event) => event.data)
    .join('');

/**
 * These run the real flex, gcc and g++, and skip themselves when those are not installed. They
 * are what proves the stand-in tools in job.test.ts behave like the real ones.
 */
describe.skipIf(!hasLexTools)('real flex and gcc', () => {
  const { exercises } = loadLabExercises(join(rootDir, 'packages', 'content'));

  it.each(exercises.map((exercise) => [exercise.id, exercise] as const))(
    'the %s solution passes all of its tests',
    async (_id, exercise) => {
      const events: LabEvent[] = [];
      const passed = await checkLabJob(
        job({ pipeline: exercise.pipeline, files: exercise.solution }),
        exercise,
        contextFor(events),
      );
      expect(ofType(events, 'started')[0]?.engine).toBe('real');
      expect(ofType(events, 'check')[0]?.results.filter((result) => !result.passed)).toEqual([]);
      expect(passed).toBe(true);
    },
    60_000,
  );

  const counter = {
    name: 'count.l',
    content: String.raw`%option noyywrap
%%
[a-z]+   { printf("[%s]", yytext); }
.|\n     { }
%%
int main(void) { yylex(); return 0; }
`,
  };

  it('shows the generated scanner and reports a true token stream', async () => {
    const events = await run(job({ pipeline: 'lex', files: [counter], stdin: 'ab cd\n' }));
    expect(stdoutOf(events)).toBe('[ab][cd]');
    expect(ofType(events, 'generated')[0]?.files[0]?.name).toBe('lex.yy.c');
    expect(ofType(events, 'generated')[0]?.files[0]?.content).toContain('yylex');
    expect(ofType(events, 'tokens')[0]?.matches).toEqual([
      { ruleLine: 3, text: 'ab' },
      { ruleLine: 4, text: ' ' },
      { ruleLine: 3, text: 'cd' },
      { ruleLine: 4, text: '\n' },
    ]);
    // The scanner's debug chatter never reaches the student.
    const stderr = ofType(events, 'output').filter(
      (event) => event.step === 'run' && event.stream === 'stderr',
    );
    expect(stderr).toEqual([]);
  }, 60_000);

  it('links without libfl when a file has no main or yywrap', async () => {
    const events = await run(
      job({
        pipeline: 'lex',
        files: [{ name: 'a.l', content: '%%\na printf("yes");\n' }],
        stdin: 'a',
      }),
    );
    expect(stdoutOf(events)).toBe('yes');
    expect(ofType(events, 'done').at(-1)?.outcome).toBe('ok');
  }, 60_000);

  it('accepts a yywrap the student wrote', async () => {
    const content =
      '%%\na printf("yes");\n%%\nint yywrap(void) { return 1; }\nint main(void) { yylex(); return 0; }\n';
    const events = await run(
      job({ pipeline: 'lex', files: [{ name: 'a.l', content }], stdin: 'a' }),
    );
    expect(stdoutOf(events)).toBe('yes');
  }, 60_000);

  it('points flex errors at the .l file', async () => {
    const events = await run(
      job({ pipeline: 'lex', files: [{ name: 'a.l', content: '%%\n[a-z ;\n' }] }),
    );
    const item = ofType(events, 'diagnostics').at(-1)?.items[0];
    expect(item?.file).toBe('a.l');
    expect(item?.line).toBeGreaterThan(0);
  }, 60_000);

  it('points errors in an action at the .l file, not lex.yy.c', async () => {
    const content =
      '%option noyywrap\n%%\na { undeclared_name = 1; }\n%%\nint main(void) { return yylex(); }\n';
    const events = await run(job({ pipeline: 'lex', files: [{ name: 'a.l', content }] }));
    const item = ofType(events, 'diagnostics')
      .at(-1)
      ?.items.find((candidate) => candidate.severity === 'error');
    expect(item).toMatchObject({ file: 'a.l', line: 3 });
    expect(item?.explanation).toContain('undeclared_name');
  }, 60_000);
});

describe.skipIf(!hasGcc)('real gcc', () => {
  it('compiles and runs C with stdin', async () => {
    const content =
      '#include <stdio.h>\nint main(void) { int c; while ((c = getchar()) != EOF) putchar(c + 1); return 0; }\n';
    const events = await run(
      job({
        files: [{ name: 'a.c', content }],
        stdin: 'HAL',
        standard: 'c11',
        flags: ['-Wall', '-lm'],
      }),
    );
    expect(stdoutOf(events)).toBe('IBM');
  }, 60_000);

  it('reads real compiler errors', async () => {
    const content = 'int main(void) {\n  return nope\n}\n';
    const events = await run(job({ files: [{ name: 'a.c', content }] }));
    const items = ofType(events, 'diagnostics').at(-1)?.items ?? [];
    expect(
      items.some((item) => item.file === 'a.c' && item.line === 2 && item.severity === 'error'),
    ).toBe(true);
    expect(items.some((item) => item.explanation)).toBe(true);
  }, 60_000);

  it('reads a real linker error', async () => {
    const content = 'void missing(void);\nint main(void) { missing(); return 0; }\n';
    const events = await run(job({ files: [{ name: 'a.c', content }] }));
    const items = ofType(events, 'diagnostics').at(-1)?.items ?? [];
    expect(items.some((item) => item.tool === 'linker' && item.message.includes('missing'))).toBe(
      true,
    );
  }, 60_000);

  it('explains a real crash', async () => {
    const content = 'int main(void) { volatile int *p = 0; *p = 1; return 0; }\n';
    const events = await run(job({ files: [{ name: 'a.c', content }] }));
    expect(ofType(events, 'done').at(-1)?.outcome).toBe('crashed');
  }, 60_000);

  it('stops a real infinite loop at the time limit', async () => {
    const content = 'int main(void) { for (;;) { } }\n';
    const events = await run(job({ files: [{ name: 'a.c', content }] }));
    expect(ofType(events, 'done').at(-1)?.outcome).toBe('timeout');
  }, 60_000);
});

describe.skipIf(!hasGpp)('real g++', () => {
  it('compiles and runs C++', async () => {
    const content = '#include <iostream>\nint main() { std::cout << "hi"; return 0; }\n';
    const events = await run(
      job({ pipeline: 'cpp', files: [{ name: 'a.cpp', content }], standard: 'c++17' }),
    );
    expect(stdoutOf(events)).toBe('hi');
  }, 60_000);
});

it('runs or skips the real-tool tests as this machine allows', () => {
  expect(typeof hasLexTools).toBe('boolean');
});
