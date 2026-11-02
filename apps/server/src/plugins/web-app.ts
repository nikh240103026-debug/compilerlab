import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { notFoundBody } from './errors';

// Enforces in the browser that the only network calls are to this local server.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Serves the built web app, with a fallback to index.html for client-side routes. */
export async function registerWebApp(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    cacheControl: false,
    setHeaders(reply, filePath) {
      const hashed = /[\\/]assets[\\/]/.test(filePath);
      reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isPage = request.method === 'GET' && !path.startsWith('/api/') && !/\.\w+$/.test(path);
    if (isPage) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.code(404).send(notFoundBody(path));
  });
}
