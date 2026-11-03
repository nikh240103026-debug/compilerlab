import type {
  ApiErrorBody,
  CourseModule,
  HealthResponse,
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

export const api = {
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
