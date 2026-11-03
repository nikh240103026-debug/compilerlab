import type { LabOutcome, LabStream } from '@compilerlab/shared';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  /** How much output to pass on before stopping the process. */
  outputBytes: number;
  /** Null for the compilers, which are not the student's code. */
  memoryBytes: number | null;
  stop: AbortSignal;
  onOutput: (stream: LabStream, data: string) => void;
  /** Removes tool chatter from stderr before it counts toward the output limit. */
  filterStderr?: { write(text: string): string; flush(): string };
}

export interface ProcessResult {
  outcome: LabOutcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Why it could not start, for missing_tool. */
  startError: string | null;
}

/** Output is sent in small batches, so a chatty program does not flood the browser. */
const FLUSH_INTERVAL_MS = 40;
/** How long to wait for the pipes to close after the process is gone or killed. */
const CLOSE_GRACE_MS = 1500;
const MEMORY_POLL_MS = 250;

/** The process and everything it started. On POSIX, children are their own process group. */
export function killProcessTree(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** How much memory a process is using, or null if the system would not say. */
export function readProcessMemory(pid: number): Promise<number | null> {
  const [command, args] =
    process.platform === 'win32'
      ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
      : ['ps', ['-o', 'rss=', '-p', String(pid)]];
  return new Promise((resolve) => {
    execFile(
      command as string,
      args as string[],
      { windowsHide: true, timeout: 1000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        // tasklist ends a CSV row with "12,345 K". ps prints kilobytes.
        const field = process.platform === 'win32' ? (stdout.split('","').at(-1) ?? '') : stdout;
        const kilobytes = Number(field.replace(/\D/g, ''));
        resolve(kilobytes > 0 ? kilobytes * 1024 : null);
      },
    );
  });
}

function outcomeFromExit(code: number | null, signal: string | null): LabOutcome {
  if (code === 0) return 'ok';
  if (signal !== null) return 'crashed';
  // Windows reports a crash as an exit code with the high bit set, like 0xC0000005.
  if (code !== null && code >>> 0 >= 0xc0000000) return 'crashed';
  return 'failed';
}

/** Runs one command with every limit in force. It never rejects. */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    const settleEarly = (message: string) =>
      resolve({
        outcome: 'missing_tool',
        exitCode: null,
        signal: null,
        durationMs: Math.round(performance.now() - started),
        startError: message,
      });
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // A process group of its own, so killing the group gets its children too. On Windows
        // this would open a console window instead, and taskkill finds the children anyway.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      settleEarly((error as Error).message);
      return;
    }

    let stopReason: LabOutcome | null = null;
    let settled = false;
    let sent = 0;
    let batch = '';
    let batchStream: LabStream = 'stdout';
    let flushTimer: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    let memoryTimer: NodeJS.Timeout | null = null;

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (batch) options.onOutput(batchStream, batch);
      batch = '';
    };

    const kill = (reason: LabOutcome) => {
      if (stopReason || settled) return;
      stopReason = reason;
      killProcessTree(child);
      // A child that escaped the tree can hold a pipe open forever, so never wait on it.
      closeTimer = setTimeout(() => finish(null, null), CLOSE_GRACE_MS);
    };

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (memoryTimer) clearTimeout(memoryTimer);
      options.stop.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (options.filterStderr) deliver('stderr', options.filterStderr.flush());
      flush();
      resolve({
        outcome: stopReason ?? outcomeFromExit(code, signal),
        exitCode: code,
        signal,
        durationMs: Math.round(performance.now() - started),
        startError: null,
      });
    };

    const deliver = (stream: LabStream, text: string) => {
      if (!text || sent >= options.outputBytes) return;
      const bytes = Buffer.byteLength(text);
      const room = options.outputBytes - sent;
      const allowed = bytes <= room ? text : Buffer.from(text).subarray(0, room).toString('utf8');
      sent += Math.min(bytes, room);
      if (stream !== batchStream) flush();
      batchStream = stream;
      batch += allowed;
      flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
      if (sent >= options.outputBytes) kill('output_limit');
    };

    const pipe = (stream: LabStream) => {
      const decoder = new StringDecoder('utf8');
      child[stream]?.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        deliver(
          stream,
          stream === 'stderr' && options.filterStderr ? options.filterStderr.write(text) : text,
        );
      });
      child[stream]?.on('error', () => {});
    };
    pipe('stdout');
    pipe('stderr');

    const timeoutTimer = setTimeout(() => kill('timeout'), options.timeoutMs);
    const onAbort = () => kill('stopped');
    options.stop.addEventListener('abort', onAbort);
    if (options.stop.aborted) kill('stopped');

    if (options.memoryBytes !== null) {
      const limit = options.memoryBytes;
      const poll = () => {
        if (settled || stopReason || child.pid === undefined) return;
        void readProcessMemory(child.pid).then((bytes) => {
          if (settled) return;
          if (bytes !== null && bytes > limit) kill('memory_limit');
          else memoryTimer = setTimeout(poll, MEMORY_POLL_MS);
        });
      };
      memoryTimer = setTimeout(poll, MEMORY_POLL_MS);
    }

    child.on('error', (error) => {
      if (child.pid === undefined) {
        settled = true;
        clearTimeout(timeoutTimer);
        if (memoryTimer) clearTimeout(memoryTimer);
        options.stop.removeEventListener('abort', onAbort);
        settleEarly(error.message);
      }
    });
    // Usually "close" follows quickly. A background child holding the pipes must not hang us.
    child.on('exit', (code, signal) => {
      if (settled) return;
      closeTimer ??= setTimeout(() => finish(code, signal), CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));

    // The program may exit without reading all of this, which is not an error.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
  });
}

const WINDOWS_CRASHES: Readonly<Record<number, string>> = {
  0xc0000005:
    'It read or wrote memory it does not own, the same crash Linux calls a segmentation fault. A bad pointer or an array index past the end is the usual cause.',
  0xc00000fd: 'It ran out of stack space. Recursion that never stops is the usual cause.',
  0xc0000094: 'It divided an integer by zero.',
  0xc000001d: 'It tried to run an invalid instruction, which usually means memory was corrupted.',
  0xc0000409: 'It wrote past the end of a buffer, and the runtime stopped it.',
};

const POSIX_CRASHES: Readonly<Record<string, string>> = {
  SIGSEGV:
    'Segmentation fault: it read or wrote memory it does not own. A bad pointer or an array index past the end is the usual cause.',
  SIGBUS: 'It accessed memory in a way the hardware does not allow, usually through a bad pointer.',
  SIGFPE: 'It divided an integer by zero.',
  SIGABRT: 'It stopped itself, usually because abort() or a failed assert was reached.',
  SIGILL: 'It tried to run an invalid instruction, which usually means memory was corrupted.',
};

/** What a crash means, in plain English. */
export function describeCrash(exitCode: number | null, signal: string | null): string {
  const known =
    (signal ? POSIX_CRASHES[signal] : undefined) ??
    (exitCode !== null ? WINDOWS_CRASHES[exitCode >>> 0] : undefined);
  const name = signal ?? `exit code 0x${((exitCode ?? 0) >>> 0).toString(16).toUpperCase()}`;
  return `Your program crashed (${name}). ${known ?? 'A bad pointer or memory error is the usual cause.'}`;
}
