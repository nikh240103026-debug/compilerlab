import { isAiUnavailable } from '@compilerlab/shared/ai';
import { CircleHelp, Eye, Lightbulb, Square } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { findVisualizer } from '@/visualizers/registry';
import { AiAnswer, AiResultFrame } from './ai-answer';
import { AiMarkdown } from './ai-markdown';
import { currentVisualizerInput, useAiContextSection } from './context-store';
import { AiOfflineNotice, useAiHasNoKey } from './offline-notice';
import { useAiStream } from './use-ai-stream';
import { useAiTask } from './use-ai-task';

interface StepView {
  readonly title: string;
  readonly explanation: string;
  readonly state?: unknown;
}

function stateAsText(state: unknown): string | undefined {
  try {
    return JSON.stringify(state);
  } catch {
    return undefined;
  }
}

const WHY_QUESTION = 'Why did this step happen?';

function WhyAnswer() {
  const stream = useAiStream();
  const { send } = stream;
  const noKey = useAiHasNoKey();

  // The timer stops a development double-run from asking twice.
  useEffect(() => {
    if (noKey) return;
    const timer = setTimeout(() => send({ question: WHY_QUESTION }), 0);
    return () => clearTimeout(timer);
  }, [noKey, send]);

  if (noKey) return <AiOfflineNotice compact />;
  return (
    <div className="space-y-1">
      {stream.status !== 'idle' && (stream.text || stream.streaming) ? (
        <AiAnswer
          text={stream.text}
          streaming={stream.streaming}
          note={stream.note}
          meta={stream.meta}
          question={WHY_QUESTION}
          source="visualizer-why"
          onStop={stream.cancel}
        />
      ) : null}
      {stream.error ? <AiOfflineNotice error={stream.error} compact /> : null}
    </div>
  );
}

const VERDICT = {
  correct: { label: 'Correct', tone: 'success' },
  partly: { label: 'Partly right', tone: 'warning' },
  incorrect: { label: 'Not quite', tone: 'danger' },
} as const;

function PredictPanel({
  current,
  next,
  onReveal,
}: {
  current: StepView;
  next: StepView | null;
  onReveal: () => void;
}) {
  const [guess, setGuess] = useState('');
  const check = useAiTask('predict-check');
  const noKey = useAiHasNoKey();
  const id = useId();

  if (!next) {
    return <p className="text-sm text-ink-muted">This is the last step, so nothing comes next.</p>;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (noKey || !guess.trim()) return;
    void check.run({
      guess,
      current: { title: current.title, explanation: current.explanation },
      actual: { title: next.title, explanation: next.explanation },
    });
  };

  const result = check.response;
  return (
    <form onSubmit={submit} className="space-y-2">
      <div>
        <label htmlFor={id} className="mb-1 block text-sm font-medium">
          What do you think happens next?
        </label>
        <textarea
          id={id}
          rows={2}
          value={guess}
          onChange={(event) => setGuess(event.target.value)}
          className="w-full rounded-md border border-line-strong bg-surface p-2 text-sm text-ink"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {noKey ? null : check.running ? (
          <Button size="sm" onClick={check.cancel}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button size="sm" type="submit" disabled={!guess.trim()}>
            <Lightbulb aria-hidden="true" />
            Check my guess
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onReveal}>
          <Eye aria-hidden="true" />
          Show the next step
        </Button>
      </div>
      {noKey ? (
        <p className="text-xs text-ink-muted">
          AI checking is off without a Gemini key. You can still write your guess, then show the
          next step and compare them yourself.
        </p>
      ) : null}
      {check.running ? (
        <p className="text-xs text-ink-muted">Comparing with the engine...</p>
      ) : null}
      {check.error ? (
        isAiUnavailable(check.error.code) ? (
          <AiOfflineNotice error={check.error} compact />
        ) : (
          <p role="alert" className="text-sm text-danger">
            {check.error.message}
          </p>
        )
      ) : null}
      {result ? (
        <AiResultFrame
          meta={result}
          source="predict-check"
          question={`Predicted: ${guess}`}
          answer={result.data.feedback}
        >
          <Badge tone={VERDICT[result.data.verdict].tone}>
            {VERDICT[result.data.verdict].label}
          </Badge>
          <AiMarkdown text={result.data.feedback} />
        </AiResultFrame>
      ) : null}
    </form>
  );
}

/**
 * Part 8's visualizer companion, shown under the step caption. The engine's own next step is what a
 * prediction is checked against, so the AI can only compare and never invent a result.
 */
export default function StepCompanion({
  name,
  index,
  total,
  step,
  next,
  onPause,
  onReveal,
}: {
  name: string;
  index: number;
  total: number;
  step: StepView;
  next: StepView | null;
  onPause: () => void;
  onReveal: () => void;
}) {
  // An answer belongs to the step it was asked on, so moving on hides it.
  const [whyStep, setWhyStep] = useState<number | null>(null);
  const [whyAsks, setWhyAsks] = useState(0);
  const [predicting, setPredicting] = useState(false);

  useAiContextSection('visualizer', () => ({
    id: name,
    title: findVisualizer(name)?.title,
    input: currentVisualizerInput(),
    step: index + 1,
    stepCount: total,
    stepTitle: step.title,
    stepExplanation: step.explanation,
    state: stateAsText(step.state),
  }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onPause();
            setWhyStep(index);
            setWhyAsks((count) => count + 1);
          }}
        >
          <CircleHelp aria-hidden="true" />
          Why did this step happen?
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={predicting}
          onClick={() => {
            onPause();
            setPredicting((current) => !current);
          }}
        >
          <Lightbulb aria-hidden="true" />
          Predict the next step
        </Button>
      </div>
      {whyStep === index ? <WhyAnswer key={`${index}-${whyAsks}`} /> : null}
      {predicting ? (
        <PredictPanel key={index} current={step} next={next} onReveal={onReveal} />
      ) : null}
    </div>
  );
}
