/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be focusable. */
import type { EngineErrorInfo, Result } from '@compilerlab/engine';
import { useId, type ReactNode } from 'react';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { InputError, JobResult } from '../shared';

// The controls the Module 3 and Module 4 playgrounds share: a labeled text box with example inputs,
// errors that point at the right line, and a scroll region for drawings wider than a narrow pane.

const textareaClass =
  'w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-[0.8125rem] leading-snug text-ink';

export interface SourcePreset {
  label: string;
  /** The main text: a definition or a program. */
  text: string;
  /** An input for that definition, when it takes one. */
  input?: string;
}

function PresetButtons<P extends SourcePreset>({
  presets,
  onPick,
}: {
  presets: readonly P[];
  onPick: (preset: P) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="text-xs text-ink-muted">Try:</span>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onPick(preset)}
          className="rounded-sm border border-line px-1.5 py-0.5 text-xs text-ink-muted hover:border-line-strong hover:text-ink"
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

export function CodeField<P extends SourcePreset>({
  label,
  value,
  onChange,
  rows = 6,
  hint,
  presets = [],
  onPreset,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  presets?: readonly P[];
  /** Called when an example is picked. Without it, the example's text replaces the value. */
  onPreset?: (preset: P) => void;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        aria-describedby={hint ? hintId : undefined}
        className={textareaClass}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {presets.length > 0 ? (
        <PresetButtons
          presets={presets}
          onPick={(preset) => (onPreset ? onPreset(preset) : onChange(preset.text))}
        />
      ) : null}
    </div>
  );
}

export function LineField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
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
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * An error in a many-line text names an offset in the whole text, but the caret can only be drawn
 * under one line, so this cuts the text down to the line the error is on.
 */
export function focusErrorLine(
  text: string,
  error: EngineErrorInfo,
): { source: string; error: EngineErrorInfo } {
  const { position } = error;
  if (position === undefined) return { source: '', error };
  const start = position === 0 ? 0 : text.lastIndexOf('\n', position - 1) + 1;
  const end = text.indexOf('\n', position);
  return {
    source: text.slice(start, end === -1 ? text.length : end),
    error: { ...error, position: position - start },
  };
}

/** A bad input, with a readable reason, the line it is on, and an Ask AI button. */
export function SourceError({ error, text }: { error: EngineErrorInfo; text: string }) {
  const focused = focusErrorLine(text, error);
  return <InputError error={focused.error} source={focused.source} />;
}

/** Loading and error states for a job whose input is a single text. */
export function SourceResult<T>({
  result,
  text,
  children,
}: {
  result: Result<T> | undefined;
  text: string;
  children: (value: T) => ReactNode;
}) {
  if (result && !result.ok) return <SourceError error={result.error} text={text} />;
  return <JobResult result={result}>{children}</JobResult>;
}

/**
 * For a drawing wider than the pane. It is focusable so keyboard users can scroll it, and the
 * Player leaves the arrow keys alone while focus is here.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={label}
      data-scroll-region=""
      className={cn('min-w-0 overflow-auto', className)}
    >
      {children}
    </div>
  );
}

/** A small heading over one part of a stage. */
export function PartLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-xs font-medium text-ink-muted">{children}</p>;
}

/** A row of small labeled chips, such as a list of attributes or names. */
export function ChipList({
  label,
  items,
  empty = 'None yet.',
}: {
  label: string;
  items: readonly { key: string; text: string; active?: boolean; tone?: 'danger' | 'added' }[];
  empty?: string;
}) {
  if (items.length === 0) return <p className="text-xs text-ink-muted">{empty}</p>;
  return (
    <ol aria-label={label} className="flex flex-wrap gap-1 font-mono text-xs">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            'rounded-sm border px-1.5 py-0.5',
            item.active
              ? 'border-accent bg-accent-soft font-semibold text-accent'
              : item.tone === 'danger'
                ? 'border-danger bg-(--diff-remove) text-(--diff-remove-ink)'
                : item.tone === 'added'
                  ? 'border-success bg-(--diff-add) text-(--diff-add-ink)'
                  : 'border-line-strong text-ink',
          )}
        >
          {item.text}
        </li>
      ))}
    </ol>
  );
}
