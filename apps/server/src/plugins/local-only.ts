import type { ApiErrorBody } from '@compilerlab/shared';
import type { FastifyInstance } from 'fastify';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase());
}

/** Browsers attach Origin to cross-site requests. Requests without one are not from a page. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host?.toLowerCase();
  } catch {
    return false;
  }
}

function forbidden(message: string): ApiErrorBody {
  return { error: { code: 'forbidden', message } };
}

/**
 * Binding to 127.0.0.1 does not stop a website in the user's browser from calling this server.
 * The Host check blocks DNS rebinding and the Origin check blocks cross-site requests. Later
 * milestones compile and run code here, so this guards every route, including WebSocket
 * upgrades, which are GET requests with an Origin header.
 */
export function registerLocalOnly(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const { host, origin } = request.headers;
    if (!isLoopbackHost(host)) {
      return reply
        .code(403)
        .send(forbidden('CompilerLab only accepts requests addressed to this computer.'));
    }
    if (!isSameOrigin(origin, host)) {
      return reply
        .code(403)
        .send(forbidden('CompilerLab only accepts requests from its own pages.'));
    }
  });
}
