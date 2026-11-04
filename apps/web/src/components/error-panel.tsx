import type { AiContext } from '@compilerlab/shared';
import { CircleAlert, RotateCw, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { currentAiContext } from '@/ai/context-store';
import { Button } from './ui/button';

/**
 * Takes a question to the tutor. What is on the current page goes with it, because the page is
 * about to close. `context` adds anything the caller knows that the page does not.
 */
export function useAskAi() {
  const navigate = useNavigate();
  return (question: string, context?: AiContext) =>
    navigate('/tutor', { state: { ask: question, context: currentAiContext(context) } });
}

export function ErrorPanel({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  /** Defaults to reloading the page. */
  onRetry?: () => void;
}) {
  const askAi = useAskAi();
  return (
    <div role="alert" className="rounded-lg border border-danger bg-surface p-5">
      <div className="flex items-start gap-3">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-ink-muted">{message}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={onRetry ?? (() => window.location.reload())}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => askAi(`I got this error: "${title}. ${message}" What does it mean?`)}
            >
              <Sparkles aria-hidden="true" />
              Ask AI
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
