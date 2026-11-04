import type {
  AiChatRequest,
  AiContext,
  AiFeedbackRequest,
  AiFeedbackResponse,
  AiLevel,
  AiStatus,
  AiTaskInput,
  AiTaskName,
  AiTaskOutput,
  AiTaskResponse,
  ApiErrorBody,
  AssessmentCatalog,
  AssessmentSummary,
  AttemptConfig,
  AttemptSummary,
  AttemptView,
  CourseModule,
  FinishAttemptRequest,
  FlashcardCounts,
  FlashcardReviewRequest,
  FlashcardReviewResult,
  FlashcardSession,
  GeneratedQuestion,
  HealthResponse,
  MarkAnswerRequest,
  QuestionDifficulty,
  SaveAnswerRequest,
  LabExerciseView,
  LabProgress,
  LabSolution,
  LabWorkspace,
  LessonSummary,
  Settings,
  SettingsPatch,
  SystemStatus,
  TopicBank,
  TopicProgress,
  TopicProgressPatch,
} from '@compilerlab/shared';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const OFFLINE_MESSAGE =
  'The local CompilerLab server is not responding. Check that the terminal running npm start is still open.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('offline', OFFLINE_MESSAGE, 0);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const error = (body as ApiErrorBody | undefined)?.error;
    if (error?.message) throw new ApiError(error.code, error.message, response.status);
    // The dev proxy answers with an empty 5xx when the API server is down.
    throw new ApiError('offline', OFFLINE_MESSAGE, response.status);
  }
  return body as T;
}

function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
}

/** Opens a streamed reply. Failures before the stream starts arrive as a normal ApiError. */
async function openStream(path: string, payload: unknown, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError('offline', OFFLINE_MESSAGE, 0);
  }
  if (response.ok) return response;
  const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
  if (body?.error?.message) {
    throw new ApiError(body.error.code, body.error.message, response.status);
  }
  throw new ApiError('offline', OFFLINE_MESSAGE, response.status);
}

export interface AiTaskOptions {
  context?: AiContext | undefined;
  level?: AiLevel | undefined;
  /** Skips the saved copy of an identical earlier reply. */
  fresh?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export const api = {
  aiStatus: () => request<AiStatus>('/api/ai/status'),
  aiChatStream: (payload: AiChatRequest, signal: AbortSignal) =>
    openStream('/api/ai/chat', payload, signal),
  aiTask: <N extends AiTaskName>(
    task: N,
    input: AiTaskInput<N>,
    { signal, ...options }: AiTaskOptions = {},
  ) =>
    request<AiTaskResponse<AiTaskOutput<N>>>('/api/ai/structured', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, input, ...options }),
      ...(signal ? { signal } : {}),
    }),
  aiFeedback: (feedback: AiFeedbackRequest) =>
    send<AiFeedbackResponse>('POST', '/api/ai/feedback', feedback),
  health: () => request<HealthResponse>('/api/health'),
  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) => send<Settings>('PATCH', '/api/settings', patch),
  resetSettings: () => send<Settings>('POST', '/api/settings/reset'),
  modules: () => request<CourseModule[]>('/api/content/modules'),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  lessons: () => request<LessonSummary[]>('/api/content/lessons'),
  topicBank: (topicId: string) =>
    request<TopicBank>(`/api/content/lessons/${encodeURIComponent(topicId)}/bank`),
  progress: () => request<TopicProgress[]>('/api/progress'),
  updateProgress: (topicId: string, patch: TopicProgressPatch) =>
    send<TopicProgress>('PATCH', `/api/progress/${encodeURIComponent(topicId)}`, patch),
  labExercises: () => request<LabExerciseView[]>('/api/lab/exercises'),
  labSolution: (id: string) =>
    request<LabSolution>(`/api/lab/exercises/${encodeURIComponent(id)}/solution`),
  labProgress: () => request<LabProgress[]>('/api/lab/progress'),
  labWorkspace: (id: string) =>
    request<{ workspace: LabWorkspace | null }>(`/api/lab/workspaces/${encodeURIComponent(id)}`),
  saveLabWorkspace: (id: string, workspace: LabWorkspace) =>
    send<void>('PUT', `/api/lab/workspaces/${encodeURIComponent(id)}`, workspace),
  deleteLabWorkspace: (id: string) =>
    send<void>('DELETE', `/api/lab/workspaces/${encodeURIComponent(id)}`),
  /** Per-topic scores, weak topics and recent attempts, for the dashboard and anyone else. */
  assessmentSummary: () => request<AssessmentSummary>('/api/assessment/summary'),
  assessmentCatalog: () => request<AssessmentCatalog>('/api/assessment/catalog'),
  attempts: () => request<AttemptSummary[]>('/api/assessment/attempts'),
  attempt: (id: string) =>
    request<AttemptView>(`/api/assessment/attempts/${encodeURIComponent(id)}`),
  startAttempt: (config: Partial<AttemptConfig> & Pick<AttemptConfig, 'mode'>) =>
    send<AttemptView>('POST', '/api/assessment/attempts', config),
  discardAttempt: (id: string) =>
    send<void>('DELETE', `/api/assessment/attempts/${encodeURIComponent(id)}`),
  /** `keepalive` lets the last save finish while the page is closing. */
  saveAttemptAnswer: (id: string, save: SaveAnswerRequest, keepalive = false) =>
    request<void>(`/api/assessment/attempts/${encodeURIComponent(id)}/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(save),
      keepalive,
    }),
  nextAttemptQuestion: (id: string) =>
    send<AttemptView>('POST', `/api/assessment/attempts/${encodeURIComponent(id)}/next`, {}),
  finishAttempt: (id: string, finish: FinishAttemptRequest) =>
    send<AttemptView>('POST', `/api/assessment/attempts/${encodeURIComponent(id)}/finish`, finish),
  markAttemptAnswer: (id: string, mark: MarkAnswerRequest) =>
    send<AttemptView>('POST', `/api/assessment/attempts/${encodeURIComponent(id)}/mark`, mark),
  flashcardCounts: () => request<FlashcardCounts>('/api/assessment/flashcards/counts'),
  flashcardSession: (scope: { topic?: string | undefined; module?: string | undefined }) => {
    const query = new URLSearchParams();
    if (scope.topic) query.set('topic', scope.topic);
    if (scope.module) query.set('module', scope.module);
    return request<FlashcardSession>(`/api/assessment/flashcards?${query.toString()}`);
  },
  reviewFlashcard: (review: FlashcardReviewRequest) =>
    send<FlashcardReviewResult>('POST', '/api/assessment/flashcards/review', review),
  generatedQuestions: () => request<GeneratedQuestion[]>('/api/assessment/generated'),
  saveGeneratedQuestions: (batch: {
    topicId: string;
    difficulty: QuestionDifficulty;
    model: string | null;
    questions: unknown[];
  }) => send<GeneratedQuestion[]>('POST', '/api/assessment/generated', batch),
  setGeneratedReviewed: (id: string, reviewed: boolean) =>
    send<GeneratedQuestion>('PATCH', `/api/assessment/generated/${encodeURIComponent(id)}`, {
      reviewed,
    }),
  deleteGeneratedQuestion: (id: string) =>
    send<void>('DELETE', `/api/assessment/generated/${encodeURIComponent(id)}`),
};

/** Turns anything that was thrown into a sentence a student can read. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (
    error instanceof Error &&
    /dynamically imported module|importing a module/i.test(error.message)
  ) {
    return 'Part of the app could not load. This usually means it was rebuilt while this page was open, and reloading fixes it.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something unexpected happened.';
}
