import type { AiErrorCode } from '@compilerlab/shared';

const MESSAGES: Readonly<Record<AiErrorCode, string>> = {
  no_key:
    'AI features are off because no Gemini key is set. Everything else in CompilerLab works without one. To turn them on, put your key in .env as GEMINI_API_KEY and restart the app.',
  invalid_key:
    'Gemini did not accept the key in .env. Check GEMINI_API_KEY, or create a new key at aistudio.google.com/apikey, then restart the app. Everything else in CompilerLab keeps working.',
  offline:
    'CompilerLab could not reach Gemini. Check your internet connection and try again. Everything except AI features keeps working offline.',
  rate_limited:
    'The tutor has hit the free-tier limit for now. Please try again shortly. Everything else keeps working.',
  daily_limit:
    "Today's Gemini quota has run out, so the tutor is resting until it resets. Everything else keeps working.",
  model_not_found:
    'Gemini does not know that model. Choose another one in Settings, or change GEMINI_MODEL in .env.',
  blocked:
    'Gemini declined to answer this, which usually comes from its safety filters. Try asking in different words.',
  invalid_output:
    'The AI kept giving an answer in the wrong format, even after being asked to fix it. Please try again.',
  timeout: 'Gemini took too long to answer. Please try again.',
  upstream: 'Gemini had a problem on its side. Please try again in a moment.',
  bad_request:
    'Gemini could not accept this request. Try making it shorter, or asking differently.',
  busy: 'Too many AI requests are waiting already. Please wait for some of them to finish.',
};

export class AiFailure extends Error {
  readonly retryable: boolean;
  /** How long Gemini asked us to wait, when it said. */
  readonly retryAfterMs: number | null;
  /** The HTTP status Gemini replied with, for the server log. */
  readonly status: number | null;

  constructor(
    readonly code: AiErrorCode,
    options: { retryable?: boolean; retryAfterMs?: number | null; status?: number } = {},
  ) {
    super(MESSAGES[code]);
    this.name = 'AiFailure';
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
  }

  get retryAfterSeconds(): number | null {
    return this.retryAfterMs === null ? null : Math.ceil(this.retryAfterMs / 1000);
  }

  /** The message, with how long to wait when that is known. */
  get friendlyMessage(): string {
    const seconds = this.retryAfterSeconds;
    return seconds === null ? this.message : `${this.message} You can try again in ${seconds} s.`;
  }
}

/** The student cancelled or closed the page. Nothing needs to be reported. */
export class AiCancelled extends Error {
  constructor() {
    super('The AI request was cancelled.');
    this.name = 'AiCancelled';
  }
}

export function aiMessage(code: AiErrorCode): string {
  return MESSAGES[code];
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function networkCodeOf(error: { code?: unknown; cause?: unknown }): unknown {
  if (typeof error.code === 'string') return error.code;
  const { cause } = error;
  return typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : null;
}

/** Gemini's 429 replies say how long to wait, as `"retryDelay":"36s"`. */
function retryDelayIn(message: string): number | null {
  const match = /"?retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * Turns anything a client throws into a failure with a readable message. It looks at the shape of
 * the error rather than its class, so the SDK can stay lazily loaded and a fake client can throw
 * a plain `{ status: 429 }`.
 */
export function toAiFailure(error: unknown): AiFailure {
  if (error instanceof AiFailure) return error;
  const shape = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    message?: unknown;
    name?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const message = typeof shape.message === 'string' ? shape.message : '';
  if (typeof shape.status === 'number') {
    const { status } = shape;
    if (status === 429) {
      // A daily quota will not come back in a few seconds, so retrying only wastes time.
      if (/PerDay/i.test(message)) return new AiFailure('daily_limit', { status });
      return new AiFailure('rate_limited', {
        retryable: true,
        retryAfterMs: retryDelayIn(message),
        status,
      });
    }
    if (status === 401 || status === 403 || /API[_ ]KEY/i.test(message)) {
      return new AiFailure('invalid_key', { status });
    }
    if (status === 404) return new AiFailure('model_not_found', { status });
    if (status === 408 || status >= 500) {
      return new AiFailure('upstream', { retryable: true, status });
    }
    return new AiFailure('bad_request', { status });
  }
  if (NETWORK_CODES.has(String(networkCodeOf(shape))) || /fetch failed/i.test(message)) {
    return new AiFailure('offline', { retryable: true });
  }
  return new AiFailure('upstream');
}
