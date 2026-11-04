import { loadLessonIndex, loadTopicBank } from '@compilerlab/content';
import {
  TopicProgressPatchSchema,
  type ApiErrorBody,
  type LessonSummary,
  type TopicBank,
  type TopicProgress,
} from '@compilerlab/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';
import { logProgressActivity } from '../learner/activity';
import { readAllProgress, updateProgress } from '../progress-repo';

export function registerLearningRoutes(
  app: FastifyInstance,
  { config, db }: { config: AppConfig; db: SqlDatabase },
): void {
  const lessonIndex = () => {
    const index = loadLessonIndex(config.contentDir);
    for (const problem of index.problems) {
      app.log.warn({ file: problem.file }, `skipped a lesson: ${problem.message}`);
    }
    return index;
  };

  const notFound = (reply: FastifyReply) => {
    const body: ApiErrorBody = {
      error: { code: 'not_found', message: 'There is no topic with that name.' },
    };
    return reply.code(404).send(body);
  };

  app.get('/api/content/lessons', async (): Promise<LessonSummary[]> => lessonIndex().lessons);

  // The id is only ever compared to known lessons, so it can never reach a file path unchecked.
  app.get<{ Params: { id: string } }>('/api/content/lessons/:id/bank', async (request, reply) => {
    const lesson = lessonIndex().lessons.find(({ id }) => id === request.params.id);
    if (!lesson) return notFound(reply);
    const bank: TopicBank | null = loadTopicBank(config.contentDir, lesson.id);
    if (!bank) return notFound(reply);
    return bank;
  });

  app.get('/api/progress', async (): Promise<TopicProgress[]> => readAllProgress(db));

  app.patch<{ Params: { id: string } }>('/api/progress/:id', async (request, reply) => {
    const patch = TopicProgressPatchSchema.parse(request.body);
    const lesson = lessonIndex().lessons.find(({ id }) => id === request.params.id);
    if (!lesson) return notFound(reply);
    const before = readAllProgress(db).find((item) => item.topicId === lesson.id);
    const updated = updateProgress(db, lesson.id, patch);
    logProgressActivity(db, lesson.id, before, patch);
    return updated;
  });
}
