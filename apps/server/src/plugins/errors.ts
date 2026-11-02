import type { ApiErrorBody } from '@compilerlab/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** Every failure becomes the same readable JSON shape, and internals stay in the log. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      const first = details[0];
      const body: ApiErrorBody = {
        error: {
          code: 'invalid_input',
          message: first ? `${first.path || 'value'}: ${first.message}` : 'That value is invalid.',
          details,
        },
      };
      return reply.code(400).send(body);
    }

    const status = error.statusCode ?? 500;
    if (status < 500) {
      const body: ApiErrorBody = {
        error: { code: error.code ?? 'bad_request', message: error.message },
      };
      return reply.code(status).send(body);
    }

    request.log.error({ err: error }, 'request failed');
    const body: ApiErrorBody = {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on the local server. The details are in its log.',
      },
    };
    return reply.code(500).send(body);
  });
}

export function notFoundBody(url: string): ApiErrorBody {
  return { error: { code: 'not_found', message: `There is nothing at ${url}.` } };
}
