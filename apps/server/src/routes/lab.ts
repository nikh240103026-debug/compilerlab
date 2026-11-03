import { loadLabExercises } from '@compilerlab/content';
import {
  LAB_LIMITS,
  LabClientMessageSchema,
  LabWorkspaceSchema,
  SCRATCH_WORKSPACE,
  type ApiErrorBody,
  type LabEvent,
  type LabExercise,
  type LabExerciseView,
  type LabProgress,
  type LabSolution,
} from '@compilerlab/shared';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { checkLabJob, DEFAULT_LAB_LIMITS, runLabJob, type LabLimits } from '../lab/job';
import { sweepRuns } from '../lab/runs';
import { realToolchain, type LabToolchain } from '../lab/toolchain';
import {
  deleteWorkspace,
  markExercisePassed,
  readLabProgress,
  readWorkspace,
  saveWorkspace,
} from '../lab-repo';
import { readSettings } from '../settings-repo';
import type { RouteDeps } from './core';

export interface LabRouteDeps {
  /** Replaces the real flex and gcc in tests. */
  labToolchain?: LabToolchain;
  labLimits?: LabLimits;
}

const MAX_CONCURRENT_JOBS = 3;
/** Room for every file at its limit, plus the input and the JSON around them. */
const MAX_MESSAGE_BYTES = (LAB_LIMITS.files + 2) * LAB_LIMITS.fileBytes * 2;

function viewOf(exercise: LabExercise): LabExerciseView {
  return {
    id: exercise.id,
    module: exercise.module,
    topics: exercise.topics,
    order: exercise.order,
    title: exercise.title,
    difficulty: exercise.difficulty,
    tags: exercise.tags,
    brief: exercise.brief,
    pipeline: exercise.pipeline,
    stdin: exercise.stdin,
    files: exercise.files,
    tests: exercise.tests
      .filter((test) => !test.hidden)
      .map(({ name, input, expected }) => ({ name, input, expected })),
    hiddenTestCount: exercise.tests.filter((test) => test.hidden).length,
    hints: exercise.hints,
  };
}

export async function registerLabRoutes(
  app: FastifyInstance,
  deps: RouteDeps & LabRouteDeps,
): Promise<void> {
  const { config, db, run, labToolchain, labLimits = DEFAULT_LAB_LIMITS } = deps;
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
  void sweepRuns(config.dataDir);

  const exercises = () => {
    const { exercises: loaded, problems } = loadLabExercises(config.contentDir);
    for (const problem of problems) {
      app.log.warn({ file: problem.file }, `skipped a lab exercise: ${problem.message}`);
    }
    return loaded;
  };
  const toolchain = () => labToolchain ?? realToolchain(readSettings(db).toolPaths, run);
  const notFound = (reply: FastifyReply, message: string) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message } };
    return reply.code(404).send(body);
  };

  app.get('/api/lab/exercises', async (): Promise<LabExerciseView[]> => exercises().map(viewOf));

  // The answer is only sent when a student asks for it.
  app.get<{ Params: { id: string } }>('/api/lab/exercises/:id/solution', async (request, reply) => {
    const exercise = exercises().find(({ id }) => id === request.params.id);
    if (!exercise) return notFound(reply, 'There is no lab exercise with that name.');
    const solution: LabSolution = { files: exercise.solution, explanation: exercise.explanation };
    return solution;
  });

  app.get('/api/lab/progress', async (): Promise<LabProgress[]> => readLabProgress(db));

  const isWorkspaceId = (id: string) =>
    id === SCRATCH_WORKSPACE || exercises().some((exercise) => exercise.id === id);

  app.get<{ Params: { id: string } }>('/api/lab/workspaces/:id', async (request, reply) => {
    if (!isWorkspaceId(request.params.id)) {
      return notFound(reply, 'There is no lab exercise with that name.');
    }
    return { workspace: readWorkspace(db, request.params.id) };
  });

  app.put<{ Params: { id: string } }>(
    '/api/lab/workspaces/:id',
    { bodyLimit: MAX_MESSAGE_BYTES },
    async (request, reply) => {
      const workspace = LabWorkspaceSchema.parse(request.body);
      if (!isWorkspaceId(request.params.id)) {
        return notFound(reply, 'There is no lab exercise with that name.');
      }
      saveWorkspace(db, request.params.id, workspace);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/api/lab/workspaces/:id', async (request, reply) => {
    deleteWorkspace(db, request.params.id);
    return reply.code(204).send();
  });

  const running = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const controller of running) controller.abort();
  });

  // The Host and Origin guard runs on this upgrade request too, because it is a GET like any other.
  app.get('/api/lab/ws', { websocket: true }, (socket) => {
    let job: AbortController | null = null;

    const send = (event: LabEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    const refuse = (code: string, message: string, hint: string | null = null) =>
      send({ type: 'error', code, message, hint, fix: [] });

    const handle = (raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        refuse('invalid_message', 'The lab server could not read that message.');
        return;
      }
      const parsed = LabClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        refuse(
          'invalid_input',
          parsed.error.issues[0]?.message ?? 'That lab request is not valid.',
        );
        return;
      }
      const message = parsed.data;
      if (message.type === 'stop') {
        job?.abort();
        return;
      }
      if (job) {
        refuse('busy', 'A job is already running here. Stop it first.');
        return;
      }
      if (running.size >= MAX_CONCURRENT_JOBS) {
        refuse(
          'too_many_jobs',
          'Too many lab jobs are running at once.',
          'Stop one in another tab, or wait for it to finish.',
        );
        return;
      }

      const controller = new AbortController();
      job = controller;
      running.add(controller);
      const context = {
        dataDir: config.dataDir,
        toolchain: toolchain(),
        limits: labLimits,
        stop: controller.signal,
        send,
      };
      const work = async () => {
        if (message.type === 'run') {
          await runLabJob(message.job, context);
          return;
        }
        const exercise = exercises().find(({ id }) => id === message.exerciseId);
        if (!exercise) {
          refuse('not_found', 'There is no lab exercise with that name.');
          return;
        }
        if (await checkLabJob(message.job, exercise, context)) {
          markExercisePassed(db, exercise.id);
        }
      };
      void work()
        .catch((error: unknown) => {
          app.log.error(error, 'a lab job failed unexpectedly');
          refuse(
            'lab_internal',
            'Something went wrong while running this job. Your files are safe.',
            'Try again. If it keeps happening, restart CompilerLab.',
          );
        })
        .finally(() => {
          running.delete(controller);
          job = null;
        });
    };

    socket.on('message', (data: Buffer) => handle(data.toString('utf8')));
    socket.on('close', () => job?.abort());
    socket.on('error', () => job?.abort());
  });
}
