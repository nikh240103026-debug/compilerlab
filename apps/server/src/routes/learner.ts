import {
  loadExamResources,
  loadGlossary,
  loadLessonIndex,
  loadPlacementQuiz,
} from '@compilerlab/content';
import {
  DashboardQuerySchema,
  DeleteEverythingSchema,
  ExamPlanSchema,
  HighlightCreateSchema,
  NoteSaveSchema,
  OnboardingStateSchema,
  SearchQuerySchema,
  StudyTimeReportSchema,
  type ApiErrorBody,
  type DashboardData,
  type ExamPlan,
  type ExamResources,
  type GlossaryEntry,
  type Notebook,
  type OnboardingState,
  type PlacementQuestion,
  type SearchResponse,
} from '@compilerlab/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CourseCatalog } from '../assessment/catalog';
import { readSummary } from '../assessment/summary';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';
import { addStudyTime } from '../learner/activity';
import { buildDashboard } from '../learner/dashboard';
import {
  addBookmark,
  addHighlight,
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  readNotebook,
  saveNote,
} from '../learner/notebook';
import { deleteAllData, exportAllData } from '../learner/privacy';
import { GlobalSearch } from '../learner/search';
import { readExamPlan, readOnboarding, saveExamPlan, saveOnboarding } from '../learner/state';

function notFound(reply: FastifyReply, message: string) {
  const body: ApiErrorBody = { error: { code: 'not_found', message } };
  return reply.code(404).send(body);
}

export function registerLearnerRoutes(
  app: FastifyInstance,
  { config, db }: { config: AppConfig; db: SqlDatabase },
): void {
  const catalog = new CourseCatalog(config.contentDir, (file, message) =>
    app.log.warn({ file }, `skipped a question bank: ${message}`),
  );
  const search = new GlobalSearch(config.contentDir, db, catalog, (message) =>
    app.log.warn(message),
  );

  /** Notes and the like hang off real topics, so a typo in a URL cannot leave orphans behind. */
  const isTopic = (id: string) =>
    loadLessonIndex(config.contentDir).lessons.some((lesson) => lesson.id === id);
  const noTopic = (reply: FastifyReply) => notFound(reply, 'There is no topic with that name.');

  app.get('/api/learner/dashboard', async (request): Promise<DashboardData> => {
    const { today } = DashboardQuerySchema.parse(request.query);
    return buildDashboard(db, config.contentDir, today, readSummary(db, catalog.topics()));
  });

  app.post('/api/learner/time', async (request, reply) => {
    addStudyTime(db, StudyTimeReportSchema.parse(request.body));
    return reply.code(204).send();
  });

  app.get('/api/learner/notebook', async (): Promise<Notebook> => readNotebook(db));

  app.put<{ Params: { topicId: string } }>(
    '/api/learner/notes/:topicId',
    async (request, reply) => {
      const { body } = NoteSaveSchema.parse(request.body);
      if (!isTopic(request.params.topicId)) return noTopic(reply);
      return { note: saveNote(db, request.params.topicId, body) };
    },
  );

  app.delete<{ Params: { topicId: string } }>(
    '/api/learner/notes/:topicId',
    async (request, reply) => {
      deleteNote(db, request.params.topicId);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { topicId: string } }>(
    '/api/learner/bookmarks/:topicId',
    async (request, reply) => {
      if (!isTopic(request.params.topicId)) return noTopic(reply);
      addBookmark(db, request.params.topicId);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { topicId: string } }>(
    '/api/learner/bookmarks/:topicId',
    async (request, reply) => {
      deleteBookmark(db, request.params.topicId);
      return reply.code(204).send();
    },
  );

  app.post('/api/learner/highlights', async (request, reply) => {
    const highlight = HighlightCreateSchema.parse(request.body);
    if (!isTopic(highlight.topicId)) return noTopic(reply);
    return reply.code(201).send(addHighlight(db, highlight));
  });

  app.delete<{ Params: { id: string } }>('/api/learner/highlights/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || !deleteHighlight(db, id)) {
      return notFound(reply, 'That highlight is already gone.');
    }
    return reply.code(204).send();
  });

  app.get('/api/learner/onboarding', async (): Promise<OnboardingState> => readOnboarding(db));

  app.put('/api/learner/onboarding', async (request): Promise<OnboardingState> =>
    saveOnboarding(db, OnboardingStateSchema.parse(request.body)),
  );

  app.get('/api/learner/exam-plan', async (): Promise<ExamPlan> => readExamPlan(db));

  app.put('/api/learner/exam-plan', async (request): Promise<ExamPlan> =>
    saveExamPlan(db, ExamPlanSchema.parse(request.body)),
  );

  app.get('/api/learner/export', async (_request, reply) => {
    const data = exportAllData(db, config);
    const day = data.exportedAt.slice(0, 10);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="compilerlab-data-${day}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  app.post('/api/learner/delete-everything', async (request, reply) => {
    DeleteEverythingSchema.parse(request.body);
    deleteAllData(db, config);
    return reply.code(204).send();
  });

  app.get('/api/search', async (request): Promise<SearchResponse> => {
    const { q, kinds, limit } = SearchQuerySchema.parse(request.query);
    return search.search(q, kinds, limit);
  });

  app.get('/api/content/glossary', async (): Promise<GlossaryEntry[]> => {
    const { terms, problems } = loadGlossary(config.contentDir);
    for (const problem of problems) app.log.warn({ file: problem.file }, problem.message);
    return terms;
  });

  app.get('/api/content/placement', async (): Promise<PlacementQuestion[]> =>
    loadPlacementQuiz(config.contentDir),
  );

  app.get('/api/exam/resources', async (): Promise<ExamResources> =>
    loadExamResources(config.contentDir),
  );
}
