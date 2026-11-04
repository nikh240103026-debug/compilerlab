import { CloudOff, Hourglass, KeyRound } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';
import { useAiStatus } from './use-ai-status';

const ICONS = {
  no_key: KeyRound,
  invalid_key: KeyRound,
  rate_limited: Hourglass,
  daily_limit: Hourglass,
  busy: Hourglass,
};

function iconFor(code: string) {
  return ICONS[code as keyof typeof ICONS] ?? CloudOff;
}

function Notice({ code, message, compact }: { code: string; message: string; compact: boolean }) {
  const Icon = iconFor(code);
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-line-strong bg-surface-2 text-ink',
        compact ? 'p-2 text-xs' : 'p-3 text-sm',
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
      <div className="min-w-0">
        <p>{message}</p>
        {code === 'no_key' || code === 'invalid_key' ? (
          <p className="mt-1">
            <Link to="/settings#system" className="text-accent underline underline-offset-2">
              See the AI settings
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The calm message shown when AI cannot answer: no key, no internet, or a rate limit. Pass `error`
 * to explain a failed request, or leave it out to show the current status, if there is a problem.
 */
export function AiOfflineNotice({
  error,
  compact = false,
}: {
  error?: { code: string; message: string } | null | undefined;
  compact?: boolean;
}) {
  const { data: status } = useAiStatus();
  if (error) return <Notice code={error.code} message={error.message} compact={compact} />;
  if (!status || status.state === 'ready') return null;
  return <Notice code={status.state} message={status.message} compact={compact} />;
}

/** True once it is known that there is no key, so a page can skip offering AI actions. */
export function useAiHasNoKey(): boolean {
  const { data: status } = useAiStatus();
  return status?.state === 'no_key';
}

/** The remaining-quota hint. The daily number is only an estimate. */
export function AiQuotaHint() {
  const { data: status } = useAiStatus();
  if (!status?.configured) return null;
  const { quota } = status;
  return (
    <p className="text-xs text-ink-muted">
      {quota.remainingThisMinute} of {quota.perMinuteLimit} AI requests left this minute, and about{' '}
      {quota.remainingToday} left today.
    </p>
  );
}
