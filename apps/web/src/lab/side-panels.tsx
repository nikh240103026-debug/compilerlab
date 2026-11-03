import type { LabExerciseView, LabFile, LabSolution } from '@compilerlab/shared';
import { labFileNameProblem, LAB_LIMITS } from '@compilerlab/shared/lab';
import { FileCode, FilePlus, Lightbulb, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ErrorPanel } from '@/components/error-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { api, describeError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { LAB_TEMPLATES, type LabTemplate } from './templates';

/** Asks before doing something that replaces the student's work. */
function ConfirmButton({
  label,
  question,
  onConfirm,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      {question}
      <Button
        size="sm"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes, replace
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Keep my work
      </Button>
    </span>
  );
}

const DIFFICULTY_TONE = { easy: 'success', medium: 'warning', hard: 'danger' } as const;

export function ExercisePanel({
  exercise,
  onUseFiles,
  onUseStdin,
}: {
  exercise: LabExerciseView;
  onUseFiles: (files: readonly LabFile[]) => void;
  onUseStdin: (stdin: string) => void;
}) {
  const [hintsShown, setHintsShown] = useState(0);
  const [solution, setSolution] = useState<LabSolution | null>(null);
  const [solutionError, setSolutionError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  const reveal = async () => {
    setRevealing(true);
    setSolutionError(null);
    try {
      setSolution(await api.labSolution(exercise.id));
    } catch (error) {
      setSolutionError(describeError(error));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section
      aria-label="Exercise"
      className="space-y-3 rounded-md border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={DIFFICULTY_TONE[exercise.difficulty]}>{exercise.difficulty}</Badge>
        {exercise.tags.slice(0, 2).map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
      <p className="text-sm">{exercise.brief}</p>
      <p className="text-xs text-ink-muted">
        Check runs {exercise.tests.length} visible test{exercise.tests.length === 1 ? '' : 's'} and{' '}
        {exercise.hiddenTestCount} hidden test{exercise.hiddenTestCount === 1 ? '' : 's'}.
      </p>

      <details>
        <summary className="cursor-pointer text-sm font-medium">Visible tests</summary>
        <ul className="mt-2 space-y-2">
          {exercise.tests.map((test) => (
            <li key={test.name} className="text-xs">
              <p className="flex items-center justify-between gap-2 font-medium">
                {test.name}
                <Button size="sm" variant="ghost" onClick={() => onUseStdin(test.input)}>
                  Use as input
                </Button>
              </p>
              <pre className="mt-1 overflow-x-auto rounded-sm bg-surface-2 p-1 font-mono">
                {test.input || '(empty input)'}
              </pre>
              <pre className="mt-1 overflow-x-auto rounded-sm bg-surface-2 p-1 font-mono">
                {test.expected || '(no output)'}
              </pre>
            </li>
          ))}
        </ul>
      </details>

      <div>
        {exercise.hints.slice(0, hintsShown).map((hint, index) => (
          <p key={hint} className="mb-2 flex gap-2 text-sm">
            <Lightbulb aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              <span className="font-medium">Hint {index + 1}. </span>
              {hint}
            </span>
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {hintsShown < exercise.hints.length ? (
            <Button size="sm" variant="ghost" onClick={() => setHintsShown(hintsShown + 1)}>
              {hintsShown === 0 ? 'Show a hint' : 'Show another hint'}
            </Button>
          ) : null}
          {solution ? null : (
            <Button size="sm" variant="ghost" disabled={revealing} onClick={() => void reveal()}>
              Show the solution
            </Button>
          )}
          <ConfirmButton
            label="Start over"
            question="Replace your files with the starter?"
            onConfirm={() => onUseFiles(exercise.files)}
          />
        </div>
      </div>

      {solutionError ? (
        <ErrorPanel
          title="The solution could not load"
          message={solutionError}
          onRetry={() => void reveal()}
        />
      ) : null}
      {solution ? (
        <div className="space-y-2 border-t border-line pt-2">
          <h2 className="text-sm font-semibold">Solution</h2>
          <p className="text-sm">{solution.explanation}</p>
          {solution.files.map((file) => (
            <details key={file.name}>
              <summary className="cursor-pointer font-mono text-xs">{file.name}</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-xs">
                {file.content}
              </pre>
            </details>
          ))}
          <ConfirmButton
            label="Use this solution"
            question="Replace your files with the solution?"
            onConfirm={() => onUseFiles(solution.files)}
          />
        </div>
      ) : null}
    </section>
  );
}

function NameForm({
  initial,
  label,
  otherNames,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  otherNames: readonly string[];
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const problem =
    labFileNameProblem(name) ??
    (otherNames.some((other) => other.toLowerCase() === name.toLowerCase())
      ? 'A file with that name already exists.'
      : null);
  const showProblem = name.length > 0 && name !== initial ? problem : null;

  // This form only opens when the student asks for it, so typing can start right away.
  useEffect(() => input.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) onSubmit(name);
  };

  return (
    <form onSubmit={submit} className="space-y-1 py-1">
      <label htmlFor={inputId} className="text-xs font-medium">
        {label}
      </label>
      <Input
        id={inputId}
        ref={input}
        value={name}
        className="font-mono"
        aria-invalid={showProblem !== null}
        aria-describedby={showProblem ? errorId : undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      {showProblem ? (
        <p id={errorId} className="text-xs text-danger">
          {showProblem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={problem !== null}>
          Save
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function FilePanel({
  files,
  activeFile,
  onOpen,
  onChange,
  onUseTemplate,
}: {
  files: readonly LabFile[];
  activeFile: string | null;
  onOpen: (name: string | null) => void;
  onChange: (files: LabFile[]) => void;
  /** Free practice offers templates. An exercise has its own starter. */
  onUseTemplate?: (template: LabTemplate) => void;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [template, setTemplate] = useState(LAB_TEMPLATES[0]?.id ?? '');
  const templateId = useId();
  const names = files.map((file) => file.name);
  const chosen = LAB_TEMPLATES.find((item) => item.id === template);

  const create = (name: string) => {
    onChange([...files, { name, content: '' }]);
    onOpen(name);
    setEditing(null);
  };
  const rename = (from: string, to: string) => {
    onChange(files.map((file) => (file.name === from ? { ...file, name: to } : file)));
    if (activeFile === from) onOpen(to);
    setEditing(null);
  };
  const remove = (name: string) => {
    const next = files.filter((file) => file.name !== name);
    onChange(next);
    if (activeFile === name) onOpen(next[0]?.name ?? null);
  };

  return (
    <section aria-label="Files" className="space-y-2 rounded-md border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Files</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={files.length >= LAB_LIMITS.files}
          onClick={() => setEditing('new')}
        >
          <FilePlus aria-hidden="true" />
          New file
        </Button>
      </div>
      <ul className="space-y-0.5">
        {files.map((file) =>
          editing === file.name ? (
            <li key={file.name}>
              <NameForm
                initial={file.name}
                label={`Rename ${file.name}`}
                otherNames={names.filter((name) => name !== file.name)}
                onSubmit={(name) => rename(file.name, name)}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={file.name} className="group flex items-center gap-1">
              <button
                type="button"
                aria-current={file.name === activeFile ? 'true' : undefined}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left font-mono text-xs hover:bg-surface-2',
                  file.name === activeFile && 'bg-accent-soft font-semibold',
                )}
                onClick={() => onOpen(file.name)}
              >
                <FileCode aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Rename ${file.name}`}
                onClick={() => setEditing(file.name)}
              >
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${file.name}`}
                onClick={() => remove(file.name)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ),
        )}
      </ul>
      {files.length === 0 && editing !== 'new' ? (
        <p className="text-xs text-ink-muted">No files yet.</p>
      ) : null}
      {editing === 'new' ? (
        <NameForm
          initial=""
          label="New file name"
          otherNames={names}
          onSubmit={create}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {onUseTemplate ? (
        <div className="space-y-1 border-t border-line pt-2">
          <label htmlFor={templateId} className="text-xs font-medium">
            Template
          </label>
          <NativeSelect
            id={templateId}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          >
            {LAB_TEMPLATES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
          {chosen ? (
            <ConfirmButton
              label="Use this template"
              question="Replace your files with this template?"
              onConfirm={() => onUseTemplate(chosen)}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
