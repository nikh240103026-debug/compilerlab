import {
  AiChatRequestSchema,
  AiFeedbackRequestSchema,
  AiTaskRequestSchema,
  type AiErrorCode,
  type AiFeedbackResponse,
  type AiStatus,
  type AiStreamEvent,
  type ApiErrorBody,
} from '@compilerlab/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AiClient } from '../ai/client';
import { AiCancelled, AiFailure, toAiFailure } from '../ai/errors';
import { createGeminiClient } from '../ai/gemini-client';
import { AiService } from '../ai/service';
import type { RouteDeps } from './core';

export interface AiRouteDeps {
  /** Replaces Gemini, so tests and tools can run without a key or a network. */
  aiClient?: AiClient;
}

const HEARTBEAT_MS = 15_000;

const STATUS_OF: Readonly<Record<AiErrorCode, number>> = {
  no_key: 503,
  invalid_key: 503,
  offline: 503,
  rate_limited: 429,
  daily_limit: 429,
  busy: 429,
  model_not_found: 503,
  blocked: 422,
  invalid_output: 502,
  timeout: 504,
  upstream: 502,
  bad_request: 400,
};

/** A signal that fires when the student cancels or closes the page. */
function abortWhenClosed(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  // The response's close event, because the request's fires as soon as its body has been read.
  reply.raw.once('close', () => controller.abort());
  return controller;
}

export function registerAiRoutes(app: FastifyInstance, deps: RouteDeps & AiRouteDeps): void {
  const { config, db, aiClient } = deps;
  const service = new AiService({
    config,
    db,
    client: aiClient ?? createGeminiClient(config.geminiApiKey),
    // Never the error's text or the prompt, and so never the key or a student's code.
    onFailure: ({ code, status }) => {
      if (code !== 'no_key') app.log.warn({ code, status }, 'an AI request failed');
    },
  });

  const running = new Set<AbortController>();
  app.addHook('onClose', async () => {
    service.close();
    for (const controller of running) controller.abort();
  });

  app.get('/api/ai/status', async (): Promise<AiStatus> => service.status());

  // Bad input is refused before the stream starts, so it gets the usual JSON error.
  app.post('/api/ai/chat', async (request, reply) => {
    const body = AiChatRequestSchema.parse(request.body);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const write = (chunk: string) => {
      if (!raw.destroyed && !raw.writableEnded) raw.write(chunk);
    };
    const send = (event: AiStreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
    // A comment line, which keeps the connection open while a request waits in the queue.
    const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);

    const controller = abortWhenClosed(reply);
    running.add(controller);
    try {
      await service.chat(body, send, controller.signal);
    } catch (error) {
      app.log.error({ name: (error as Error).name }, 'an AI chat stopped unexpectedly');
      const failure = toAiFailure(error);
      send({
        type: 'error',
        code: failure.code,
        message: failure.friendlyMessage,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    } finally {
      clearInterval(heartbeat);
      running.delete(controller);
      raw.end();
    }
  });

  app.post('/api/ai/structured', async (request, reply) => {
    const body = AiTaskRequestSchema.parse(request.body);
    const controller = abortWhenClosed(reply);
    running.add(controller);
    try {
      return await service.runTask(body, controller.signal);
    } catch (error) {
      if (error instanceof AiCancelled) return reply.code(499).send();
      if (!(error instanceof AiFailure)) throw error;
      const seconds = error.retryAfterSeconds;
      if (seconds !== null) reply.header('Retry-After', String(seconds));
      const payload: ApiErrorBody = {
        error: { code: error.code, message: error.friendlyMessage },
      };
      return reply.code(STATUS_OF[error.code]).send(payload);
    } finally {
      running.delete(controller);
    }
  });

  app.post('/api/ai/feedback', async (request, reply) => {
    const body = AiFeedbackRequestSchema.parse(request.body);
    const saved: AiFeedbackResponse = { id: service.recordFeedback(body) };
    return reply.code(201).send(saved);
  });
}
