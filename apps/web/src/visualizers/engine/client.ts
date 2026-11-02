import type { Result } from '@compilerlab/engine';
import type { JobInput, JobKind, JobOutput } from './jobs';

/** A runaway input is stopped after this long, so it can never hang the tab. */
const JOB_TIMEOUT_MS = 10_000;

interface PendingJob {
  resolve: (result: Result<never>) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingJob>();

function failAll(message: string, code: string, hint?: string) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
  }
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<{ id: number; result: Result<never> }>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(event.data.id);
    job.resolve(event.data.result);
  };
  created.onerror = () => {
    created.terminate();
    worker = null;
    failAll('The engine could not start. Reloading the page usually fixes this.', 'worker_failed');
  };
  worker = created;
  return created;
}

/** Runs a job in the Web Worker. Always resolves, with a readable failure if something goes wrong. */
export async function runEngineJob<K extends JobKind>(
  kind: K,
  input: JobInput<K>,
): Promise<Result<JobOutput<K>>> {
  if (typeof Worker === 'undefined') {
    const { runJob } = await import('./jobs');
    return runJob(kind, input);
  }
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      // Terminating is the only way to stop work in progress, and it ends the other jobs too.
      worker?.terminate();
      worker = null;
      failAll(
        'This input is taking too long to process, so it was stopped.',
        'too_slow',
        'Try a smaller input.',
      );
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as PendingJob['resolve'], timer });
    getWorker().postMessage({ id, kind, input });
  });
}
