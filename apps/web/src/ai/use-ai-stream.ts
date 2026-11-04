import type { AiAnswerMeta, AiChatRequest } from '@compilerlab/shared';
import { trimAiHistory } from '@compilerlab/shared/ai';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { AiTurnError } from './ai-store';
import { currentAiContext } from './context-store';
import { readAiEvents } from './sse';
import { AI_STATUS_KEY } from './use-ai-status';

export interface AiStreamState {
  status: 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';
  text: string;
  /** Why the answer is waiting, such as for a free slot in the rate limit. */
  note: string | null;
  error: AiTurnError | null;
  meta: AiAnswerMeta | null;
}

const IDLE: AiStreamState = { status: 'idle', text: '', note: null, error: null, meta: null };

const DROPPED: AiTurnError = {
  code: 'offline',
  message:
    'The connection closed before the answer finished. Check that the terminal running npm start is still open, then try again.',
  retryAfterSeconds: null,
};

function toTurnError(error: unknown): AiTurnError {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, retryAfterSeconds: null };
  }
  return DROPPED;
}

/**
 * Streams one answer at a time from the tutor. The page's context is attached automatically, and
 * `request.context` adds to it. Sending again replaces an answer still in progress. Leaving the
 * page cancels it, and the server then stops asking the model.
 */
export function useAiStream(options: { onFinish?: (state: AiStreamState) => void } = {}) {
  const [state, setState] = useState<AiStreamState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const onFinish = useRef(options.onFinish);
  onFinish.current = options.onFinish;
  const client = useQueryClient();

  const send = useCallback(
    (request: AiChatRequest) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      let latest: AiStreamState = { ...IDLE, status: 'streaming' };
      const update = (next: AiStreamState) => {
        latest = next;
        setState(next);
      };
      setState(latest);

      const run = async () => {
        try {
          const response = await api.aiChatStream(
            {
              ...request,
              context: currentAiContext(request.context),
              history: request.history ? trimAiHistory(request.history) : undefined,
            },
            current.signal,
          );
          await readAiEvents(response, (event) => {
            switch (event.type) {
              case 'status':
                update({ ...latest, note: event.message });
                break;
              case 'delta':
                update({ ...latest, note: null, text: latest.text + event.text });
                break;
              case 'done':
                update({
                  ...latest,
                  status: 'done',
                  note: null,
                  meta: {
                    model: event.model,
                    cached: event.cached,
                    truncated: event.truncated,
                    sources: event.sources,
                    quota: event.quota,
                  },
                });
                break;
              case 'error':
                update({
                  ...latest,
                  status: 'error',
                  note: null,
                  error: {
                    code: event.code,
                    message: event.message,
                    retryAfterSeconds: event.retryAfterSeconds,
                  },
                });
                break;
            }
          });
          if (latest.status === 'streaming') {
            update({ ...latest, status: 'error', note: null, error: DROPPED });
          }
        } catch (error) {
          // A newer question or leaving the page replaced this one, so nobody is waiting for it.
          if (controller.current !== current) return;
          update(
            current.signal.aborted
              ? { ...latest, status: 'cancelled', note: null }
              : { ...latest, status: 'error', note: null, error: toTurnError(error) },
          );
        }
        if (controller.current !== current) return;
        onFinish.current?.(latest);
        void client.invalidateQueries({ queryKey: AI_STATUS_KEY });
      };
      void run();
    },
    [client],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    const running = controller.current;
    controller.current = null;
    running?.abort();
    setState(IDLE);
  }, []);

  useEffect(
    () => () => {
      const running = controller.current;
      controller.current = null;
      running?.abort();
    },
    [],
  );

  return { ...state, streaming: state.status === 'streaming', send, cancel, reset };
}
