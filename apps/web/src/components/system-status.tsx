import type { SystemStatus } from '@compilerlab/shared';
import { CircleCheck, CircleDashed, RotateCw } from 'lucide-react';
import { Link } from 'react-router';
import { useSystemStatus } from '@/hooks/use-system';
import { describeError } from '@/lib/api';
import { ErrorPanel } from './error-panel';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

export function LabModeBadge({ mode }: { mode: SystemStatus['labMode'] }) {
  return mode === 'real' ? (
    <Badge tone="success">Real tools</Badge>
  ) : (
    <Badge tone="warning">Simulated</Badge>
  );
}

export function ToolFix({ lines }: { lines: readonly string[] }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
      {lines.join('\n')}
    </pre>
  );
}

/** Which lab tools this computer has, and how to install the rest. */
export function ToolchainStatus({ showFix = true }: { showFix?: boolean }) {
  const { data: status, error, refetch, isFetching } = useSystemStatus();

  if (error) {
    return (
      <ErrorPanel
        title="The toolchain could not be checked"
        message={describeError(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!status) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          Lab mode <LabModeBadge mode={status.labMode} />
        </p>
        <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
          <RotateCw aria-hidden="true" />
          Check again
        </Button>
      </div>
      <ul className="space-y-1.5">
        {status.tools.map((tool) => (
          <li key={tool.id} className="flex items-baseline gap-2 text-sm">
            {tool.state === 'ok' ? (
              <CircleCheck aria-hidden="true" className="size-3.5 translate-y-0.5 text-success" />
            ) : (
              <CircleDashed aria-hidden="true" className="size-3.5 translate-y-0.5 text-warning" />
            )}
            <span className="w-12 font-mono text-[0.8125rem]">{tool.label}</span>
            <span className="min-w-0 truncate text-[0.8125rem] text-ink-muted">
              {tool.version ?? 'Not found'}
            </span>
          </li>
        ))}
      </ul>
      {showFix && status.toolFix.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-sm text-ink-muted">
            The lab labels results Simulated until these are installed. For this computer:
          </p>
          <ToolFix lines={status.toolFix} />
          <p className="mt-2 text-[0.8125rem] text-ink-muted">
            Already installed somewhere else? Set the path in{' '}
            <Link to="/settings#toolchain" className="text-accent underline underline-offset-2">
              Settings
            </Link>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}
