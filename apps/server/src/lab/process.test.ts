import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeCrash, readProcessMemory, runProcess } from './process';

const directory = mkdtempSync(join(tmpdir(), 'compilerlab-process-'));
// A background child from one test may still be using this folder for a moment on Windows.
afterAll(() =>
  rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }),
);

function runNode(
  code: string,
  overrides: Partial<Parameters<typeof runProcess>[0]> = {},
): ReturnType<typeof runProcess> & { output: { stdout: string; stderr: string } } {
  const output = { stdout: '', stderr: '' };
  const promise = runProcess({
    command: process.execPath,
    args: ['-e', code],
    cwd: directory,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    timeoutMs: 15_000,
    outputBytes: 1024 * 1024,
    memoryBytes: null,
    stop: new AbortController().signal,
    onOutput: (stream, data) => {
      output[stream] += data;
    },
    ...overrides,
  });
  return Object.assign(promise, { output });
}

describe('runProcess', () => {
  it('runs a program and collects both streams', async () => {
    const run = runNode('console.log("out"); console.error("err");');
    const result = await run;
    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(run.output.stdout.trim()).toBe('out');
    expect(run.output.stderr.trim()).toBe('err');
  });

  it('passes stdin and closes it, so a program reading input does not hang', async () => {
    const run = runNode(
      'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.toUpperCase()));',
      { stdin: 'hello' },
    );
    expect((await run).outcome).toBe('ok');
    expect(run.output.stdout.trim()).toBe('HELLO');
  });

  it('closes stdin even with no input', async () => {
    const run = runNode('process.stdin.on("data",()=>{}).on("end",()=>console.log("eof"));');
    expect((await run).outcome).toBe('ok');
    expect(run.output.stdout.trim()).toBe('eof');
  });

  it('reports a failing exit code', async () => {
    const result = await runNode('process.exit(3)');
    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('stops an infinite loop at the time limit', async () => {
    const started = Date.now();
    const result = await runNode('for (;;) {}', { timeoutMs: 400 });
    expect(result.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a process that ignores termination signals', async () => {
    const result = await runNode(
      'process.on("SIGTERM",()=>{}); process.on("SIGINT",()=>{}); for (;;) {}',
      { timeoutMs: 400 },
    );
    expect(result.outcome).toBe('timeout');
  });

  it('kills the whole process tree on timeout', async () => {
    const pidFile = join(directory, 'grandchild.pid');
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);`;
    const result = await runNode(script, { timeoutMs: 1200 });
    expect(result.outcome).toBe('timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);

  it('stops huge output at the cap and does not keep it all', async () => {
    const run = runNode(
      'const line = "x".repeat(1000) + "\\n"; for (;;) process.stdout.write(line);',
      {
        outputBytes: 50_000,
        timeoutMs: 10_000,
      },
    );
    const result = await run;
    expect(result.outcome).toBe('output_limit');
    expect(Buffer.byteLength(run.output.stdout)).toBeLessThanOrEqual(50_000);
    expect(Buffer.byteLength(run.output.stdout)).toBeGreaterThan(40_000);
  });

  it('does not split a character at the output cap or between chunks', async () => {
    const run = runNode('process.stdout.write("€".repeat(10)); setTimeout(()=>{}, 100);', {
      outputBytes: 16,
    });
    await run;
    expect(run.output.stdout).toMatch(/^€+�?$/);
  });

  it('stops when asked', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runNode('setInterval(() => {}, 1000)', { stop: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.outcome).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not even start when stopped already', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runNode('setInterval(() => {}, 1000)', { stop: controller.signal })).outcome,
    ).toBe('stopped');
  });

  it('reports a missing program instead of throwing', async () => {
    const result = await runProcess({
      command: 'compilerlab-no-such-tool',
      args: [],
      cwd: directory,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 1000,
      outputBytes: 1000,
      memoryBytes: 1000,
      stop: new AbortController().signal,
      onOutput: () => {},
    });
    expect(result.outcome).toBe('missing_tool');
    expect(result.startError).toBeTruthy();
  });

  it('reports a bad working folder instead of hanging', async () => {
    const result = await runNode('1', { cwd: join(directory, 'nowhere') });
    expect(result.outcome).toBe('missing_tool');
  });

  it('does not hang when a background child keeps the pipes open', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 4000)'], { stdio: 'inherit', detached: true });
      child.unref();
      console.log('parent done');`;
    const started = Date.now();
    const run = runNode(script);
    const result = await run;
    expect(result.outcome).toBe('ok');
    expect(run.output.stdout).toContain('parent done');
    expect(Date.now() - started).toBeLessThan(3800);
  }, 15_000);

  it('filters stderr before counting it against the cap', async () => {
    const run = runNode(
      'for (let i = 0; i < 100; i++) console.error("noise"); console.error("kept");',
      {
        outputBytes: 100,
        filterStderr: {
          write: (text) => text.replace(/noise\r?\n/g, ''),
          flush: () => 'end',
        },
      },
    );
    const result = await run;
    expect(result.outcome).toBe('ok');
    expect(run.output.stderr).toContain('kept');
    expect(run.output.stderr).not.toContain('noise');
    expect(run.output.stderr).toContain('end');
  });

  it('stops a program that uses too much memory', async () => {
    const result = await runNode(
      'const keep = []; for (let i = 0; i < 40; i++) keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); setInterval(() => {}, 1000);',
      { memoryBytes: 128 * 1024 * 1024, timeoutMs: 12_000 },
    );
    expect(result.outcome).toBe('memory_limit');
  }, 20_000);

  it('leaves a program under the memory limit alone', async () => {
    const result = await runNode('setTimeout(() => {}, 700);', {
      memoryBytes: 2 * 1024 * 1024 * 1024,
    });
    expect(result.outcome).toBe('ok');
  });
});

describe('readProcessMemory', () => {
  it('reads this process', async () => {
    const bytes = await readProcessMemory(process.pid);
    expect(bytes).toBeGreaterThan(1024 * 1024);
  });

  it('gives null for a process that does not exist', async () => {
    expect(await readProcessMemory(2 ** 30)).toBeNull();
  });
});

describe('describeCrash', () => {
  it('explains crashes on both kinds of system', () => {
    expect(describeCrash(null, 'SIGSEGV')).toContain('Segmentation fault');
    expect(describeCrash(null, 'SIGFPE')).toContain('divided');
    expect(describeCrash(0xc0000005, null)).toContain('segmentation fault');
    expect(describeCrash(-1073741819, null)).toContain('0xC0000005');
    expect(describeCrash(0xc00000fd, null)).toContain('stack');
    expect(describeCrash(0xcccccccc, null)).toContain('memory error');
  });
});

describe('the run folder', () => {
  it('is what a program sees as its working directory', async () => {
    const run = runNode('console.log(process.cwd())');
    await run;
    expect(run.output.stdout.trim().toLowerCase()).toBe(directory.toLowerCase());
  });
});
