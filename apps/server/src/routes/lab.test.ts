import type { LabEvent, LabExerciseView, LabProgress, LabWorkspace } from '@compilerlab/shared';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { findRepoRoot, loadConfig } from '../config';
import { openDatabase, type SqlDatabase } from '../db/driver';
import { migrate } from '../db/migrate';
import { createFakeTools, type FakeTools } from '../lab/fake-tools';
import { DEFAULT_LAB_LIMITS } from '../lab/job';

const rootDir = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
let fake: FakeTools;
let app: FastifyInstance;
let db: SqlDatabase;
let dataDir: string;

beforeAll(() => {
  fake = createFakeTools();
});
afterAll(() => fake.dispose());

beforeEach(async () => {
  fake.missing.clear();
  dataDir = mkdtempSync(join(tmpdir(), 'compilerlab-lab-route-'));
  db = await openDatabase(':memory:');
  migrate(db);
  app = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'silent', COMPILERLAB_DATA_DIR: dataDir }, rootDir),
    db,
    labToolchain: fake.toolchain,
    labLimits: { ...DEFAULT_LAB_LIMITS, runTimeoutMs: 4000 },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

type Socket = Awaited<ReturnType<FastifyInstance['injectWS']>>;

async function openSocket(): Promise<{ socket: Socket; events: LabEvent[] }> {
  await app.ready();
  const socket = await app.injectWS('/api/lab/ws', { headers: { host: '127.0.0.1:4317' } });
  const events: LabEvent[] = [];
  socket.on('message', (data: Buffer) => events.push(JSON.parse(data.toString()) as LabEvent));
  return { socket, events };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the lab server.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const finished = (events: readonly LabEvent[]) =>
  events.some((event) => event.type === 'done' || event.type === 'error');

const job = (fields: object = {}) => ({
  pipeline: 'c',
  files: [{ name: 'main.c', content: 'console.log("hello")' }],
  ...fields,
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } });

describe('the exercise routes', () => {
  it('lists exercises without solutions or hidden tests', async () => {
    const response = await get('/api/lab/exercises');
    expect(response.statusCode).toBe(200);
    const exercises = response.json<LabExerciseView[]>();
    expect(exercises.length).toBeGreaterThanOrEqual(8);
    const counter = exercises.find(({ id }) => id === 'word-counter') as LabExerciseView;
    expect(counter.hiddenTestCount).toBeGreaterThan(0);
    expect(counter.tests.every((test) => !('hidden' in test))).toBe(true);
    expect(counter.tests.map((test) => test.name)).not.toContain('Empty input');
    expect(response.body).not.toContain('"solution"');
    expect(response.body).not.toContain('"explanation"');
    // The answer's key rule is not in the starter.
    expect(counter.files[0]?.content).not.toContain('[^ \\t\\n]+');
  });

  it('sends a solution only when asked', async () => {
    const response = await get('/api/lab/exercises/word-counter/solution');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ files: { content: string }[] }>().files[0]?.content).toContain(
      '[^ \\t\\n]+',
    );
    expect((await get('/api/lab/exercises/nope/solution')).statusCode).toBe(404);
    expect((await get('/api/lab/exercises/..%2F..%2Fsecret/solution')).statusCode).toBe(404);
  });
});

describe('workspaces', () => {
  const workspace: LabWorkspace = {
    files: [{ name: 'a.l', content: 'x' }],
    stdin: 'in',
    pipeline: 'lex',
  };
  const put = (id: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/lab/workspaces/${id}`,
      headers: { host: '127.0.0.1:4317' },
      payload: payload as object,
    });

  it('saves, reads and deletes', async () => {
    const saved = async () =>
      (await get('/api/lab/workspaces/scratch')).json<{ workspace: LabWorkspace | null }>()
        .workspace;
    expect(await saved()).toBeNull();
    expect((await put('scratch', workspace)).statusCode).toBe(204);
    expect(await saved()).toEqual(workspace);
    expect((await put('scratch', { ...workspace, stdin: 'new' })).statusCode).toBe(204);
    expect((await saved())?.stdin).toBe('new');
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/lab/workspaces/scratch',
      headers: { host: '127.0.0.1:4317' },
    });
    expect(removed.statusCode).toBe(204);
    expect(await saved()).toBeNull();
  });

  it('saves under exercise ids but not made-up ones', async () => {
    expect((await put('word-counter', workspace)).statusCode).toBe(204);
    expect((await put('not-an-exercise', workspace)).statusCode).toBe(404);
    expect((await get('/api/lab/workspaces/not-an-exercise')).statusCode).toBe(404);
  });

  it('refuses bad file names', async () => {
    const response = await put('scratch', {
      ...workspace,
      files: [{ name: '../evil.c', content: '' }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a workspace larger than the normal body limit', async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      name: `f${i}.c`,
      content: 'x'.repeat(200 * 1024),
    }));
    expect((await put('scratch', { ...workspace, files })).statusCode).toBe(204);
  });

  it('treats damaged saved data as no saved work', async () => {
    const saved = async () => (await get('/api/lab/workspaces/scratch')).json<object>();
    db.prepare('INSERT INTO lab_workspaces (id, data) VALUES (?, ?)').run('scratch', '{ broken');
    expect(await saved()).toEqual({ workspace: null });
    db.prepare('UPDATE lab_workspaces SET data = ? WHERE id = ?').run('{"files":3}', 'scratch');
    expect(await saved()).toEqual({ workspace: null });
  });
});

describe('the lab WebSocket', () => {
  it('runs a job and streams its events', async () => {
    const { socket, events } = await openSocket();
    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => finished(events));
    expect(events[0]).toMatchObject({ type: 'started', engine: 'real' });
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'ok' });
    const output = events.filter((event) => event.type === 'output' && event.step === 'run');
    expect(JSON.stringify(output)).toContain('hello');
    socket.close();
  });

  it('answers bad messages with readable errors and keeps going', async () => {
    const { socket, events } = await openSocket();
    socket.send('{ not json');
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'invalid_message' });

    socket.send(JSON.stringify({ type: 'launch-missiles' }));
    await waitFor(() => events.length === 2);
    expect(events[1]).toMatchObject({ type: 'error', code: 'invalid_input' });

    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => events.some((event) => event.type === 'done'));
    socket.close();
  });

  it('blocks path traversal in file names before anything runs', async () => {
    const { socket, events } = await openSocket();
    socket.send(
      JSON.stringify({ type: 'run', job: job({ files: [{ name: '../../evil.c', content: '' }] }) }),
    );
    await waitFor(() => finished(events));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'invalid_input' });
    expect(JSON.stringify(events[0])).toContain('no folders');
    socket.close();
  });

  it('runs one job at a time on a connection', async () => {
    const { socket, events } = await openSocket();
    const slow = job({ files: [{ name: 'main.c', content: 'setInterval(()=>{},1000)' }] });
    socket.send(JSON.stringify({ type: 'run', job: slow }));
    await waitFor(() => events.some((event) => event.type === 'started'));
    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => events.some((event) => event.type === 'error'));
    expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'busy' });
    socket.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => events.some((event) => event.type === 'done'));
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'stopped' });
    socket.close();
  });

  it('can run again after a job finishes', async () => {
    const { socket, events } = await openSocket();
    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => events.filter((event) => event.type === 'done').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => events.filter((event) => event.type === 'done').length === 2);
    socket.close();
  });

  it('ignores stop when nothing is running', async () => {
    const { socket, events } = await openSocket();
    socket.send(JSON.stringify({ type: 'stop' }));
    socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => finished(events));
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'ok' });
    socket.close();
  });

  it('limits how many jobs run at once across connections', async () => {
    const slow = job({ files: [{ name: 'main.c', content: 'setInterval(()=>{},1000)' }] });
    const open = await Promise.all([openSocket(), openSocket(), openSocket(), openSocket()]);
    for (const connection of open.slice(0, 3)) {
      connection.socket.send(JSON.stringify({ type: 'run', job: slow }));
    }
    await waitFor(() =>
      open.slice(0, 3).every(({ events }) => events.some((event) => event.type === 'started')),
    );
    const last = open[3] as (typeof open)[number];
    last.socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => last.events.length > 0);
    expect(last.events[0]).toMatchObject({ type: 'error', code: 'too_many_jobs' });
    for (const { socket } of open) socket.close();
  });

  it('stops the job when the page goes away', async () => {
    const { socket, events } = await openSocket();
    const slow = job({ files: [{ name: 'main.c', content: 'setInterval(()=>{},1000)' }] });
    socket.send(JSON.stringify({ type: 'run', job: slow }));
    await waitFor(() => events.some((event) => event.type === 'step' && event.id === 'run'));
    socket.close();
    // The slot frees up, so another job can start right away on a full server.
    const again = await openSocket();
    again.socket.send(JSON.stringify({ type: 'run', job: job() }));
    await waitFor(() => finished(again.events));
    expect(again.events.at(-1)).toMatchObject({ type: 'done', outcome: 'ok' });
    again.socket.close();
  });

  it('falls back to Simulated for Lex when the tools are missing', async () => {
    fake.missing.add('flex');
    const { socket, events } = await openSocket();
    socket.send(
      JSON.stringify({
        type: 'run',
        job: {
          pipeline: 'lex',
          stdin: 'x',
          files: [{ name: 'a.l', content: '%%\nx printf("seen");\n' }],
        },
      }),
    );
    await waitFor(() => finished(events));
    expect(events[0]).toMatchObject({ type: 'started', engine: 'simulated' });
    expect(JSON.stringify(events)).toContain('seen');
    socket.close();
  });

  it('records an exercise once its check passes, and not before', async () => {
    const progress = async () => (await get('/api/lab/progress')).json<LabProgress[]>();
    const solution = (await get('/api/lab/exercises/word-counter/solution')).json<{
      files: { name: string; content: string }[];
    }>();
    fake.missing.add('flex');
    const { socket, events } = await openSocket();

    socket.send(
      JSON.stringify({
        type: 'check',
        exerciseId: 'word-counter',
        job: { pipeline: 'lex', files: [{ name: 'a.l', content: '%%\nx ;\n' }] },
      }),
    );
    await waitFor(() => finished(events));
    expect(events.find((event) => event.type === 'check')).toMatchObject({ passed: false });
    expect(await progress()).toEqual([]);

    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.send(
      JSON.stringify({
        type: 'check',
        exerciseId: 'word-counter',
        job: { pipeline: 'lex', files: solution.files },
      }),
    );
    await waitFor(() => finished(events));
    expect(events.find((event) => event.type === 'check')).toMatchObject({ passed: true });
    await waitFor(() => events.some((event) => event.type === 'done'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await progress()).map((row) => row.exerciseId)).toEqual(['word-counter']);
    socket.close();
  });

  it('says so when checking an exercise that does not exist', async () => {
    const { socket, events } = await openSocket();
    socket.send(JSON.stringify({ type: 'check', exerciseId: 'no-such', job: job() }));
    await waitFor(() => finished(events));
    expect(events[0]).toMatchObject({ type: 'error', code: 'not_found' });
    socket.close();
  });
});

describe('the guard on the WebSocket', () => {
  /** A real upgrade request over a real socket, the way a browser would send one. */
  async function listening(): Promise<number> {
    await app.listen({ host: '127.0.0.1', port: 0 });
    return (app.server.address() as AddressInfo).port;
  }

  function upgrade(port: number, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/lab/ws',
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...headers,
        },
      });
      request.on('upgrade', (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
  }

  it('refuses a page from another site', async () => {
    expect(await upgrade(await listening(), { Origin: 'https://evil.example' })).toBe(403);
  });

  it('refuses a rebinding hostname', async () => {
    expect(await upgrade(await listening(), { Host: 'evil.example' })).toBe(403);
  });

  it('accepts its own page', async () => {
    const port = await listening();
    expect(await upgrade(port, { Origin: `http://127.0.0.1:${port}` })).toBe(101);
  });
});
