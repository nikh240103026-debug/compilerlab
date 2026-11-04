import type {
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import type { AiClient, AiModelRequest, AiResult } from './client';
import { AiCancelled, AiFailure } from './errors';

/** One attempt, from sending to the last word. The queue decides whether to try again. */
const ATTEMPT_TIMEOUT_MS = 120_000;

/** Reasons the model stopped without a usable answer. */
const BLOCKED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

interface Attempt {
  signal: AbortSignal;
  /** Rethrows a failure, saying whether the student cancelled or the attempt ran out of time. */
  fail(error: unknown): never;
}

/** Combines the student's cancel with the time limit, and can tell which one fired. */
function startAttempt(request: AiModelRequest): Attempt {
  const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  return {
    signal,
    fail(error) {
      if (request.signal?.aborted) throw new AiCancelled();
      if (timeout.aborted) throw new AiFailure('timeout', { retryable: true });
      throw error;
    },
  };
}

function parametersOf(request: AiModelRequest, signal: AbortSignal): GenerateContentParameters {
  const config: GenerateContentConfig = {
    systemInstruction: request.system,
    abortSignal: signal,
  };
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens;
  if (request.jsonSchema !== undefined) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = request.jsonSchema;
  }
  return {
    model: request.model,
    contents: request.messages.map(({ role, text }) => ({ role, parts: [{ text }] })),
    config,
  };
}

function resultOf(response: GenerateContentResponse): AiResult {
  if (response.promptFeedback?.blockReason) throw new AiFailure('blocked');
  const finishReason = response.candidates?.[0]?.finishReason as string | undefined;
  if (finishReason && BLOCKED_REASONS.has(finishReason)) throw new AiFailure('blocked');
  return { text: response.text ?? '', finishReason };
}

/** The real model, reached through the official SDK. The SDK loads on the first request. */
export function createGeminiClient(apiKey: string): AiClient {
  const key = apiKey.trim();
  let connection: Promise<GoogleGenAI> | null = null;
  const connect = () => {
    // The key is passed here and goes in a request header. It never reaches a log or the browser.
    connection ??= import('@google/genai').then(
      ({ GoogleGenAI: Sdk }) => new Sdk({ apiKey: key, vertexai: false }),
    );
    return connection;
  };

  return {
    available: key.length > 0,

    async generate(request) {
      const attempt = startAttempt(request);
      try {
        const sdk = await connect();
        const response = await sdk.models.generateContent(parametersOf(request, attempt.signal));
        return resultOf(response);
      } catch (error) {
        return attempt.fail(error);
      }
    },

    async *stream(request) {
      const attempt = startAttempt(request);
      try {
        const sdk = await connect();
        const chunks = await sdk.models.generateContentStream(
          parametersOf(request, attempt.signal),
        );
        for await (const chunk of chunks) yield resultOf(chunk);
      } catch (error) {
        attempt.fail(error);
      }
    },
  };
}
