import type { ApiErrorBody, TopicProgress } from '@compilerlab/shared';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { findRepoRoot, loadConfig } from '../config';
import { openDatabase, type SqlDatabase } from '../db/driver';
import { migrate } from '../db/migrate';

const HOST = { host: '127.0.0.1:4317' };

const lesson = (id: string, order: number) => `---
id: ${id}
module: lexical-analysis
title: Topic ${id}
order: ${order}
estimatedMinutes: 10
prerequisites: []
outcomes:
  - Understand ${id}
visualizers:
  - id: regex-to-nfa
    props:
      regex: "a|b"
---

## Body
`;

const question = (id: string, type: 'mcq' | 'short') => ({
  id,
  type,
  prompt: 'Why?',
  hint: 'Think.',
  solution: 'Because.',
  explanation: 'It follows.',
  difficulty: 'easy',
  tags: ['test'],
  exams: ['GATE'],
  ...(type === 'mcq' ? { options: ['a', 'b'], answer: 0 } : {}),
});

const bank = {
  summary: ['One', 'Two'],
  quiz: [
    ...['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => question(id, 'mcq')),
    question('q6', 'short'),
  ],
  practice: ['p1', 'p2', 'p3'].map((id) => question(id, 'short')),
  flashcards: [
    { front: 'a', back: 'b', tags: ['t'] },
    { front: 'c', back: 'd', tags: ['t'] },
    { front: 'e', back: 'f', tags: ['t'] },
  ],
};

describe('learning routes', () => {
  let app: FastifyInstance;
  let db: SqlDatabase;
  let contentDir: string;

  const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST });
  const patch = (id: string, payload: object) =>
    app.inject({ method: 'PATCH', url: `/api/progress/${id}`, headers: HOST, payload });

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'compilerlab-content-'));
    mkdirSync(join(contentDir, 'lessons', 'lexical-analysis'), { recursive: true });
    mkdirSync(join(contentDir, 'banks'));
    const dir = join(contentDir, 'lessons', 'lexical-analysis');
    writeFileSync(join(dir, 'second.mdx'), lesson('second', 2));
    writeFileSync(join(dir, 'first.mdx'), lesson('first', 1));
    writeFileSync(join(contentDir, 'banks', 'first.json'), JSON.stringify(bank));
    writeFileSync(join(contentDir, 'banks', 'second.json'), '{"summary":[]}');

    db = await openDatabase(':memory:');
    migrate(db);
    const config = loadConfig({ LOG_LEVEL: 'silent' }, findRepoRoot(import.meta.dirname));
    app = await buildApp({ config: { ...config, contentDir }, db, run: async () => null });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(contentDir, { recursive: true, force: true });
  });

  describe('lessons', () => {
    it('lists lessons in teaching order, with their file paths', async () => {
      const body = (await get('/api/content/lessons')).json();
      expect(body.map((item: { id: string }) => item.id)).toEqual(['first', 'second']);
      expect(body[0].path).toBe('lexical-analysis/first.mdx');
      expect(body[0].visualizers[0].props.regex).toBe('a|b');
    });

    it('picks up a new lesson with no code change', async () => {
      const dir = join(contentDir, 'lessons', 'lexical-analysis');
      writeFileSync(join(dir, 'third.mdx'), lesson('third', 3));
      expect((await get('/api/content/lessons')).json()).toHaveLength(3);
    });

    it('skips a broken lesson and keeps serving the others', async () => {
      const dir = join(contentDir, 'lessons', 'lexical-analysis');
      writeFileSync(join(dir, 'broken.mdx'), '---\nid: Bad Id\n---\n');
      writeFileSync(join(dir, 'none.mdx'), 'no frontmatter');
      const body = (await get('/api/content/lessons')).json();
      expect(body).toHaveLength(2);
    });

    it('skips a lesson whose id is already taken', async () => {
      const dir = join(contentDir, 'lessons', 'lexical-analysis');
      writeFileSync(join(dir, 'copy.mdx'), lesson('first', 9));
      expect((await get('/api/content/lessons')).json()).toHaveLength(2);
    });
  });

  describe('question banks', () => {
    it('serves a valid bank', async () => {
      const response = await get('/api/content/lessons/first/bank');
      expect(response.statusCode).toBe(200);
      expect(response.json().quiz).toHaveLength(6);
    });

    it('explains a missing topic', async () => {
      const response = await get('/api/content/lessons/nope/bank');
      expect(response.statusCode).toBe(404);
      expect(response.json<ApiErrorBody>().error.message).toContain('no topic');
    });

    it('explains a topic with no bank file', async () => {
      rmSync(join(contentDir, 'banks', 'first.json'));
      expect((await get('/api/content/lessons/first/bank')).statusCode).toBe(404);
    });

    it('answers cleanly when a bank is invalid', async () => {
      const response = await get('/api/content/lessons/second/bank');
      expect(response.statusCode).toBe(400);
      expect(response.json<ApiErrorBody>().error.code).toBe('invalid_input');
    });

    it.each(['../../../package', '..%2F..%2Fpackage', 'first%00'])(
      'cannot be used to read other files: %s',
      async (id) => {
        const response = await get(`/api/content/lessons/${id}/bank`);
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).not.toContain('workspaces');
      },
    );
  });

  describe('progress', () => {
    const progress = async () => (await get('/api/progress')).json<TopicProgress[]>();

    it('starts empty', async () => {
      expect(await progress()).toEqual([]);
    });

    it('records each fact and keeps earlier ones', async () => {
      await patch('first', { read: true });
      await patch('first', { visualizerUsed: true });
      const response = await patch('first', { quizScore: 80 });
      expect(response.json()).toMatchObject({
        topicId: 'first',
        read: true,
        visualizerUsed: true,
        bestQuizScore: 80,
      });
    });

    it('reports no score until a quiz is taken', async () => {
      expect((await patch('first', { read: true })).json().bestQuizScore).toBeNull();
      expect((await patch('first', { visualizerUsed: true })).json().bestQuizScore).toBeNull();
      expect((await progress())[0]?.bestQuizScore).toBeNull();
    });

    it('keeps the best score, including a score of zero', async () => {
      expect((await patch('first', { quizScore: 0 })).json().bestQuizScore).toBe(0);
      await patch('first', { quizScore: 90 });
      expect((await patch('first', { quizScore: 40 })).json().bestQuizScore).toBe(90);
    });

    it('rejects a bad patch', async () => {
      expect((await patch('first', { quizScore: 500 })).statusCode).toBe(400);
      expect((await patch('first', { read: false })).statusCode).toBe(400);
    });

    it('refuses progress for a topic that does not exist', async () => {
      expect((await patch('nope', { read: true })).statusCode).toBe(404);
      expect(await progress()).toEqual([]);
    });
  });
});
