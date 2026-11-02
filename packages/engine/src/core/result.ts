/** A plain object, so it survives being posted from a Web Worker. */
export interface EngineErrorInfo {
  code: string;
  /** A sentence a student can read. */
  message: string;
  /** What to try next. */
  hint?: string;
  /** Where in the student's input, as a UTF-16 offset. */
  position?: number;
  length?: number;
}

export class EngineError extends Error {
  readonly info: EngineErrorInfo;

  constructor(info: EngineErrorInfo) {
    super(info.message);
    this.name = 'EngineError';
    this.info = info;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: EngineErrorInfo };

/** Bad input becomes a failed Result. Anything else is a bug and keeps propagating. */
export function attempt<T>(run: () => T): Result<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof EngineError) return { ok: false, error: error.info };
    throw error;
  }
}
