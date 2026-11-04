/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be focusable. */
import type { AiChatTurn, AiContext, AiLevel } from '@compilerlab/shared';
import { AI_LEVEL_LABELS, AI_LEVELS, AI_LIMITS, isAiUnavailable } from '@compilerlab/shared/ai';
import { RotateCw, Send, Square, Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/cn';
import { AiAnswer } from './ai-answer';
import { useAiStore, type AiTurn } from './ai-store';
import { currentAiContext, describeAiContext } from './context-store';
import { AiOfflineNotice, AiQuotaHint } from './offline-notice';
import { useAiStatus } from './use-ai-status';
import { useAiStream } from './use-ai-stream';

const NO_TURNS: readonly AiTurn[] = [];
const LEVEL_OPTIONS = AI_LEVELS.map((value) => ({ value, label: AI_LEVEL_LABELS[value] }));

/** Sends a question from outside the panel. A new id sends it once. */
export interface AskRequest {
  id: string | number;
  question: string;
  level?: AiLevel | undefined;
  context?: AiContext | undefined;
}

export interface AskAiPanelProps {
  /** Keeps the conversation when the panel closes. Use one id per place, like "lesson:lexer". */
  conversationId: string;
  label?: string;
  /** Added to the page's own context on every question. */
  context?: AiContext | undefined;
  request?: AskRequest | null | undefined;
  socratic?: boolean | undefined;
  suggestions?: readonly string[] | undefined;
  placeholder?: string | undefined;
  showLevel?: boolean;
  /** Shown above the input, for a panel's own controls. */
  toolbar?: ReactNode;
  /** Moves focus to the question box whenever this changes to a new value. */
  focusKey?: string | number | undefined;
  className?: string | undefined;
}

function historyOf(turns: readonly AiTurn[]): AiChatTurn[] {
  return turns
    .filter((turn) => !turn.error && turn.text.trim())
    .map(({ role, text }) => ({ role, text }));
}

function FailedTurn({
  turn,
  onRetry,
  isLast,
}: {
  turn: AiTurn;
  onRetry: () => void;
  isLast: boolean;
}) {
  const error = turn.error;
  if (!error) return null;
  return (
    <div className="space-y-1">
      {isAiUnavailable(error.code) ? (
        <AiOfflineNotice error={error} />
      ) : (
        <p role="alert" className="rounded-md border border-danger p-2 text-sm">
          {error.message}
        </p>
      )}
      {isLast ? (
        <Button size="sm" variant="ghost" className="-ml-2" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The tutor's chat: a question box, a streaming answer, and a short rolling history. It sends the
 * page's context with each question. Used on the tutor page, on lessons and in the lab.
 */
export function AskAiPanel({
  conversationId,
  label = 'Ask the tutor',
  context,
  request,
  socratic,
  suggestions,
  placeholder = 'Ask about compilers, this lesson or your code',
  showLevel = true,
  toolbar,
  focusKey,
  className,
}: AskAiPanelProps) {
  const turns = useAiStore((state) => state.conversations[conversationId]) ?? NO_TURNS;
  const append = useAiStore((state) => state.append);
  const clear = useAiStore((state) => state.clear);
  const level = useAiStore((state) => state.level);
  const setLevel = useAiStore((state) => state.setLevel);
  const { data: status, isError: statusFailed } = useAiStatus();
  const noKey = status?.state === 'no_key';

  const [draft, setDraft] = useState('');
  const inputId = useId();
  const levelName = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const asking = useRef('');
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const stream = useAiStream({
    onFinish: (finished) => {
      append(conversationId, {
        role: 'model',
        text: finished.text,
        question: asking.current,
        meta: finished.meta,
        error: finished.error,
        cancelled: finished.status === 'cancelled',
      });
    },
  });
  const { send: sendStream } = stream;

  const ask = useCallback(
    (
      question: string,
      options: {
        level?: AiLevel | undefined;
        context?: AiContext | undefined;
        fresh?: boolean;
      } = {},
    ) => {
      // A question built from a very long error message is still worth asking, in shorter form.
      const text = question.trim().slice(0, AI_LIMITS.question);
      if (!text) return;
      const history = historyOf(turnsRef.current);
      asking.current = text;
      append(conversationId, { role: 'user', text });
      sendStream({
        question: text,
        history,
        level: options.level ?? level,
        socratic,
        fresh: options.fresh,
        context: { ...context, ...options.context },
      });
    },
    [append, context, conversationId, level, sendStream, socratic],
  );

  // A question from a button elsewhere on the page. The timer stops a development double-run from
  // sending it twice, and it waits to learn whether there is a key at all.
  const statusKnown = status !== undefined || statusFailed;
  const handled = useRef<string | number | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (!request || !statusKnown || handled.current === request.id) return;
    const timer = setTimeout(() => {
      handled.current = request.id;
      if (noKey) {
        setDraft(request.question);
      } else {
        askRef.current(request.question, { level: request.level, context: request.context });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [request, statusKnown, noKey]);

  useEffect(() => {
    if (focusKey !== undefined) input.current?.focus();
  }, [focusKey]);

  // Follows the answer as it grows, unless the student has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [turns.length, stream.text, stream.status]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (stream.streaming || noKey || !draft.trim()) return;
    ask(draft);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  // Reading the page's context takes a little work, so it is not repeated for each streamed word.
  const [contextParts, setContextParts] = useState<string[]>([]);
  const turnCount = turns.length;
  useEffect(() => {
    setContextParts(describeAiContext(currentAiContext(context)));
  }, [context, turnCount, focusKey, stream.status]);

  const lastTurn = turns.at(-1);
  const lastFinished =
    !stream.streaming && lastTurn?.role === 'model' && !lastTurn.error && lastTurn.text.trim()
      ? lastTurn
      : null;
  const lastQuestion = [...turns].reverse().find((turn) => turn.role === 'user')?.text ?? '';
  const empty = turns.length === 0 && !stream.streaming;

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      {showLevel ? (
        <div className="flex flex-wrap items-center gap-2 overflow-x-auto">
          <Segmented
            name={levelName}
            legend="Answer level"
            value={level}
            options={LEVEL_OPTIONS}
            onChange={setLevel}
          />
          {turns.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={stream.streaming}
              onClick={() => clear(conversationId)}
            >
              <Trash2 aria-hidden="true" />
              New chat
            </Button>
          ) : null}
        </div>
      ) : null}

      {toolbar}

      <div
        ref={scroller}
        role="log"
        aria-label="Conversation with the AI tutor"
        aria-busy={stream.streaming}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
        className="min-h-24 flex-1 space-y-3 overflow-y-auto rounded-md bg-surface-2 p-2"
      >
        {noKey ? <AiOfflineNotice /> : null}
        {empty && !noKey ? (
          <div className="space-y-2 p-1">
            <p className="text-sm text-ink-muted">
              Ask anything about the course. The tutor can see what is open on this page.
            </p>
            {suggestions?.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      onClick={() => ask(suggestion)}
                      className="rounded-md border border-line-strong bg-surface px-2 py-1 text-left text-xs hover:bg-surface-3"
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {turns.map((turn, index) =>
          turn.role === 'user' ? (
            <p
              key={turn.id}
              className="ml-auto w-fit max-w-[90%] rounded-md bg-accent-soft px-3 py-2 text-sm break-words whitespace-pre-wrap"
            >
              <span className="sr-only">You asked: </span>
              {turn.text}
            </p>
          ) : (
            <div key={turn.id} className="space-y-1">
              {turn.text.trim() ? (
                <AiAnswer
                  text={turn.text}
                  meta={turn.meta}
                  question={turn.question ?? ''}
                  topicId={context?.topic?.id}
                />
              ) : null}
              {turn.cancelled ? (
                <p className="text-xs text-ink-muted">You stopped this answer.</p>
              ) : null}
              <FailedTurn
                turn={turn}
                isLast={index === turns.length - 1 && !stream.streaming}
                onRetry={() => ask(lastQuestion, { fresh: true })}
              />
            </div>
          ),
        )}

        {stream.streaming ? (
          <AiAnswer
            streaming
            text={stream.text}
            note={stream.note}
            question={asking.current}
            onStop={stream.cancel}
          />
        ) : null}

        {lastFinished ? (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                ask("Explain that again like I'm new to compilers.", { level: 'beginner' })
              }
            >
              Explain like I'm new
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                ask('Go deeper on that. Show the details and the reasoning behind them.')
              }
            >
              Go deeper
            </Button>
            <Button size="sm" variant="ghost" onClick={() => ask(lastQuestion, { fresh: true })}>
              Ask again
            </Button>
          </div>
        ) : null}
      </div>

      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            {label}
          </label>
          <textarea
            ref={input}
            id={inputId}
            rows={2}
            value={draft}
            maxLength={AI_LIMITS.question}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className="w-full resize-none rounded-md border border-line-strong bg-surface p-2 text-sm text-ink placeholder:text-ink-muted"
          />
        </div>
        {stream.streaming ? (
          <Button onClick={stream.cancel}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={noKey || !draft.trim()}>
            <Send aria-hidden="true" />
            Ask
          </Button>
        )}
      </form>

      <div className="space-y-0.5">
        <AiQuotaHint />
        {contextParts.length > 0 ? (
          <p className="text-xs text-ink-muted">
            Sent with your question: {contextParts.join(', ')}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
