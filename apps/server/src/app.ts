import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { notFoundBody, registerErrorHandling } from './plugins/errors';
import { registerLocalOnly } from './plugins/local-only';
import { registerWebApp } from './plugins/web-app';
import { registerCoreRoutes, type RouteDeps } from './routes/core';
import { registerLearningRoutes } from './routes/learning';

export interface BuildAppOptions extends RouteDeps {
  /** Folder of the built web app. Dev mode leaves this out and Vite serves the pages. */
  webRoot?: string;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { webRoot, ...deps } = options;
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.GEMINI_API_KEY'],
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
  });

  registerLocalOnly(app);
  registerErrorHandling(app);
  registerCoreRoutes(app, deps);
  registerLearningRoutes(app, deps);

  if (webRoot) {
    await registerWebApp(app, webRoot);
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.code(404).send(notFoundBody(request.url.split('?')[0] ?? '')),
    );
  }
  return app;
}
