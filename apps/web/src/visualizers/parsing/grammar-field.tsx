import {
  GRAMMAR_INPUT_ERROR_CODES,
  type EngineErrorInfo,
  type GrammarParseIssue,
  type GrammarWarning,
  type Result,
} from '@compilerlab/engine';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useAskAi } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { InputError, JobResult } from '../shared';
import type { GrammarPreset } from './presets';

const textareaClass =
  'w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-[0.8125rem] leading-snug text-ink';

export function GrammarField({
  value,
  onChange,
  presets = [],
  onPreset,
  rows = 5,
  label = 'Grammar',
}: {
  value: string;
  onChange: (value: string) => void;
  presets?: readonly GrammarPreset[];
  /** Called instead of `onChange` when a preset is picked, for a preset with a sentence too. */
  onPreset?: (preset: GrammarPreset) => void;
  rows?: number;
  label?: string;
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
        aria-describedby={hintId}
        className={textareaClass}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
        One rule per line, such as E -&gt; E + T | T. Put spaces between symbols, and write ε for
        empty. A symbol with a production is a nonterminal, and the first head is the start symbol.
      </p>
      {presets.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-ink-muted">Try:</span>
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => (onPreset ? onPreset(preset) : onChange(preset.grammar))}
              className="rounded-sm border border-line px-1.5 py-0.5 text-xs text-ink-muted hover:border-line-strong hover:text-ink"
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SentenceField({
  value,
  onChange,
  label = 'Sentence',
  hint = 'Spaces are optional. Each piece must be a terminal of the grammar.',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
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
      <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>
    </div>
  );
}

export function PrecedenceField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Precedence declarations (optional)
      </label>
      <textarea
        id={id}
        rows={2}
        value={value}
        spellCheck={false}
        className={textareaClass}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="mt-0.5 text-xs text-ink-muted">
        Lowest precedence first, as in Yacc: %left + then %left *. These settle the conflicts an
        ambiguous grammar has.
      </p>
    </div>
  );
}

/** A grammar error names its line, so the caret is drawn under just that line. */
function focusOnLine(
  text: string,
  error: EngineErrorInfo,
): { source: string; error: EngineErrorInfo } {
  const { position } = error;
  if (position === undefined) return { source: '', error };
  const start = text.lastIndexOf('\n', position - 1) + 1;
  const end = text.indexOf('\n', position);
  return {
    source: text.slice(start, end === -1 ? text.length : end),
    error: { ...error, position: position - start },
  };
}

/** Loading and error states, knowing which of the inputs an error's position refers to. */
export function GrammarResult<T>({
  result,
  grammar,
  sentence,
  precedence,
  children,
}: {
  result: Result<T> | undefined;
  grammar: string;
  sentence?: string;
  precedence?: string;
  children: (value: T) => ReactNode;
}) {
  if (result && !result.ok) {
    const { error } = result;
    if (GRAMMAR_INPUT_ERROR_CODES.includes(error.code) && sentence !== undefined) {
      return <InputError error={error} source={sentence} />;
    }
    const focused = focusOnLine(
      error.code === 'bad_precedence' && precedence !== undefined ? precedence : grammar,
      error,
    );
    return <InputError error={focused.error} source={focused.source} />;
  }
  return <JobResult result={result}>{children}</JobResult>;
}

export function GrammarWarnings({ warnings }: { warnings: readonly GrammarWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul
      aria-label="Warnings about this grammar"
      className="space-y-1 rounded-md border border-warning p-2 text-sm"
    >
      {warnings.map((warning, index) => (
        <li key={`${warning.code}-${index}`} className="flex gap-2">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          {warning.message}
        </li>
      ))}
    </ul>
  );
}

export function AskAiButton({ question }: { question: string }) {
  const askAi = useAskAi();
  return (
    <Button size="sm" variant="ghost" className="-ml-2" onClick={() => void askAi(question)}>
      <Sparkles aria-hidden="true" />
      Ask AI
    </Button>
  );
}

/** A list of problems, such as conflicts, each with a way to ask about it. */
export function ProblemList({
  label,
  problems,
  question,
}: {
  label: string;
  problems: readonly { key: string; message: string; detail?: ReactNode }[];
  /** What to ask about one problem. */
  question: (message: string) => string;
}) {
  if (problems.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="rounded-md border border-danger p-2 text-sm">
      <p className="font-medium text-danger">{label}</p>
      <ul className="mt-1 space-y-2">
        {problems.map(({ key, message, detail }) => (
          <li key={key}>
            <p>{message}</p>
            {detail}
            <AskAiButton question={question(message)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IssueList({ issues }: { issues: readonly GrammarParseIssue[] }) {
  return (
    <ProblemList
      label={issues.length === 1 ? 'Syntax error' : `${issues.length} syntax errors`}
      problems={issues.map((issue, index) => ({
        key: `${issue.position}-${index}`,
        message: issue.message,
        ...(issue.recovery
          ? { detail: <p className="text-xs text-ink-muted">Recovery: {issue.recovery}</p> }
          : {}),
      }))}
      question={(message) => `My parser reported this: ${message} What does it mean?`}
    />
  );
}
