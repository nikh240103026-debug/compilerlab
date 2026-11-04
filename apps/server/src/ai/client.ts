/** One turn of a conversation with the model. */
export interface AiMessage {
  role: 'user' | 'model';
  text: string;
}

export interface AiModelRequest {
  model: string;
  system: string;
  /** Oldest first. The last one is the turn the model answers. */
  messages: readonly AiMessage[];
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** When set, the model is asked for JSON in this shape. */
  jsonSchema?: unknown;
  signal?: AbortSignal | undefined;
}

export interface AiResult {
  text: string;
  /** "STOP" or "MAX_TOKENS", or undefined if the model did not say. */
  finishReason?: string | undefined;
}

/**
 * The only thing the app knows about the model. A test passes its own through `buildApp`, so
 * nothing else has to change to run without Gemini.
 *
 * To fail, throw an `AiFailure`, or anything with a numeric `status` like the SDK's errors.
 * `toAiFailure` turns either into a message for the student.
 */
export interface AiClient {
  /** False when there is no key. Nothing is sent, and the student sees the friendly notice. */
  readonly available: boolean;
  generate(request: AiModelRequest): Promise<AiResult>;
  /** Yields the answer in pieces. The last piece carries the finish reason. */
  stream(request: AiModelRequest): AsyncIterable<AiResult>;
}
