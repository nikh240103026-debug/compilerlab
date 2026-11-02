import { modules } from '@compilerlab/content';
import {
  SettingsPatchSchema,
  type ApiErrorBody,
  type CourseModule,
  type HealthResponse,
  type Settings,
  type SystemStatus,
} from '@compilerlab/shared';
import type { FastifyInstance } from 'fastify';
import {
  checkGemini,
  checkNode,
  checkTools,
  probe,
  toolFix,
  type Probe,
} from '../../../../scripts/lib/checks.mjs';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';
import { readSettings, resetSettings, updateSettings } from '../settings-repo';

export interface RouteDeps {
  config: AppConfig;
  db: SqlDatabase;
  /** Replaces real tool detection in tests. */
  run?: Probe;
}

export function registerCoreRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, db, run = probe } = deps;
  const settingsNow = () =>
    readSettings(db, (keys) =>
      app.log.warn({ keys }, 'ignored invalid stored settings and used the defaults'),
    );

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
    dbDriver: db.driver,
  }));

  app.get('/api/settings', async (): Promise<Settings> => settingsNow());

  app.patch('/api/settings', async (request): Promise<Settings> => {
    return updateSettings(db, SettingsPatchSchema.parse(request.body));
  });

  app.post('/api/settings/reset', async (): Promise<Settings> => resetSettings(db));

  app.get('/api/content/modules', async (): Promise<readonly CourseModule[]> => modules);

  app.get<{ Params: { id: string } }>('/api/content/modules/:id', async (request, reply) => {
    const found = modules.find((module) => module.id === request.params.id);
    if (found) return found;
    const body: ApiErrorBody = {
      error: { code: 'not_found', message: 'There is no course module with that name.' },
    };
    return reply.code(404).send(body);
  });

  app.get('/api/system/status', async (): Promise<SystemStatus> => {
    const settings = settingsNow();
    const tools = await checkTools({ override: settings.toolPaths, run });
    const node = checkNode();
    const missing = tools.filter((tool) => tool.state !== 'ok').map((tool) => tool.label);
    // The lab pipelines call flex, bison, gcc and g++ directly and never need make.
    const canRunLab = tools.every((tool) => tool.state === 'ok' || tool.id === 'make');
    return {
      platform: process.platform,
      node: { version: process.version, state: node.state, detail: node.detail },
      tools,
      toolFix: toolFix(missing, process.platform),
      labMode: canRunLab ? 'real' : 'simulated',
      gemini: {
        configured: checkGemini({ GEMINI_API_KEY: config.geminiApiKey }).configured,
        defaultModel: config.geminiModel,
        model: settings.geminiModel || config.geminiModel,
      },
      data: { directory: config.dataDir, dbDriver: db.driver },
    };
  });
}
