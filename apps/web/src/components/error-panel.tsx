import { CircleAlert, RotateCw, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from './ui/button';

export function useAskAi() {
  const navigate = useNavigate();
  return (question: string) => navigate('/tutor', { state: { ask: question } });
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
