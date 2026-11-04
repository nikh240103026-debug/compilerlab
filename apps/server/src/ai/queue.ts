import { AiCancelled, AiFailure, toAiFailure } from './errors';

const WINDOW_MS = 60_000;
/** Answers stream for a while, and more than this at once only eats the free tier faster. */
const CONCURRENCY = 2;
const MAX_WAITING = 30;
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;
/** Past this, telling the student beats leaving the page waiting. */
const MAX_BACKOFF_MS = 45_000;

export interface QueueHooks {
  signal?: AbortSignal | undefined;
  /** A stream cannot start over once the student has seen part of its answer. */
  canRetry?: (() => boolean) | undefined;
  /** Called when the request has to wait, so the page can say why. */
  onWait?: ((seconds: number, reason: 'limit' | 'retry') => void) | undefined;
}

interface Waiter {
  resolve: () => void;
  hooks: QueueHooks;
  notified: boolean;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiCancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiCancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Every call to the model goes through here. It runs requests in order, keeps them inside the
 * per-minute limit, and retries with exponential backoff on 429 and 5xx replies.
 */
export class AiQueue {
  private readonly startedAt: number[] = [];
  private readonly waiting: Waiter[] = [];
  private active = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly requestsPerMinute: number) {}

  /** The numbers behind the quota hint. */
  usage(): { usedThisMinute: number; resetsInSeconds: number; waitSeconds: number } {
    const now = Date.now();
    this.forgetOldStarts(now);
    const oldest = this.startedAt[0];
    return {
      usedThisMinute: this.startedAt.length,
      resetsInSeconds: oldest === undefined ? 0 : Math.ceil((oldest + WINDOW_MS - now) / 1000),
      waitSeconds: Math.ceil(this.msUntilNextStart(now) / 1000),
    };
  }

  /** Runs `task` when a slot opens, retrying it if it fails in a way that might pass. */
  async run<T>(task: () => Promise<T>, hooks: QueueHooks = {}): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      await this.acquire(hooks);
      let delayMs = 0;
      try {
        return await task();
      } catch (error) {
        if (error instanceof AiCancelled || hooks.signal?.aborted) throw new AiCancelled();
        const failure = toAiFailure(error);
        delayMs = Math.max(
          failure.retryAfterMs ?? 0,
          BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250,
        );
        // One 429 usually means the next request would get one too, so everything waits.
        if (failure.code === 'rate_limited') {
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delayMs);
        }
        const retry =
          failure.retryable &&
          attempt < MAX_ATTEMPTS &&
          delayMs <= MAX_BACKOFF_MS &&
          (hooks.canRetry?.() ?? true);
        if (!retry) throw failure;
      } finally {
        this.active -= 1;
        this.pump();
      }
      hooks.onWait?.(Math.ceil(delayMs / 1000), 'retry');
      await sleep(delayMs, hooks.signal);
    }
  }

  /** Stops anything still waiting, when the server shuts down. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const waiter of this.waiting.splice(0)) {
      waiter.hooks.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new AiCancelled());
    }
  }

  private acquire(hooks: QueueHooks): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || hooks.signal?.aborted) {
        reject(new AiCancelled());
        return;
      }
      if (this.waiting.length >= MAX_WAITING) {
        reject(new AiFailure('busy'));
        return;
      }
      const waiter: Waiter = {
        resolve,
        reject,
        hooks,
        notified: false,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(new AiCancelled());
          this.pump();
        },
      };
      hooks.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    while (this.waiting.length > 0 && this.active < CONCURRENCY) {
      const now = Date.now();
      const wait = this.msUntilNextStart(now);
      if (wait > 0) {
        for (const waiter of this.waiting) {
          if (!waiter.notified) {
            waiter.notified = true;
            waiter.hooks.onWait?.(Math.ceil(wait / 1000), 'limit');
          }
        }
        this.timer = setTimeout(() => this.pump(), wait);
        return;
      }
      const next = this.waiting.shift() as Waiter;
      next.hooks.signal?.removeEventListener('abort', next.onAbort);
      this.active += 1;
      this.startedAt.push(now);
      next.resolve();
    }
  }

  private forgetOldStarts(now: number): void {
    while ((this.startedAt[0] ?? Infinity) <= now - WINDOW_MS) this.startedAt.shift();
  }

  private msUntilNextStart(now: number): number {
    this.forgetOldStarts(now);
    const oldest = this.startedAt[0];
    const windowWait =
      this.startedAt.length >= this.requestsPerMinute && oldest !== undefined
        ? oldest + WINDOW_MS - now
        : 0;
    return Math.max(0, this.pausedUntil - now, windowWait);
  }
}
