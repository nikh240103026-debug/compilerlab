import type { AiTaskOutput, LabExerciseView, LabFile } from '@compilerlab/shared';
import { isAiUnavailable } from '@compilerlab/shared/ai';
import { labFileNameProblem } from '@compilerlab/shared/lab';
import { Check, ListChecks, RotateCcw, Square, Wrench, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import type { LabRunState } from '@/lab/lab-run';
import type { AiTurnError } from './ai-store';
import { AiResultFrame } from './ai-answer';
import { AiMarkdown } from './ai-markdown';
import { AskAiPanel, type AskRequest } from './ask-ai-panel';
import { DiffView } from './diff-view';
import { detectLabProblems, type LabProblem } from './lab-problems';
import { applyEdit } from './line-diff';
import { AiOfflineNotice, useAiHasNoKey } from './offline-notice';
import { useAiTask } from './use-ai-task';

type FixEdit = AiTaskOutput<'fix-suggestions'>['edits'][number];

const VIEWS = [
  { value: 'chat', label: 'Ask' },
  { value: 'fix', label: 'Fix suggestions' },
  { value: 'check', label: 'Cross-check' },
] as const;
type View = (typeof VIEWS)[number]['value'];

function TaskFailure({ error }: { error: AiTurnError | null }) {
  if (!error) return null;
  return isAiUnavailable(error.code) ? (
    <AiOfflineNotice error={error} />
  ) : (
    <p role="alert" className="rounded-md border border-danger p-2 text-sm">
      {error.message}
    </p>
  );
}

/** One suggested change: a diff, and buttons to accept or reject it. Nothing applies by itself. */
function EditCard({
  edit,
  files,
  onReplaceFile,
}: {
  edit: FixEdit;
  files: readonly LabFile[];
  onReplaceFile: (name: string, content: string) => void;
}) {
  const [decision, setDecision] = useState<'open' | 'accepted' | 'rejected'>('open');
  // Accepting replaces the editor's text, so this is the student's way back.
  const [previous, setPrevious] = useState<string | null>(null);
  const file = files.find(({ name }) => name === edit.file);
  const before = file?.content.replace(/\r\n/g, '\n') ?? '';
  const after = applyEdit(before, edit.find, edit.replace);
  const nameProblem = file ? null : labFileNameProblem(edit.file);
  const blocked = after === null ? 'This text is no longer in your file.' : nameProblem;

  if (decision !== 'open') {
    return (
      <li className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-sm">
        <span className="font-mono text-xs">{edit.file}</span>
        <span>{decision === 'accepted' ? 'Applied to your file.' : 'Rejected.'}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            if (decision === 'accepted' && previous !== null) onReplaceFile(edit.file, previous);
            setDecision('open');
          }}
        >
          <RotateCcw aria-hidden="true" />
          {decision === 'accepted' ? 'Undo' : 'Show it again'}
        </Button>
      </li>
    );
  }

  return (
    <li className="space-y-2 rounded-md border border-line p-2">
      <p className="font-mono text-xs font-medium">
        {edit.file}
        {file ? '' : ' (new file)'}
      </p>
      <AiMarkdown text={edit.explanation} />
      <DiffView
        before={after === null ? edit.find : before}
        after={after ?? edit.replace}
        label={`Suggested change to ${edit.file}`}
      />
      {blocked ? <p className="text-xs text-warning">{blocked}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={Boolean(blocked)}
          onClick={() => {
            if (after === null) return;
            setPrevious(before);
            onReplaceFile(edit.file, after);
            setDecision('accepted');
          }}
        >
          <Check aria-hidden="true" />
          Accept
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDecision('rejected')}>
          <X aria-hidden="true" />
          Reject
        </Button>
      </div>
    </li>
  );
}

function FixPanel({
  problems,
  socratic,
  files,
  onReplaceFile,
}: {
  problems: readonly LabProblem[];
  socratic: boolean;
  files: readonly LabFile[];
  onReplaceFile: (name: string, content: string) => void;
}) {
  const fix = useAiTask('fix-suggestions');
  const noKey = useAiHasNoKey();
  const [problem, setProblem] = useState('');
  const problemId = useId();
  const first = problems[0]?.question ?? '';
  // Starts from what the last run reported, until the student writes something of their own.
  const [touched, setTouched] = useState(false);
  const shown = touched ? problem : first;

  const ask = (mode: 'hints' | 'full') => {
    if (shown.trim()) void fix.run({ mode, problem: shown });
  };

  const result = fix.response;
  const mode = result && result.data.edits.length > 0 ? 'full' : 'hints';
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={problemId} className="mb-1 block text-sm font-medium">
          What needs fixing?
        </label>
        <textarea
          id={problemId}
          rows={3}
          value={shown}
          placeholder="Run your code first, or describe the problem here."
          onChange={(event) => {
            setTouched(true);
            setProblem(event.target.value);
          }}
          className="w-full rounded-md border border-line-strong bg-surface p-2 text-sm text-ink placeholder:text-ink-muted"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {fix.running ? (
          <Button size="sm" onClick={fix.cancel}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : socratic ? (
          <>
            <Button size="sm" disabled={noKey || !shown.trim()} onClick={() => ask('hints')}>
              <Wrench aria-hidden="true" />
              Give me hints
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={noKey || !shown.trim()}
              onClick={() => ask('full')}
            >
              Show me the full fix
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={noKey || !shown.trim()} onClick={() => ask('full')}>
            <Wrench aria-hidden="true" />
            Suggest a fix
          </Button>
        )}
      </div>
      {fix.running ? <p className="text-xs text-ink-muted">Working it out...</p> : null}
      <TaskFailure error={fix.error} />
      {result ? (
        <AiResultFrame
          meta={result}
          source="fix-suggestions"
          question={shown}
          answer={JSON.stringify(result.data)}
        >
          <AiMarkdown text={result.data.summary} />
          {result.data.hints.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {result.data.hints.map((hint) => (
                <li key={hint}>
                  <AiMarkdown text={hint} />
                </li>
              ))}
            </ol>
          ) : null}
          {mode === 'full' ? (
            <ul aria-label="Suggested changes" className="space-y-2">
              {result.data.edits.map((edit, index) => (
                <EditCard
                  key={`${index}-${edit.file}`}
                  edit={edit}
                  files={files}
                  onReplaceFile={onReplaceFile}
                />
              ))}
            </ul>
          ) : null}
        </AiResultFrame>
      ) : null}
    </div>
  );
}

const MATCH = {
  yes: { label: 'Matches what is expected', tone: 'success' },
  partly: { label: 'Partly matches', tone: 'warning' },
  no: { label: 'Does not match', tone: 'danger' },
  unknown: { label: 'Could not tell', tone: 'neutral' },
} as const;

function BulletList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((item) => (
          <li key={item}>
            <AiMarkdown text={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrossCheckPanel({
  exercise,
  onUseStdin,
}: {
  exercise: LabExerciseView | null;
  onUseStdin: (stdin: string) => void;
}) {
  const check = useAiTask('code-cross-check');
  const noKey = useAiHasNoKey();
  const [expected, setExpected] = useState('');
  const expectedId = useId();
  const result = check.response?.data;

  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-muted">
        {exercise
          ? 'Compares your code with what this exercise expects, suggests more tests and reviews your style. It can explain how your approach differs from the reference solution, but it will not show you the solution.'
          : 'Compares your code with what you say it should do, suggests more tests and reviews your style.'}
      </p>
      {exercise ? null : (
        <div>
          <label htmlFor={expectedId} className="mb-1 block text-sm font-medium">
            What should your program do?
          </label>
          <textarea
            id={expectedId}
            rows={2}
            value={expected}
            onChange={(event) => setExpected(event.target.value)}
            className="w-full rounded-md border border-line-strong bg-surface p-2 text-sm text-ink"
          />
        </div>
      )}
      {check.running ? (
        <Button size="sm" onClick={check.cancel}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={noKey}
          onClick={() =>
            void check.run({
              ...(exercise ? { exerciseId: exercise.id } : {}),
              ...(expected.trim() ? { expectedBehavior: expected.trim() } : {}),
            })
          }
        >
          <ListChecks aria-hidden="true" />
          Cross-check my code
        </Button>
      )}
      {check.running ? <p className="text-xs text-ink-muted">Reading your code...</p> : null}
      <TaskFailure error={check.error} />
      {check.response && result ? (
        <AiResultFrame
          meta={check.response}
          source="code-cross-check"
          question="Cross-check my code"
          answer={JSON.stringify(result)}
        >
          <Badge tone={MATCH[result.matchesExpected].tone}>
            {MATCH[result.matchesExpected].label}
          </Badge>
          <AiMarkdown text={result.behaviorSummary} />
          <BulletList title="Where it differs from what is expected" items={result.mismatches} />
          {result.testInputs.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">More inputs to try</h3>
              <ul className="space-y-2">
                {result.testInputs.map((test) => (
                  <li key={test.input} className="rounded-md border border-line p-2 text-sm">
                    <p>{test.why}</p>
                    <pre className="mt-1 overflow-x-auto rounded-sm bg-surface-2 p-1 font-mono text-xs">
                      {test.input || '(empty input)'}
                    </pre>
                    {test.expected ? (
                      <p className="mt-1 text-xs text-ink-muted">Should print: {test.expected}</p>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-ml-2"
                      onClick={() => onUseStdin(test.input)}
                    >
                      Use as input
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <BulletList title="Style" items={result.styleNotes} />
          <div>
            <h3 className="text-sm font-medium">Complexity</h3>
            <AiMarkdown text={result.complexity} />
          </div>
          <BulletList
            title="How your approach differs from the reference"
            items={result.differencesFromReference}
          />
        </AiResultFrame>
      ) : null}
    </div>
  );
}

export interface LabHelpRequest {
  id: number;
  question: string;
}

/**
 * Part 8's program debugging and code cross-check. Hints come first by default, and a full fix is
 * always a diff the student accepts or rejects. This is the lab's AI help tab, in its own chunk.
 */
export default function LabHelp({
  run,
  files,
  exercise,
  request,
  onReplaceFile,
  onUseStdin,
}: {
  run: LabRunState;
  files: readonly LabFile[];
  exercise: LabExerciseView | null;
  /** A question from elsewhere in the lab, such as a build error's Explain button. */
  request: LabHelpRequest | null;
  onReplaceFile: (name: string, content: string) => void;
  onUseStdin: (stdin: string) => void;
}) {
  const [view, setView] = useState<View>('chat');
  const [socratic, setSocratic] = useState(true);
  const [ask, setAsk] = useState<AskRequest | null>(null);
  const groupName = useId();
  const problems = useMemo(() => detectLabProblems(run), [run]);

  useEffect(() => {
    if (request) {
      setView('chat');
      setAsk({ id: `outside-${request.id}`, question: request.question });
    }
  }, [request]);

  const askAbout = (problem: LabProblem) => {
    setView('chat');
    setAsk({ id: `${problem.kind}-${Date.now()}`, question: problem.question });
  };

  return (
    <div className="flex h-full min-h-96 flex-col gap-2 p-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          name={groupName}
          legend="AI help"
          value={view}
          options={VIEWS}
          onChange={setView}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={socratic}
            onChange={(event) => setSocratic(event.target.checked)}
          />
          Hints first (Socratic)
        </label>
      </div>

      {problems.length > 0 ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Ask about the last run">
          {problems.map((problem) => (
            <Button key={problem.kind} size="sm" onClick={() => askAbout(problem)}>
              {problem.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">
          When a run goes wrong, you can ask about the error, a conflict or a crash here.
        </p>
      )}

      <div hidden={view !== 'chat'} className="min-h-80 flex-1">
        <AskAiPanel
          conversationId={`lab:${exercise?.id ?? 'practice'}`}
          label="Ask about your code"
          placeholder="Ask about your code or the last run"
          request={ask}
          socratic={socratic}
          className="h-full"
        />
      </div>
      <div hidden={view !== 'fix'} className="overflow-y-auto">
        <FixPanel
          problems={problems}
          socratic={socratic}
          files={files}
          onReplaceFile={onReplaceFile}
        />
      </div>
      <div hidden={view !== 'check'} className="overflow-y-auto">
        <CrossCheckPanel exercise={exercise} onUseStdin={onUseStdin} />
      </div>
    </div>
  );
}
