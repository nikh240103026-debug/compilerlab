import { DEFAULT_SETTINGS, type ApiErrorBody, type SystemStatus } from '@compilerlab/shared';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { findRepoRoot, loadConfig } from './config';
import { openDatabase, type SqlDatabase } from './db/driver';
import { migrate } from './db/migrate';
import { isLoopbackHost } from './plugins/local-only';

const SECRET = 'test-secret-gemini-key-value';
const HOST = { host: '127.0.0.1:4317' };

const rootDir = findRepoRoot(import.meta.dirname);

describe('API', () => {
  let app: FastifyInstance;
  let db: SqlDatabase;
  let found: string[];

  const setup = async (env: Record<string, string> = {}) => {
    db = await openDatabase(':memory:');
    migrate(db);
    found = ['flex', 'bison', 'gcc', 'g++', 'make'];
    app = await buildApp({
      config: loadConfig({ LOG_LEVEL: 'silent', GEMINI_API_KEY: SECRET, ...env }, rootDir),
      db,
      run: async (command) => (found.includes(command) ? `${command} 1.0` : null),
    });
  };

  beforeEach(() => setup());

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST });
  const patch = (payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: HOST,
      payload: payload as object,
    });

  describe('health', () => {
    it('reports status and the database driver', async () => {
      const response = await get('/api/health');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', dbDriver: 'better-sqlite3' });
    });
  });

  describe('settings', () => {
    it('returns defaults on a new database', async () => {
      expect((await get('/api/settings')).json()).toEqual(DEFAULT_SETTINGS);
    });

    it('saves a change and returns the merged result', async () => {
      const response = await patch({ theme: 'dark', toolPaths: { gcc: '/x/gcc' } });
      expect(response.statusCode).toBe(200);
      const saved = (await get('/api/settings')).json();
      expect(saved).toMatchObject({ theme: 'dark', fontSize: 16 });
      expect(saved.toolPaths).toMatchObject({ gcc: '/x/gcc', flex: '' });
    });

    it('rejects a bad value with a readable message and saves nothing', async () => {
      const response = await patch({ fontSize: 999 });
      expect(response.statusCode).toBe(400);
      const body = response.json<ApiErrorBody>();
      expect(body.error.code).toBe('invalid_input');
      expect(body.error.message).toContain('fontSize');
      expect((await get('/api/settings')).json().fontSize).toBe(16);
    });

    it('rejects unknown settings', async () => {
      expect((await patch({ adminMode: true })).statusCode).toBe(400);
    });

    it('answers malformed JSON with a clean 400', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { ...HOST, 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ApiErrorBody>().error.message).toBeTruthy();
    });

    it('recovers when a stored value is corrupt', async () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', '{broken');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('fontSize', '"huge"');
      expect((await get('/api/settings')).json()).toEqual(DEFAULT_SETTINGS);
    });

    it('restores defaults', async () => {
      await patch({ theme: 'dark' });
      const response = await app.inject({
        method: 'POST',
        url: '/api/settings/reset',
        headers: HOST,
      });
      expect(response.json()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('content', () => {
    it('lists the course modules', async () => {
      const body = (await get('/api/content/modules')).json();
      expect(body).toHaveLength(9);
      expect(body[1]).toMatchObject({ id: 'lexical-analysis', number: 1 });
    });

    it('finds one module', async () => {
      expect((await get('/api/content/modules/syntax-analysis')).json().number).toBe(2);
    });

    it('explains a missing module', async () => {
      const response = await get('/api/content/modules/nope');
      expect(response.statusCode).toBe(404);
      expect(response.json<ApiErrorBody>().error.code).toBe('not_found');
    });
  });

  describe('system status', () => {
    const status = async () => (await get('/api/system/status')).json<SystemStatus>();

    it('uses real tools when all are found', async () => {
      const body = await status();
      expect(body.labMode).toBe('real');
      expect(body.toolFix).toEqual([]);
      expect(body.tools.map((tool) => tool.state)).toEqual(Array(5).fill('ok'));
    });

    it('falls back to simulated mode and gives fix steps when a tool is missing', async () => {
      found = ['bison', 'gcc', 'g++', 'make'];
      const body = await status();
      expect(body.labMode).toBe('simulated');
      expect(body.tools[0]).toMatchObject({ id: 'flex', state: 'warn', version: null });
      expect(body.toolFix.join(' ')).toContain('flex');
    });

    it('stays in real mode when only make is missing', async () => {
      found = ['flex', 'bison', 'gcc', 'g++'];
      expect((await status()).labMode).toBe('real');
    });

    it('uses tool paths from Settings', async () => {
      found = ['/custom/flex', 'bison', 'gcc', 'g++', 'make'];
      expect((await status()).labMode).toBe('simulated');
      await patch({ toolPaths: { flex: '/custom/flex' } });
      const body = await status();
      expect(body.labMode).toBe('real');
      expect(body.tools[0]?.command).toBe('/custom/flex');
    });

    it('never exposes the Gemini key', async () => {
      const response = await get('/api/system/status');
      expect(response.json<SystemStatus>().gemini.configured).toBe(true);
      expect(response.body).not.toContain(SECRET);
    });

    it('reports a missing key', async () => {
      await app.close();
      db.close();
      await setup({ GEMINI_API_KEY: '' });
      expect((await status()).gemini.configured).toBe(false);
    });

    it('prefers the model from Settings over .env', async () => {
      await patch({ geminiModel: 'gemini-custom' });
      expect((await status()).gemini).toMatchObject({
        model: 'gemini-custom',
        defaultModel: 'gemini-3.5-flash-lite',
      });
    });
  });

  describe('local-only guard', () => {
    it.each(['evil.example.com', 'evil.example.com:4317', '192.168.1.5:4317'])(
      'rejects the Host header %j, which blocks DNS rebinding',
      async (host) => {
        const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
        expect(response.statusCode).toBe(403);
      },
    );

    it('treats a missing Host header as not local', () => {
      expect(isLoopbackHost(undefined)).toBe(false);
      expect(isLoopbackHost('')).toBe(false);
    });

    it.each(['127.0.0.1:4317', 'localhost:4317', '[::1]:4317', 'LOCALHOST:4317'])(
      'accepts the Host header %j',
      async (host) => {
        const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
        expect(response.statusCode).toBe(200);
      },
    );

    it.each(['https://evil.example.com', 'http://127.0.0.1:9999', 'null', 'not a url'])(
      'rejects the cross-site Origin %j and changes nothing',
      async (origin) => {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { ...HOST, origin },
          payload: { theme: 'dark' },
        });
        expect(response.statusCode).toBe(403);
        expect((await get('/api/settings')).json().theme).toBe('system');
      },
    );

    it('rejects cross-site reads too', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/status',
        headers: { ...HOST, origin: 'https://evil.example.com' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('accepts its own origin', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { ...HOST, origin: 'http://127.0.0.1:4317' },
        payload: { theme: 'dark' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('sends no CORS headers', async () => {
      const response = await get('/api/health');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('answers unknown API routes with JSON', async () => {
      const response = await get('/api/nope');
      expect(response.statusCode).toBe(404);
      expect(response.json<ApiErrorBody>().error.code).toBe('not_found');
    });

    it('hides internals when a route throws', async () => {
      db.exec('DROP TABLE settings');
      const response = await get('/api/settings');
      expect(response.statusCode).toBe(500);
      expect(response.json<ApiErrorBody>().error.code).toBe('internal_error');
      expect(response.body).not.toContain('settings');
    });
  });
});

describe('production web serving', () => {
  let app: FastifyInstance;
  let db: SqlDatabase;
  let webRoot: string;

  const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST });

  beforeEach(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'compilerlab-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>app shell</title>');
    writeFileSync(join(webRoot, 'assets', 'main-abc.js'), 'console.log(1)');
    db = await openDatabase(':memory:');
    migrate(db);
    app = await buildApp({
      config: loadConfig({ LOG_LEVEL: 'silent' }, rootDir),
      db,
      webRoot,
      run: async () => null,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves the app at the root with a strict content security policy', async () => {
    const response = await get('/');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('app shell');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
  });

  it('serves client-side routes from index.html', async () => {
    const response = await get('/learn/lexical-analysis');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('app shell');
  });

  it('caches hashed assets but not the page', async () => {
    expect((await get('/assets/main-abc.js')).headers['cache-control']).toContain('immutable');
    expect((await get('/')).headers['cache-control']).toBe('no-cache');
  });

  it('keeps JSON 404s for the API and for missing files', async () => {
    expect((await get('/api/nope')).json<ApiErrorBody>().error.code).toBe('not_found');
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
  });

  it('does not serve files outside the web root', async () => {
    for (const url of ['/../package.json', '/..%2f..%2fpackage.json', '/assets/../../secret.txt']) {
      const response = await get(url);
      expect(response.body).not.toContain('"workspaces"');
    }
  });
});
