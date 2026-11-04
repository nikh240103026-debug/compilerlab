import {
  AttemptConfigSchema,
  FinishAttemptSchema,
  FlashcardReviewSchema,
  MarkAnswerSchema,
  SaveAnswerSchema,
  SaveGeneratedSchema,
  UpdateGeneratedSchema,
  type ApiErrorBody,
  type AssessmentCatalog,
  type AssessmentSummary,
  type AttemptConfig,
  type AttemptSummary,
  type AttemptView,
  type FlashcardCounts,
  type GeneratedQuestion,
} from '@compilerlab/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AttemptError,
  correctKeys,
  createAttempt,
  deleteAttempt,
  finishAttempt,
  listAttempts,
  markAnswer,
  readAttempt,
  saveAnswer,
  serveNextQuestion,
} from '../assessment/attempts-repo';
import { CourseCatalog, summarizeCatalog } from '../assessment/catalog';
import { flashcardCounts, flashcardSession, reviewFlashcard } from '../assessment/flashcards-repo';
import {
  deleteGenerated,
  readGenerated,
  saveGenerated,
  setGeneratedReviewed,
} from '../assessment/generated-repo';
import { buildPaper, buildRetryPaper, PaperError, titleFor } from '../assessment/paper';
import { readSummary } from '../assessment/summary';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';

const MAX_LISTED_ATTEMPTS = 50;

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(status).send(body);
}

export function registerAssessmentRoutes(
  app: FastifyInstance,
  { config, db }: { config: AppConfig; db: SqlDatabase },
): void {
  const catalog = new CourseCatalog(config.contentDir, (file, message) =>
    app.log.warn({ file }, `skipped a question bank: ${message}`),
  );

  /** Turns a refusal into its response. Anything else is a bug, and goes to the error plugin. */
  const guarded = async <T>(reply: FastifyReply, run: () => T): Promise<T | FastifyReply> => {
    try {
      return run();
    } catch (error) {
      if (error instanceof AttemptError) {
        return refuse(reply, error.status, error.code, error.message);
      }
      if (error instanceof PaperError) {
        return refuse(reply, 400, 'no_questions', error.message);
      }
      throw error;
    }
  };

  app.get('/api/assessment/catalog', async (): Promise<AssessmentCatalog> =>
    summarizeCatalog(catalog.topics(), readGenerated(db)),
  );

  // Other pages read results through this. Its type is AssessmentSummary in @compilerlab/shared.
  app.get('/api/assessment/summary', async (): Promise<AssessmentSummary> =>
    readSummary(db, catalog.topics()),
  );

  app.get('/api/assessment/attempts', async (): Promise<AttemptSummary[]> =>
    listAttempts(db, MAX_LISTED_ATTEMPTS),
  );

  app.post('/api/assessment/attempts', async (request, reply) => {
    const parsed: AttemptConfig = AttemptConfigSchema.parse(request.body);
    return guarded(reply, () => {
      if (parsed.mode === 'retry') {
        if (!parsed.retryOf) {
          throw new PaperError('Choose a finished test to retry the mistakes from.');
        }
        const earlier = readAttempt(db, parsed.retryOf);
        const correct = correctKeys(earlier);
        const paper = buildRetryPaper(earlier.questions, (key) => correct.has(key));
        return createAttempt(db, parsed, `Mistakes from ${earlier.title}`, paper);
      }
      const topics = catalog.topics();
      const paper = buildPaper(parsed, topics, readGenerated(db));
      return createAttempt(db, parsed, titleFor(parsed, topics), paper);
    });
  });

  app.get<{ Params: { id: string } }>('/api/assessment/attempts/:id', async (request, reply) =>
    guarded(reply, (): AttemptView => readAttempt(db, request.params.id)),
  );

  app.delete<{ Params: { id: string } }>('/api/assessment/attempts/:id', async (request, reply) => {
    deleteAttempt(db, request.params.id);
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string } }>(
    '/api/assessment/attempts/:id/answers',
    async (request, reply) => {
      const save = SaveAnswerSchema.parse(request.body);
      const result = await guarded(reply, () => saveAnswer(db, request.params.id, save));
      return result === undefined ? reply.code(204).send() : result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/assessment/attempts/:id/next',
    async (request, reply) =>
      guarded(reply, (): AttemptView => serveNextQuestion(db, request.params.id)),
  );

  app.post<{ Params: { id: string } }>(
    '/api/assessment/attempts/:id/finish',
    async (request, reply) => {
      const finish = FinishAttemptSchema.parse(request.body);
      return guarded(reply, (): AttemptView => finishAttempt(db, request.params.id, finish));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/assessment/attempts/:id/mark',
    async (request, reply) => {
      const mark = MarkAnswerSchema.parse(request.body);
      return guarded(reply, (): AttemptView => markAnswer(db, request.params.id, mark));
    },
  );

  app.get('/api/assessment/flashcards/counts', async (): Promise<FlashcardCounts> =>
    flashcardCounts(db, catalog.topics()),
  );

  app.get<{ Querystring: { topic?: string; module?: string } }>(
    '/api/assessment/flashcards',
    async (request) =>
      flashcardSession(db, catalog.topics(), {
        topicId: request.query.topic,
        moduleId: request.query.module,
      }),
  );

  app.post('/api/assessment/flashcards/review', async (request) => {
    const { key, quality } = FlashcardReviewSchema.parse(request.body);
    return reviewFlashcard(db, key, quality);
  });

  app.get<{ Querystring: { topic?: string } }>(
    '/api/assessment/generated',
    async (request): Promise<GeneratedQuestion[]> => readGenerated(db, request.query.topic),
  );

  app.post('/api/assessment/generated', async (request): Promise<GeneratedQuestion[]> => {
    const { topicId, difficulty, model, questions } = SaveGeneratedSchema.parse(request.body);
    return saveGenerated(db, topicId, difficulty, model, questions);
  });

  app.patch<{ Params: { id: string } }>('/api/assessment/generated/:id', async (request, reply) => {
    const { reviewed } = UpdateGeneratedSchema.parse(request.body);
    const updated = setGeneratedReviewed(db, request.params.id, reviewed);
    if (updated) return updated;
    return refuse(reply, 404, 'not_found', 'There is no saved question with that id.');
  });

  app.delete<{ Params: { id: string } }>(
    '/api/assessment/generated/:id',
    async (request, reply) => {
      deleteGenerated(db, request.params.id);
      return reply.code(204).send();
    },
  );
}
