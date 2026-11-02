import type { EngineErrorInfo, Result } from '@compilerlab/engine';
import { CircleAlert, Sparkles } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useAskAi } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

export interface VisualizerProps {
  /** Starting inputs, for example from a lesson. */
  initial?: Readonly<Record<string, string>>;
  /** Called the first time the student uses the controls. */
  onUsed?: () => void;
}

/** Shows a bad input with a readable reason, what to try next, and an Ask AI button. */
export function InputError({ error, source }: { error: EngineErrorInfo; source?: string }) {
  const askAi = useAskAi();
  const hasPosition = source !== undefined && error.position !== undefined && source.length > 0;
  return (
    <div role="alert" className="rounded-md border border-danger bg-surface p-3">
      <div className="flex items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">{error.message}</p>
          {hasPosition ? (
            <pre className="mt-1 overflow-x-auto font-mono text-[0.8125rem] leading-snug">
              {source}
              {'\n'}
              <span aria-hidden="true" className="text-danger">
                {' '.repeat(error.position as number)}
                {'^'.repeat(Math.max(1, error.length ?? 1))}
              </span>
            </pre>
          ) : null}
          {error.hint ? <p className="mt-1 text-ink-muted">{error.hint}</p> : null}
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 -ml-2"
            onClick={() =>
              void askAi(
                `I got this error${source ? ` for "${source}"` : ''}: ${error.message} What does it mean?`,
              )
            }
          >
            <Sparkles aria-hidden="true" />
            Ask AI
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Loading and error states for a job, so each visualizer only handles the success case. */
export function JobResult<T>({
  result,
  source,
  children,
}: {
  result: Result<T> | undefined;
  source?: string;
  children: (value: T) => ReactNode;
}) {
  if (!result) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!result.ok)
    return <InputError error={result.error} {...(source !== undefined ? { source } : {})} />;
  return <>{children(result.value)}</>;
}

export function RegexField({
  value,
  onChange,
  presets = [],
  label = 'Regular expression',
}: {
  value: string;
  onChange: (value: string) => void;
  presets?: readonly string[];
  label?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
        onChange={(event) => onChange(event.target.value)}
      />
      {presets.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-ink-muted">Try:</span>
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onChange(preset)}
              className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted hover:border-line-strong hover:text-ink"
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The regex with the part being worked on highlighted. */
export function HighlightedSource({
  source,
  span,
}: {
  source: string;
  span: { start: number; end: number };
}) {
  return (
    <p className="mb-2 overflow-x-auto font-mono text-base whitespace-pre" aria-hidden="true">
      <span className="text-ink-muted">{source.slice(0, span.start)}</span>
      <span className="rounded-sm bg-accent-soft font-semibold text-accent">
        {source.slice(span.start, span.end)}
      </span>
      <span className="text-ink-muted">{source.slice(span.end)}</span>
    </p>
  );
}

export function DataTable({
  caption,
  headers,
  rows,
  activeRow,
  activeColumn,
}: {
  caption: string;
  headers: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  activeRow?: number | null;
  /** Counts data columns, so 0 is the first column. */
  activeColumn?: number | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[0.8125rem]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                className="border border-line bg-surface-2 px-2 py-1 text-left font-medium"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => (
                <td
                  key={columnIndex}
                  className={cn(
                    'border border-line px-2 py-1',
                    rowIndex === activeRow && 'bg-surface-2',
                    rowIndex === activeRow &&
                      columnIndex === activeColumn &&
                      'bg-accent-soft font-semibold text-accent',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A categorical color for partition blocks and the like. Reuses the module palette. */
export function categoricalColor(index: number): string {
  return `var(--module-${(index % 8) + 1})`;
}
