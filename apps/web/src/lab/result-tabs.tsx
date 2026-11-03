import type { LabCheckResult, LabDiagnostic, LabOutcome } from '@compilerlab/shared';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ErrorPanel, useAskAi } from '@/components/error-panel';
import { SplitPane } from '@/components/split-pane';
import { ToolFix } from '@/components/system-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { findVisualizer } from '@/visualizers/registry';
import type { LabRunState, LabStepView } from './lab-run';
import type { TerminalHandle } from './terminal-pane';

const TerminalPane = lazy(() => import('./terminal-pane'));
const ReadOnlyCode = lazy(() =>
  import('./code-editor').then((module) => ({ default: module.ReadOnlyCode })),
);
const TokenStream = lazy(async () => {
  const entry = findVisualizer('token-stream');
  if (!entry) throw new Error('The token stream visualizer is missing.');
  return entry.load();
});

const TABS = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'build', label: 'Build log' },
  { id: 'output', label: 'Output' },
  { id: 'generated', label: 'Generated files' },
  { id: 'tokens', label: 'Token stream' },
  { id: 'visual', label: 'Visual trace' },
  { id: 'tests', label: 'Tests' },
] as const;

export type ResultTab = (typeof TABS)[number]['id'];

/** How much of a long token stream is drawn. The rest is summarized. */
const MAX_TOKEN_ROWS = 1000;

function PaneFallback() {
  return <Skeleton className="m-2 h-24" />;
}

function SimulatedNote({ run }: { run: LabRunState }) {
  if (run.engine !== 'simulated') return null;
  return (
    <p className="mb-2 flex items-start gap-2 rounded-md border border-warning p-2 text-xs">
      <Badge tone="warning">Simulated</Badge>
      <span>{run.note}</span>
    </p>
  );
}

function EmptyPane({ children }: { children: ReactNode }) {
  return <p className="p-1 text-sm text-ink-muted">{children}</p>;
}

function OutcomeIcon({ outcome }: { outcome: LabOutcome | null }) {
  if (outcome === null) {
    return (
      <CircleDashed aria-hidden="true" className="size-4 shrink-0 animate-pulse text-ink-muted" />
    );
  }
  if (outcome === 'ok') {
    return <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />;
  }
  if (outcome === 'failed' || outcome === 'crashed' || outcome === 'missing_tool') {
    return <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />;
  }
  return <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />;
}

function StepRow({ step, showMessage }: { step: LabStepView; showMessage: boolean }) {
  return (
    <li className="rounded-md border border-line p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeIcon outcome={step.outcome} />
        <span className="font-medium">{step.label}</span>
        <code className="min-w-0 truncate font-mono text-xs text-ink-muted">{step.command}</code>
        {step.durationMs !== null ? (
          <span className="ml-auto text-xs text-ink-muted">{step.durationMs} ms</span>
        ) : null}
      </div>
      {step.message && showMessage ? <p className="mt-1 text-xs">{step.message}</p> : null}
      {step.id !== 'run' && step.output ? (
        <pre className="mt-1 max-h-40 overflow-auto rounded-sm bg-surface-2 p-1 font-mono text-xs whitespace-pre-wrap">
          {step.output}
        </pre>
      ) : null}
    </li>
  );
}

function DiagnosticRow({
  item,
  onGoToLine,
}: {
  item: LabDiagnostic;
  onGoToLine: (file: string, line: number, column: number | null) => void;
}) {
  const askAi = useAskAi();
  const where =
    item.file && item.line !== null ? `${item.file}, line ${item.line}` : (item.file ?? item.tool);
  return (
    <li className="rounded-md border border-line p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {item.severity === 'error' ? (
          <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
        ) : (
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
        )}
        {item.file && item.line !== null ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onGoToLine(item.file as string, item.line as number, item.column)}
          >
            {where}
          </Button>
        ) : (
          <span className="text-xs font-medium">{where}</span>
        )}
        <span className="text-xs text-ink-muted">
          {item.tool} {item.severity}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() =>
            askAi(
              `I got this ${item.tool} ${item.severity} in ${where}: "${item.message}". What does it mean, and how do I fix it?`,
            )
          }
        >
          <Sparkles aria-hidden="true" />
          Ask AI
        </Button>
      </div>
      <p className="mt-1 font-mono text-xs">{item.message}</p>
      {item.explanation ? <p className="mt-1">{item.explanation}</p> : null}
    </li>
  );
}

function BuildLog({
  run,
  onGoToLine,
}: {
  run: LabRunState;
  onGoToLine: (file: string, line: number, column: number | null) => void;
}) {
  const askAi = useAskAi();
  const notes = run.diagnostics.filter((item) => item.severity !== 'note');
  if (run.status === 'idle')
    return <EmptyPane>Run your code to see each build step here.</EmptyPane>;
  return (
    <div className="space-y-2">
      <SimulatedNote run={run} />
      {run.error ? (
        <div role="alert" className="rounded-md border border-danger p-2 text-sm">
          <p className="font-medium">{run.error.message}</p>
          {run.error.hint ? <p className="mt-1 text-ink-muted">{run.error.hint}</p> : null}
          {run.error.fix.length > 0 ? (
            <div className="mt-2">
              <ToolFix lines={run.error.fix} />
            </div>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => askAi(`The lab says: "${run.error?.message}" What should I do?`)}
          >
            <Sparkles aria-hidden="true" />
            Ask AI
          </Button>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <section aria-label="Problems">
          <ul className="space-y-2">
            {notes.map((item, index) => (
              <DiagnosticRow key={index} item={item} onGoToLine={onGoToLine} />
            ))}
          </ul>
        </section>
      ) : null}
      <ol aria-label="Build steps" className="space-y-1">
        {run.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            // A step that failed on a listed problem would only repeat it.
            showMessage={!notes.some((item) => item.message === step.message)}
          />
        ))}
      </ol>
    </div>
  );
}

function OutputPane({ run }: { run: LabRunState }) {
  if (run.status === 'idle') return <EmptyPane>What your program prints appears here.</EmptyPane>;
  return (
    <div>
      <SimulatedNote run={run} />
      {run.programOutput.length === 0 ? (
        <EmptyPane>Your program has not printed anything.</EmptyPane>
      ) : (
        <pre
          data-testid="program-output"
          className="font-mono text-[0.8125rem] leading-snug whitespace-pre-wrap"
        >
          {run.programOutput.map((part, index) => (
            <span key={index} className={part.stream === 'stderr' ? 'text-danger' : undefined}>
              {part.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function GeneratedPane({ run, fontSize }: { run: LabRunState; fontSize: number }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const selectId = useId();
  if (run.engine === 'simulated') {
    return (
      <div>
        <SimulatedNote run={run} />
        <EmptyPane>
          Simulated mode runs your rules directly, so it does not write a lex.yy.c file. Install
          flex and gcc to see the code flex generates.
        </EmptyPane>
      </div>
    );
  }
  if (run.generated.length === 0) {
    return (
      <EmptyPane>Files the tools generate, like lex.yy.c, appear here after a Lex run.</EmptyPane>
    );
  }
  const file = run.generated.find((item) => item.name === chosen) ?? run.generated[0];
  if (!file) return null;
  return (
    <div className="flex h-full min-h-56 flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-xs font-medium">
          File
        </label>
        <NativeSelect
          id={selectId}
          value={file.name}
          className="w-auto"
          onChange={(event) => setChosen(event.target.value)}
        >
          {run.generated.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <Badge>Read only</Badge>
        {file.truncated ? (
          <span className="text-xs text-warning">Only the start is shown.</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-line">
        <Suspense fallback={<PaneFallback />}>
          <ReadOnlyCode name={file.name} content={file.content} fontSize={fontSize} />
        </Suspense>
      </div>
    </div>
  );
}

function TokensPane({ run }: { run: LabRunState }) {
  const tokens = run.tokens;
  const ruleText = useMemo(
    () => new Map(tokens?.rules.map((rule) => [rule.line, rule.text]) ?? []),
    [tokens],
  );
  if (!tokens) {
    return (
      <EmptyPane>Run a Lex program to see which rule matched each piece of the input.</EmptyPane>
    );
  }
  if (tokens.matches.length === 0) {
    return (
      <div>
        <SimulatedNote run={run} />
        <EmptyPane>No rule fired, because the scanner did not read any input.</EmptyPane>
      </div>
    );
  }
  const shown = tokens.matches.slice(0, MAX_TOKEN_ROWS);
  return (
    <div>
      <SimulatedNote run={run} />
      <p className="mb-1 text-xs text-ink-muted">
        {run.engine === 'real'
          ? 'From your compiled scanner, reported by flex -d.'
          : 'From the built-in teaching engine.'}
        {tokens.truncated || tokens.matches.length > MAX_TOKEN_ROWS
          ? ` Showing the first ${shown.length} matches.`
          : ''}
      </p>
      <table data-testid="token-table" className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="py-1 pr-2 font-semibold">
              Line
            </th>
            <th scope="col" className="py-1 pr-2 font-semibold">
              Rule
            </th>
            <th scope="col" className="py-1 font-semibold">
              Matched text
            </th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {shown.map((match, index) => (
            <tr key={index} className="border-b border-line">
              <td className="py-0.5 pr-2">{match.ruleLine ?? ''}</td>
              <td className="py-0.5 pr-2">
                {match.ruleLine === null
                  ? 'default rule (echo)'
                  : (ruleText.get(match.ruleLine) ?? '')}
              </td>
              <td className="py-0.5">{match.text.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisualPane({ run, active }: { run: LabRunState; active: boolean }) {
  const visual = run.visual;
  if (!visual) {
    return (
      <EmptyPane>
        After a Lex run, this replays the same rules and input in the teaching engine, step by step.
      </EmptyPane>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-muted">
        This is the teaching engine replaying your rules on the same input. It shows the theory
        behind the run, and is not output from the real tools.
      </p>
      {visual.omitted.length > 0 ? (
        <ul className="list-disc rounded-md border border-warning p-2 pl-6 text-xs">
          {visual.omitted.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {visual.rules && active ? (
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorPanel
              title="The visual trace could not be shown"
              message={describeError(error)}
              onRetry={reset}
            />
          )}
        >
          <Suspense fallback={<PaneFallback />}>
            <TokenStream
              key={`${visual.rules}\n${visual.source}`}
              initial={{ rules: visual.rules, source: visual.source }}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}

function TestRow({ result }: { result: LabCheckResult }) {
  return (
    <li className="rounded-md border border-line p-2 text-sm">
      <div className="flex items-center gap-2">
        {result.passed ? (
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
        ) : (
          <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />
        )}
        <span className="font-medium">{result.name}</span>
        {result.hidden ? <Badge>Hidden</Badge> : null}
        <span className="ml-auto text-xs">{result.passed ? 'Passed' : 'Failed'}</span>
      </div>
      {!result.passed && !result.hidden ? (
        <dl className="mt-1 grid gap-1 text-xs md:grid-cols-3">
          {(
            [
              ['Input', result.input],
              ['Expected', result.expected],
              ['Your output', result.actual],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-medium">{label}</dt>
              <dd>
                <pre className="overflow-x-auto rounded-sm bg-surface-2 p-1 font-mono">
                  {value || '(empty)'}
                </pre>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!result.passed && result.outcome !== 'ok' ? (
        <p className="mt-1 text-xs text-ink-muted">
          {result.outcome === 'timeout'
            ? 'The program ran out of time on this test.'
            : 'The program did not finish normally on this test.'}
        </p>
      ) : null}
    </li>
  );
}

function TestsPane({ run }: { run: LabRunState }) {
  if (!run.check) {
    return <EmptyPane>Press Check to run the tests for this exercise.</EmptyPane>;
  }
  const passed = run.check.results.filter((result) => result.passed).length;
  return (
    <div>
      <SimulatedNote run={run} />
      <p
        role="status"
        className={cn('mb-2 text-sm font-medium', run.check.passed ? 'text-success' : '')}
      >
        {run.check.passed
          ? `All ${run.check.results.length} tests passed.`
          : `${passed} of ${run.check.results.length} tests passed.`}
      </p>
      <ul aria-label="Test results" className="space-y-1">
        {run.check.results.map((result) => (
          <TestRow key={result.name} result={result} />
        ))}
      </ul>
    </div>
  );
}

export function ResultTabs({
  run,
  tab,
  onTab,
  stdin,
  onStdin,
  terminalRef,
  fontSize,
  onGoToLine,
}: {
  run: LabRunState;
  tab: ResultTab;
  onTab: (tab: ResultTab) => void;
  stdin: string;
  onStdin: (value: string) => void;
  terminalRef: Ref<TerminalHandle>;
  fontSize: number;
  onGoToLine: (file: string, line: number, column: number | null) => void;
}) {
  const baseId = useId();
  const stdinId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((item) => item.id === tab);
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const move = step[event.key];
    let next: ResultTab | undefined;
    if (move !== undefined) next = TABS[(index + move + TABS.length) % TABS.length]?.id;
    if (event.key === 'Home') next = TABS[0]?.id;
    if (event.key === 'End') next = TABS.at(-1)?.id;
    if (next) {
      event.preventDefault();
      onTab(next);
      document.getElementById(`${baseId}-tab-${next}`)?.focus();
    }
  };

  const problems = run.diagnostics.filter((item) => item.severity === 'error').length;

  return (
    <SplitPane
      storageKey="lab-results"
      label="Resize the input and results"
      defaultRatio={0.24}
      min={0.15}
      max={0.5}
      start={
        <div className="flex h-full min-h-32 flex-col">
          <label htmlFor={stdinId} className="mb-1 text-xs font-medium">
            Input (stdin)
          </label>
          <textarea
            id={stdinId}
            value={stdin}
            spellCheck={false}
            className="min-h-0 w-full flex-1 resize-none rounded-md border border-line-strong bg-surface p-2 font-mono text-[0.8125rem] leading-snug text-ink"
            onChange={(event) => onStdin(event.target.value)}
          />
        </div>
      }
      end={
        <div className="flex h-full min-h-56 flex-col">
          <div
            role="tablist"
            aria-label="Results"
            className="flex shrink-0 flex-wrap gap-0.5 border-b border-line"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                id={`${baseId}-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`${baseId}-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                className={cn(
                  '-mb-px rounded-t-sm border-b-2 px-2 py-1 text-xs font-medium',
                  tab === item.id
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
                onClick={() => onTab(item.id)}
                onKeyDown={onKeyDown}
              >
                {item.label}
                {item.id === 'build' && problems > 0 ? ` (${problems})` : ''}
              </button>
            ))}
          </div>
          <p role="status" className="sr-only">
            {run.status === 'running'
              ? 'Running.'
              : (run.done?.message ?? run.error?.message ?? '')}
          </p>
          <div className="min-h-0 flex-1 pt-1">
            {TABS.map((item) => (
              <div
                key={item.id}
                id={`${baseId}-panel-${item.id}`}
                role="tabpanel"
                aria-labelledby={`${baseId}-tab-${item.id}`}
                hidden={tab !== item.id}
                // These scroll, so keyboard users need to be able to reach them.
                tabIndex={item.id === 'terminal' ? undefined : 0}
                className={cn(
                  'h-full',
                  item.id !== 'terminal' && item.id !== 'generated' && 'overflow-y-auto',
                )}
              >
                {item.id === 'terminal' ? (
                  <Suspense fallback={<PaneFallback />}>
                    <TerminalPane ref={terminalRef} fontSize={fontSize} />
                  </Suspense>
                ) : null}
                {item.id === 'build' ? <BuildLog run={run} onGoToLine={onGoToLine} /> : null}
                {item.id === 'output' ? <OutputPane run={run} /> : null}
                {item.id === 'generated' && tab === 'generated' ? (
                  <GeneratedPane run={run} fontSize={fontSize} />
                ) : null}
                {item.id === 'tokens' ? <TokensPane run={run} /> : null}
                {item.id === 'visual' ? <VisualPane run={run} active={tab === 'visual'} /> : null}
                {item.id === 'tests' ? <TestsPane run={run} /> : null}
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}
