import type {
  AiContext,
  AiLevel,
  AiTaskInput,
  AiTaskName,
  AiTaskOutput,
  AiTaskResponse,
} from '@compilerlab/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, describeError } from '@/lib/api';
import type { AiTurnError } from './ai-store';
import { currentAiContext } from './context-store';
import { AI_STATUS_KEY } from './use-ai-status';

export interface AiTaskState<N extends AiTaskName> {
  status: 'idle' | 'running' | 'done' | 'error';
  response: AiTaskResponse<AiTaskOutput<N>> | null;
  error: AiTurnError | null;
}

/**
 * Runs one structured task, such as `useAiTask('study-plan')`. The page's context is attached
 * automatically. `data` in the response has already passed the task's schema on the server.
 *
 *   const plan = useAiTask('study-plan');
 *   await plan.run({ examDate, today, hoursPerDay, weakTopics });
 *   plan.response?.data.days
 */
export function useAiTask<N extends AiTaskName>(task: N) {
  const [state, setState] = useState<AiTaskState<N>>({
    status: 'idle',
    response: null,
    error: null,
  });
  const controller = useRef<AbortController | null>(null);
  const client = useQueryClient();

  const run = useCallback(
    async (
      input: AiTaskInput<N>,
      options: { context?: AiContext; level?: AiLevel; fresh?: boolean } = {},
    ) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setState({ status: 'running', response: null, error: null });
      try {
        const response = await api.aiTask(task, input, {
          ...options,
          context: currentAiContext(options.context),
          signal: current.signal,
        });
        if (current.signal.aborted) return null;
        setState({ status: 'done', response, error: null });
        return response;
      } catch (error) {
        if (current.signal.aborted) return null;
        setState({
          status: 'error',
          response: null,
          error: {
            code: error instanceof ApiError ? error.code : 'upstream',
            message: describeError(error),
            retryAfterSeconds: null,
          },
        });
        return null;
      } finally {
        if (!current.signal.aborted) {
          void client.invalidateQueries({ queryKey: AI_STATUS_KEY });
        }
      }
    },
    [task, client],
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle', response: null, error: null });
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { ...state, running: state.status === 'running', run, cancel: reset, reset };
}
