import { Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useToasts, type ToastTone } from '@/stores/toasts';
import { useAskAi } from './error-panel';
import { Button } from './ui/button';

const TONE_BORDER: Record<ToastTone, string> = {
  info: 'border-line-strong',
  success: 'border-success',
  danger: 'border-danger',
};

export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  const askAi = useAskAi();

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto animate-toast rounded-lg border bg-surface p-3 shadow-lg',
            TONE_BORDER[toast.tone],
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-[0.8125rem] text-ink-muted">{toast.description}</p>
              ) : null}
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="-mt-1 -mr-1"
              aria-label={`Dismiss: ${toast.title}`}
              onClick={() => dismiss(toast.id)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {toast.tone === 'danger' ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 -ml-2"
              onClick={() => {
                dismiss(toast.id);
                void askAi(
                  `I got this error: "${toast.title}. ${toast.description ?? ''}" What does it mean?`,
                );
              }}
            >
              <Sparkles aria-hidden="true" />
              Ask AI
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
