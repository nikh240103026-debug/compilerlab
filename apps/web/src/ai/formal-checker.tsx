import { isAiUnavailable } from '@compilerlab/shared/ai';
import { CircleCheck, CircleX, Sparkles, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiResultFrame } from './ai-answer';
import { AiMarkdown } from './ai-markdown';
import { AiOfflineNotice, useAiHasNoKey } from './offline-notice';
import { useAiTask } from './use-ai-task';

/** What the engine found. The AI explains this, and never gets to change it. */
export interface EngineCheck {
  correct: boolean;
  /** One sentence, such as "This grammar is not LL(1)". */
  summary: string;
  /** Details the engine computed, such as a conflict in a table cell. */
  findings?: readonly string[];
  /** A string that shows the difference, such as one the automaton wrongly accepts. */
  counterexample?: string | undefined;
}

export interface FormalCheckProps {
  kind: 'grammar' | 'dfa' | 'nfa' | 'regex';
  /** The student's work as text, such as a grammar or a list of transitions. */
  submission: string;
  /** What it was meant to do. */
  goal?: string | undefined;
  check: EngineCheck;
}

/** The "explain in words" half: put this under a verdict that is already on screen. */
export function FormalCheckExplain({ kind, submission, goal, check }: FormalCheckProps) {
  const task = useAiTask('formal-check-explain');
  const noKey = useAiHasNoKey();
  const result = task.response?.data;

  if (noKey) return <AiOfflineNotice compact />;

  return (
    <div className="space-y-2">
      {task.running ? (
        <Button size="sm" variant="ghost" className="-ml-2" onClick={task.cancel}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2"
          onClick={() =>
            void task.run({
              kind,
              submission,
              ...(goal ? { goal } : {}),
              engine: {
                correct: check.correct,
                summary: check.summary,
                findings: [...(check.findings ?? [])],
                ...(check.counterexample !== undefined
                  ? { counterexample: check.counterexample }
                  : {}),
              },
            })
          }
        >
          <Sparkles aria-hidden="true" />
          {check.correct ? 'Explain why this works' : 'Explain my mistakes in words'}
        </Button>
      )}
      {task.running ? <p className="text-xs text-ink-muted">Writing an explanation...</p> : null}
      {task.error ? (
        isAiUnavailable(task.error.code) ? (
          <AiOfflineNotice error={task.error} compact />
        ) : (
          <p role="alert" className="text-sm text-danger">
            {task.error.message}
          </p>
        )
      ) : null}
      {task.response && result ? (
        <AiResultFrame
          meta={task.response}
          source="formal-check-explain"
          question={`Explain the check of this ${kind}: ${submission}`}
          answer={JSON.stringify(result)}
        >
          <p className="text-sm font-medium">{result.headline}</p>
          <AiMarkdown text={result.explanation} />
          {result.mistakes.length > 0 ? (
            <ul className="space-y-2">
              {result.mistakes.map((mistake) => (
                <li key={mistake.what} className="rounded-md border border-line p-2 text-sm">
                  <AiMarkdown text={`**${mistake.what}** ${mistake.why}`} />
                  <p className="mt-1 text-ink-muted">{mistake.fix}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-sm">
            <span className="font-medium">Next: </span>
            {result.nextStep}
          </p>
        </AiResultFrame>
      ) : null}
    </div>
  );
}

/**
 * Part 8's grammar and automata checker. Run the check in the engine, then pass its verdict here.
 * The verdict is shown as the engine's, so a wrong AI explanation can never change a result.
 *
 *   <FormalChecker kind="grammar" submission={text} check={{ correct, summary, findings }} />
 */
export function FormalChecker(props: FormalCheckProps) {
  const { check } = props;
  return (
    <section
      aria-label="Check result"
      className="space-y-2 rounded-md border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {check.correct ? (
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
        ) : (
          <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />
        )}
        <p role="status" className="text-sm font-medium">
          {check.summary}
        </p>
        <Badge className="ml-auto">Checked by the engine</Badge>
      </div>
      {check.findings?.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
          {check.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      ) : null}
      {check.counterexample !== undefined ? (
        <p className="text-sm">
          Counterexample:{' '}
          <code className="font-mono">
            {check.counterexample === '' ? 'the empty string' : `"${check.counterexample}"`}
          </code>
        </p>
      ) : null}
      <FormalCheckExplain {...props} />
    </section>
  );
}
