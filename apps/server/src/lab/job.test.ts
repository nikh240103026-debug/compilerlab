import type { LabEvent, LabExercise, LabJob } from '@compilerlab/shared';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeTools, type FakeTools } from './fake-tools';
import {
  checkLabJob,
  DEFAULT_LAB_LIMITS,
  missingFlexDefaults,
  runLabJob,
  type LabLimits,
} from './job';
import { realToolchain } from './toolchain';

let fake: FakeTools;
let dataDir: string;

beforeAll(() => {
  fake = createFakeTools();
});
afterAll(() => fake.dispose());
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'compilerlab-job-'));
  fake.missing.clear();
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const job = (fields: Partial<LabJob>): LabJob => ({
  pipeline: 'c',
  engine: 'auto',
  files: [],
  stdin: '',
  flags: [],
  ...fields,
});

function contextFor(
  events: LabEvent[],
  limits: Partial<LabLimits> = {},
  stop = new AbortController(),
) {
  return {
    dataDir,
    toolchain: fake.toolchain,
    limits: { ...DEFAULT_LAB_LIMITS, ...limits },
    stop: stop.signal,
    send: (event: LabEvent) => events.push(event),
    platform: 'linux' as NodeJS.Platform,
  };
}

async function run(fields: Partial<LabJob>, limits: Partial<LabLimits> = {}) {
  const events: LabEvent[] = [];
  await runLabJob(job(fields), contextFor(events, limits));
  return events;
}

const ofType = <T extends LabEvent['type']>(events: readonly LabEvent[], type: T) =>
  events.filter((event): event is Extract<LabEvent, { type: T }> => event.type === type);
const lastDone = (events: readonly LabEvent[]) => ofType(events, 'done').at(-1);
const stdoutOf = (events: readonly LabEvent[], step = 'run') =>
  ofType(events, 'output')
    .filter((event) => event.step === step && event.stream === 'stdout')
    .map((event) => event.data)
    .join('');
const stderrOf = (events: readonly LabEvent[], step = 'run') =>
  ofType(events, 'output')
    .filter((event) => event.step === step && event.stream === 'stderr')
    .map((event) => event.data)
    .join('');
const onlyRun = () => {
  const [name] = readdirSync(join(dataDir, 'runs'));
  return join(dataDir, 'runs', name as string);
};

/** "Compiled" by the fake gcc: this JavaScript becomes the program. */
const program = (code: string) => ({ name: 'main.c', content: code });

describe('the C and C++ pipelines', () => {
  it('compiles, runs with stdin and streams the output', async () => {
    const events = await run({
      files: [
        program('process.stdin.on("data",(d)=>process.stdout.write(String(d).toUpperCase()));'),
      ],
      stdin: 'hello',
    });
    expect(ofType(events, 'started')[0]).toMatchObject({ engine: 'real', note: null });
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['gcc', 'run']);
    expect(stdoutOf(events)).toBe('HELLO');
    expect(lastDone(events)).toMatchObject({ outcome: 'ok' });
  });

  it('runs each job in a new folder under data/runs with its files', async () => {
    await run({ files: [program('1'), { name: 'notes.txt', content: 'hi' }] });
    expect(readFileSync(join(onlyRun(), 'notes.txt'), 'utf8')).toBe('hi');
    await run({ files: [program('1')] });
    expect(readdirSync(join(dataDir, 'runs'))).toHaveLength(2);
  });

  it('passes the standard and flags, with -lm after the sources', async () => {
    await run({ files: [program('1')], standard: 'c11', flags: ['-Wall', '-lm', '-g'] });
    expect(JSON.parse(readFileSync(join(onlyRun(), 'gcc-args.json'), 'utf8'))).toEqual([
      '-std=c11',
      '-Wall',
      '-g',
      'main.c',
      '-o',
      'program',
      '-lm',
    ]);
  });

  it('uses g++ for C++, and compiles both kinds of source', async () => {
    const events = await run({
      pipeline: 'cpp',
      files: [
        { name: 'a.cpp', content: 'console.log("cpp")' },
        { name: 'b.c', content: 'x' },
        { name: 'c.h', content: 'x' },
      ],
    });
    expect(ofType(events, 'step')[0]).toMatchObject({ id: 'gpp', label: 'g++' });
    expect(JSON.parse(readFileSync(join(onlyRun(), 'gcc-args.json'), 'utf8'))).toEqual([
      'a.cpp',
      'b.c',
      '-o',
      'program',
    ]);
    expect(stdoutOf(events).trim()).toBe('cpp');
  });

  it('explains compile errors and does not run anything', async () => {
    const events = await run({ files: [program('COMPILE_ERROR')] });
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['gcc']);
    const { items } = ofType(events, 'diagnostics').at(-1) as Extract<
      LabEvent,
      { type: 'diagnostics' }
    >;
    expect(items[0]).toMatchObject({
      file: 'main.c',
      line: 2,
      column: 5,
      severity: 'error',
      tool: 'gcc',
    });
    expect(items[0]?.explanation).toContain('declaration of x');
    expect(items[1]?.severity).toBe('note');
    expect(lastDone(events)).toMatchObject({ outcome: 'failed' });
  });

  it('reports what to install when the compiler is missing', async () => {
    fake.missing.add('gcc');
    const events = await run({ files: [program('1')] });
    const error = ofType(events, 'error')[0];
    expect(error).toMatchObject({ code: 'missing_tool' });
    expect(error?.message).toContain('gcc');
    expect(error?.fix.join(' ')).toContain('sudo apt');
    expect(ofType(events, 'step')).toEqual([]);
  });

  it('asks for a source file when there is none', async () => {
    const events = await run({ files: [{ name: 'notes.txt', content: '' }] });
    expect(ofType(events, 'error')[0]).toMatchObject({ code: 'no_source_file' });
  });

  it('will not simulate C', async () => {
    const events = await run({ engine: 'simulated', files: [program('1')] });
    expect(ofType(events, 'error')[0]).toMatchObject({ code: 'simulated_lex_only' });
  });

  it('gives the compiler its own, longer time limit', async () => {
    const events = await run({ files: [program('COMPILE_FOREVER')] }, { buildTimeoutMs: 400 });
    expect(lastDone(events)).toMatchObject({ outcome: 'timeout' });
    expect(lastDone(events)?.message).toContain('gcc ran for');
  });
});

describe('limits on the student program', () => {
  it('stops an infinite loop', async () => {
    const events = await run({ files: [program('for(;;){}')] }, { runTimeoutMs: 400 });
    expect(lastDone(events)).toMatchObject({ outcome: 'timeout' });
    expect(lastDone(events)?.message).toContain('infinite loop');
  });

  it('stops huge output at the cap', async () => {
    const events = await run(
      { files: [program('const l="x".repeat(1000)+"\\n";for(;;)process.stdout.write(l);')] },
      { outputBytes: 20_000 },
    );
    expect(lastDone(events)).toMatchObject({ outcome: 'output_limit' });
    expect(stdoutOf(events).length).toBeLessThanOrEqual(20_000);
  });

  it('says when a program exits with an error code', async () => {
    const events = await run({ files: [program('process.exit(4)')] });
    expect(lastDone(events)).toMatchObject({ outcome: 'failed' });
    expect(lastDone(events)?.message).toContain('code 4');
  });

  it('explains a crash', async () => {
    const events = await run({
      files: [program('process.kill(process.pid, "SIGSEGV"); setTimeout(()=>{},2000)')],
    });
    // Node cannot fake a Windows access violation, which ends with exit code 1 there.
    if (process.platform !== 'win32') {
      expect(lastDone(events)).toMatchObject({ outcome: 'crashed' });
      expect(lastDone(events)?.message).toContain('Segmentation fault');
    } else {
      expect(lastDone(events)?.outcome).not.toBe('ok');
    }
  });

  it('stops when asked', async () => {
    const stop = new AbortController();
    const events: LabEvent[] = [];
    const context = contextFor(events, {}, stop);
    const running = runLabJob(job({ files: [program('setInterval(()=>{},1000)')] }), {
      ...context,
      send: (event) => {
        events.push(event);
        if (event.type === 'step' && event.id === 'run') setTimeout(() => stop.abort(), 100);
      },
    });
    await running;
    expect(lastDone(events)).toMatchObject({ outcome: 'stopped' });
  });

  it('never shows the Gemini key to a program', async () => {
    process.env.GEMINI_API_KEY = 'super-secret-value';
    try {
      const events: LabEvent[] = [];
      const toolchain = realToolchain({ flex: '', bison: '', gcc: '', gpp: '', make: '' });
      await runLabJob(job({ files: [program('console.log(JSON.stringify(process.env))')] }), {
        ...contextFor(events),
        toolchain: { ...fake.toolchain, environment: () => toolchain.environment() },
      });
      const seen = stdoutOf(events);
      expect(seen).toContain('PATH');
      expect(seen).not.toContain('super-secret-value');
      expect(seen).not.toContain('GEMINI');
      expect(JSON.parse(seen).LC_ALL).toBe('C');
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

const TRACED_PROGRAM = String.raw`%%PROGRAM
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  process.stderr.write('--accepting rule at line 3 ("abc")\n');
  process.stderr.write('--accepting default rule ("\n")\n');
  process.stderr.write('my own message\n');
  process.stderr.write('--(end of buffer or a NUL)\n--EOF (start condition 0)\n');
  process.stdout.write(s.toUpperCase());
});`;

describe('the real Lex pipeline', () => {
  const scanner = (body: string, extra = '') => ({
    name: 'scanner.l',
    content: `%option noyywrap\n%%\n[a-z]+ ;\n%%\nint main(void) { return 0; }\n${extra}${body}`,
  });

  it('runs flex, then gcc, then the program, and shows the generated file', async () => {
    const events = await run({ pipeline: 'lex', files: [scanner(TRACED_PROGRAM)], stdin: 'abc\n' });
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['flex', 'gcc', 'run']);
    expect(JSON.parse(readFileSync(join(onlyRun(), 'flex-args.json'), 'utf8'))).toEqual([
      '-d',
      'scanner.l',
    ]);
    expect(ofType(events, 'generated')[0]?.files.map((file) => file.name)).toEqual(['lex.yy.c']);
    expect(stdoutOf(events)).toBe('ABC\n');
  });

  it('turns the scanner debug output into a token stream and hides it from the student', async () => {
    const events = await run({ pipeline: 'lex', files: [scanner(TRACED_PROGRAM)], stdin: 'abc\n' });
    expect(ofType(events, 'tokens')[0]).toMatchObject({
      matches: [
        { ruleLine: 3, text: 'abc' },
        { ruleLine: null, text: '\n' },
      ],
      truncated: false,
      rules: [{ line: 3, text: '[a-z]+' }],
    });
    expect(stderrOf(events)).toBe('my own message\n');
  });

  it('adds yywrap and main when the file does not bring its own', async () => {
    const events = await run({
      pipeline: 'lex',
      files: [{ name: 'a.l', content: `%%\n[a-z]+ ;\n${TRACED_PROGRAM}` }],
    });
    const defaults = ofType(events, 'generated')[0]?.files.find((f) => f.name === 'lab_defaults.c');
    expect(defaults?.content).toContain('int yywrap(void)');
    expect(defaults?.content).toContain('int main(void)');
    expect(JSON.parse(readFileSync(join(onlyRun(), 'gcc-args.json'), 'utf8'))).toEqual([
      'lex.yy.c',
      'lab_defaults.c',
      '-o',
      'program',
    ]);
  });

  it('compiles extra C files with the scanner', async () => {
    await run({
      pipeline: 'lex',
      files: [scanner(TRACED_PROGRAM), { name: 'table.c', content: '' }],
    });
    expect(JSON.parse(readFileSync(join(onlyRun(), 'gcc-args.json'), 'utf8'))).toEqual([
      'lex.yy.c',
      'table.c',
      '-o',
      'program',
    ]);
  });

  it('explains flex errors and stops there', async () => {
    const events = await run({ pipeline: 'lex', files: [scanner('FLEX_ERROR')] });
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['flex']);
    expect(ofType(events, 'diagnostics').at(-1)?.items[0]).toMatchObject({
      file: 'scanner.l',
      line: 3,
      tool: 'flex',
    });
    expect(ofType(events, 'diagnostics').at(-1)?.items[0]?.explanation).toContain('pattern');
    expect(lastDone(events)).toMatchObject({ outcome: 'failed' });
  });

  it('keeps flex warnings and drops warnings about generated code', async () => {
    const events = await run({
      pipeline: 'lex',
      files: [scanner(`FLEX_WARNING\n${TRACED_PROGRAM}\n// COMPILE_WARNING`)],
    });
    const items = ofType(events, 'diagnostics').at(-1)?.items ?? [];
    expect(items.map((item) => item.message)).toEqual([
      'rule cannot be matched',
      "unused variable 'q' [-Wunused-variable]",
    ]);
    expect(lastDone(events)).toMatchObject({ outcome: 'ok' });
  });

  it('sends what the visualizer needs, even for rules it cannot show', async () => {
    const events = await run({
      pipeline: 'lex',
      files: [scanner(TRACED_PROGRAM)],
      stdin: 'code',
    });
    expect(ofType(events, 'visual')[0]).toMatchObject({
      rules: 'RULE_3  [a-z]+  %skip',
      source: 'code',
      omitted: [],
    });
  });

  it('says so when the teaching engine cannot read a file real flex accepted', async () => {
    const events = await run({
      pipeline: 'lex',
      files: [{ name: 'a.l', content: `no sections here ${TRACED_PROGRAM}` }],
    });
    const visual = ofType(events, 'visual')[0];
    expect(visual?.rules).toBeNull();
    expect(visual?.omitted[0]).toContain('could not read');
    expect(stdoutOf(events)).toBeDefined();
  });

  it.each([
    [[], 'no_lex_file'],
    [
      [
        { name: 'a.l', content: '' },
        { name: 'b.l', content: '' },
      ],
      'many_lex_files',
    ],
  ])('asks for exactly one .l file', async (files, code) => {
    const events = await run({ pipeline: 'lex', files });
    expect(ofType(events, 'error')[0]).toMatchObject({ code });
  });
});

describe('Simulated mode', () => {
  const counter = {
    name: 'count.l',
    content: String.raw`%{
int n = 0;
%}
%option noyywrap
%%
[a-z]+   { n++; printf("[%s]", yytext); }
.|\n     ;
%%
int main(void) { yylex(); printf(" %d\n", n); return 0; }
`,
  };

  it('takes over when flex is missing, and says so', async () => {
    fake.missing.add('flex');
    const events = await run({ pipeline: 'lex', files: [counter], stdin: 'ab cd' });
    const started = ofType(events, 'started')[0];
    expect(started?.engine).toBe('simulated');
    expect(started?.note).toContain('flex was not found');
    expect(stdoutOf(events)).toBe('[ab][cd] 2\n');
    expect(lastDone(events)).toMatchObject({ outcome: 'ok' });
    expect(existsSync(join(dataDir, 'runs'))).toBe(false);
  });

  it('names every missing tool', async () => {
    fake.missing.add('flex');
    fake.missing.add('gcc');
    const events = await run({ pipeline: 'lex', files: [counter] });
    expect(ofType(events, 'started')[0]?.note).toContain('flex and gcc were not found');
  });

  it('can be chosen even when the tools are there', async () => {
    const events = await run({ pipeline: 'lex', engine: 'simulated', files: [counter] });
    expect(ofType(events, 'started')[0]?.engine).toBe('simulated');
    expect(ofType(events, 'started')[0]?.note).toContain('You chose');
  });

  it('reports the same token stream shape as a real run', async () => {
    const events = await run({
      pipeline: 'lex',
      engine: 'simulated',
      files: [counter],
      stdin: 'a!',
    });
    expect(ofType(events, 'tokens')[0]).toMatchObject({
      matches: [
        { ruleLine: 6, text: 'a' },
        { ruleLine: 7, text: '!' },
      ],
      rules: [
        { line: 6, text: '[a-z]+' },
        { line: 7, text: '.|\\n' },
      ],
    });
  });

  it('marks mistakes in the file', async () => {
    const bad = { name: 'a.l', content: '%%\n[a-z ;\n' };
    const events = await run({ pipeline: 'lex', engine: 'simulated', files: [bad] });
    const item = ofType(events, 'diagnostics').at(-1)?.items[0];
    expect(item).toMatchObject({
      file: 'a.l',
      line: 2,
      column: 1,
      tool: 'mini-Lex',
      severity: 'error',
    });
    expect(item?.explanation).toContain('"]"');
    expect(lastDone(events)).toMatchObject({ outcome: 'failed' });
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['flex']);
  });

  it('marks runtime mistakes with their line', async () => {
    const bad = {
      name: 'a.l',
      content: '%%\na ;\n%%\nint main() {\n  int z = 0;\n  return 1 / z;\n}\n',
    };
    const events = await run({ pipeline: 'lex', engine: 'simulated', files: [bad] });
    expect(ofType(events, 'diagnostics').at(-1)?.items[0]).toMatchObject({
      line: 6,
      tool: 'mini-C',
    });
    expect(lastDone(events)).toMatchObject({ outcome: 'crashed' });
  });

  const forever = {
    name: 'a.l',
    content: '%%\na ;\n%%\nint main() { for (;;) { } return 0; }\n',
  };

  it('stops an infinite loop', async () => {
    const events = await run(
      { pipeline: 'lex', engine: 'simulated', files: [forever] },
      { runTimeoutMs: 200 },
    );
    expect(lastDone(events)).toMatchObject({ outcome: 'timeout' });
  });

  it('stays responsive during an infinite loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await run({ pipeline: 'lex', engine: 'simulated', files: [forever] }, { runTimeoutMs: 300 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5);
  });

  it('stops when asked', async () => {
    const stop = new AbortController();
    const events: LabEvent[] = [];
    setTimeout(() => stop.abort(), 100);
    await runLabJob(
      job({ pipeline: 'lex', engine: 'simulated', files: [forever] }),
      contextFor(events, {}, stop),
    );
    expect(lastDone(events)).toMatchObject({ outcome: 'stopped' });
  });

  it('stops huge output at the cap', async () => {
    const loud = {
      name: 'a.l',
      content: '%%\na ;\n%%\nint main() { for (;;) printf("xxxxxxxxxx"); return 0; }\n',
    };
    const events = await run(
      { pipeline: 'lex', engine: 'simulated', files: [loud] },
      { outputBytes: 1000 },
    );
    expect(lastDone(events)).toMatchObject({ outcome: 'output_limit' });
    expect(stdoutOf(events).length).toBe(1000);
  });

  it('reports a nonzero exit', async () => {
    const quits = { name: 'a.l', content: '%%\na ;\n%%\nint main() { exit(2); return 0; }\n' };
    const events = await run({ pipeline: 'lex', engine: 'simulated', files: [quits] });
    expect(lastDone(events)).toMatchObject({ outcome: 'failed' });
    expect(lastDone(events)?.message).toContain('code 2');
  });

  it('caps the token list', async () => {
    const events = await run({
      pipeline: 'lex',
      engine: 'simulated',
      files: [{ name: 'a.l', content: '%%\na ;\n' }],
      stdin: 'a'.repeat(6000),
    });
    const tokens = ofType(events, 'tokens')[0];
    expect(tokens?.matches.length).toBe(5000);
    expect(tokens?.truncated).toBe(true);
  });
});

describe('checking an exercise', () => {
  const exercise: LabExercise = {
    id: 'upper',
    module: 'lexical-analysis',
    topics: ['lex-and-flex'],
    order: 1,
    title: 'Upper',
    difficulty: 'easy',
    tags: ['t'],
    exams: ['university'],
    brief: 'b',
    pipeline: 'lex',
    stdin: '',
    tests: [
      { name: 'Seen', input: 'ab\n', expected: 'AB\n', hidden: false },
      { name: 'Secret', input: 'SECRET-INPUT', expected: 'SECRET-INPUT', hidden: true },
    ],
    hints: ['h', 'i'],
    explanation: 'e',
    files: [],
    solution: [],
  };
  const upper = {
    name: 'a.l',
    content: String.raw`%option noyywrap
%%
[a-z]  { putchar(toupper(yytext[0])); }
.|\n   { ECHO; }
%%
int main(void) { yylex(); return 0; }
`,
  };

  async function check(file: { name: string; content: string }, simulated = true) {
    const events: LabEvent[] = [];
    const passed = await checkLabJob(
      job({ pipeline: 'lex', engine: simulated ? 'simulated' : 'auto', files: [file] }),
      exercise,
      contextFor(events),
    );
    return { passed, events, result: ofType(events, 'check')[0] };
  }

  it('passes when every test matches, ignoring line endings', async () => {
    const { passed, result, events } = await check(upper);
    expect(passed).toBe(true);
    expect(result?.passed).toBe(true);
    expect(lastDone(events)?.message).toBe('All 2 tests passed.');
  });

  it('shows visible tests and keeps hidden ones secret', async () => {
    const wrong = {
      name: 'a.l',
      content:
        '%option noyywrap\n%%\n.|\\n { printf("?"); }\n%%\nint main(void) { yylex(); return 0; }\n',
    };
    const { passed, result, events } = await check(wrong);
    expect(passed).toBe(false);
    expect(result?.results[0]).toMatchObject({
      name: 'Seen',
      passed: false,
      input: 'ab\n',
      expected: 'AB\n',
      actual: '???',
    });
    expect(result?.results[1]).toEqual({
      name: 'Secret',
      hidden: true,
      passed: false,
      outcome: 'ok',
    });
    expect(JSON.stringify(events)).not.toContain('SECRET-INPUT');
    expect(lastDone(events)?.message).toBe('0 of 2 tests passed.');
  });

  it('does not stream output while testing', async () => {
    const { events } = await check(upper);
    expect(ofType(events, 'output')).toEqual([]);
  });

  it('fails when the file does not build', async () => {
    const { passed, result } = await check({ name: 'a.l', content: '%%\n[ ;\n' });
    expect(passed).toBe(false);
    expect(result).toBeUndefined();
  });

  it('runs the real tools once and each test separately', async () => {
    const real = {
      name: 'a.l',
      content: `%option noyywrap\n%%\na ;\n%%\nint main(void) { return 0; }\n%%PROGRAM
        let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write(s.toLowerCase()==='ab\\n'?'AB\\n':s));`,
    };
    const { passed, events } = await check(real, false);
    expect(ofType(events, 'step').map((step) => step.id)).toEqual(['flex', 'gcc', 'tests']);
    expect(passed).toBe(true);
  });

  it('stops part way through when asked', async () => {
    const stop = new AbortController();
    const events: LabEvent[] = [];
    const looping = {
      name: 'a.l',
      content: '%%\na ;\n%%\nint main() { for (;;) { } return 0; }\n',
    };
    setTimeout(() => stop.abort(), 100);
    const passed = await checkLabJob(
      job({ pipeline: 'lex', engine: 'simulated', files: [looping] }),
      exercise,
      contextFor(events, {}, stop),
    );
    expect(passed).toBe(false);
    expect(lastDone(events)).toMatchObject({ outcome: 'stopped', message: 'Stopped.' });
  });
});

describe('missingFlexDefaults', () => {
  it('finds what a file needs', () => {
    expect(missingFlexDefaults('%%\na ;\n')).toEqual({ yywrap: true, main: true });
    expect(missingFlexDefaults('%option noyywrap\n%%\n')).toEqual({ yywrap: false, main: true });
    expect(missingFlexDefaults('%option yylineno noyywrap\n%%\n').yywrap).toBe(false);
    expect(missingFlexDefaults('%%\n%%\nint yywrap() { return 1; }').yywrap).toBe(false);
    expect(missingFlexDefaults('%%\n%%\nint main(void) { return 0; }').main).toBe(false);
  });
});
