import type { PracticeProblem } from '@compilerlab/shared';
import { Check, Lightbulb, Sparkles, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useAskAi } from '@/components/error-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { runEngineJob } from '@/visualizers/engine/client';

export type Outcome = 'correct' | 'incorrect' | null;

function Explanation({ question, outcome }: { question: PracticeProblem; outcome: Outcome }) {
  const askAi = useAskAi();
  return (
    <div className="mt-3 rounded-md bg-surface-2 p-3 text-sm">
      <p className="font-medium">Solution</p>
      <p className="mt-0.5 whitespace-pre-line">{question.solution}</p>
      <p className="mt-2 font-medium">Why</p>
      <p className="mt-0.5 text-ink-muted">{question.explanation}</p>
      {outcome === 'incorrect' ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 -ml-2"
          onClick={() =>
            void askAi(`I got this question wrong: "${question.prompt}" Can you explain it?`, {
              quiz: {
                question: question.prompt,
                ...(question.type === 'mcq' ? { options: question.options } : {}),
                correctAnswer: question.solution,
              },
            })
          }
        >
          <Sparkles aria-hidden="true" />
          Ask AI
        </Button>
      ) : null}
    </div>
  );
}

function McqBody({
  question,
  onAnswer,
}: {
  question: Extract<PracticeProblem, { type: 'mcq' }>;
  onAnswer: (outcome: Outcome) => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const groupName = useId();
  const outcome: Outcome = !checked ? null : chosen === question.answer ? 'correct' : 'incorrect';

  return (
    <>
      <fieldset disabled={checked}>
        <legend className="sr-only">Choose one answer</legend>
        <ul className="space-y-1.5">
          {question.options.map((option, index) => {
            const isAnswer = checked && index === question.answer;
            const isWrongChoice = checked && index === chosen && !isAnswer;
            return (
              <li key={index}>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
                    isAnswer
                      ? 'border-success'
                      : isWrongChoice
                        ? 'border-danger'
                        : 'border-line hover:bg-surface-2'
                  }`}
                >
                  <input
                    type="radio"
                    name={groupName}
                    className="mt-1"
                    checked={chosen === index}
                    onChange={() => setChosen(index)}
                  />
                  <span className="min-w-0 flex-1">{option}</span>
                  {isAnswer ? (
                    <Check aria-label="Correct answer" className="size-4 shrink-0 text-success" />
                  ) : isWrongChoice ? (
                    <X aria-label="Your answer" className="size-4 shrink-0 text-danger" />
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {checked ? (
        <>
          <p
            role="status"
            className={`mt-2 text-sm font-medium ${outcome === 'correct' ? 'text-success' : 'text-danger'}`}
          >
            {outcome === 'correct' ? 'Correct.' : 'Not quite.'}
          </p>
          <Explanation question={question} outcome={outcome} />
        </>
      ) : (
        <Button
          size="sm"
          className="mt-2"
          disabled={chosen === null}
          onClick={() => {
            setChecked(true);
            onAnswer(chosen === question.answer ? 'correct' : 'incorrect');
          }}
        >
          Check answer
        </Button>
      )}
    </>
  );
}

function ShortBody({
  question,
  onAnswer,
}: {
  question: Extract<PracticeProblem, { type: 'short' }>;
  onAnswer: (outcome: Outcome) => void;
}) {
  const [text, setText] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [marked, setMarked] = useState<Outcome>(null);
  const id = useId();

  return (
    <>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Your answer
      </label>
      <textarea
        id={id}
        rows={3}
        value={text}
        disabled={revealed}
        onChange={(event) => setText(event.target.value)}
        className="w-full rounded-md border border-line-strong bg-surface p-2 text-sm"
      />
      {revealed ? (
        <>
          <Explanation question={question} outcome={marked} />
          {marked === null ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>How did you do?</span>
              <Button
                size="sm"
                onClick={() => {
                  setMarked('correct');
                  onAnswer('correct');
                }}
              >
                I got it
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMarked('incorrect');
                  onAnswer('incorrect');
                }}
              >
                Not yet
              </Button>
            </div>
          ) : (
            <p role="status" className="mt-2 text-sm text-ink-muted">
              Marked as {marked === 'correct' ? 'correct' : 'not yet'}.
            </p>
          )}
        </>
      ) : (
        <Button size="sm" className="mt-2" onClick={() => setRevealed(true)}>
          Show the solution
        </Button>
      )}
    </>
  );
}

function RegexBody({
  question,
  onAnswer,
}: {
  question: Extract<PracticeProblem, { type: 'regex' }>;
  onAnswer: (outcome: Outcome) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const id = useId();

  const check = async () => {
    const result = await runEngineJob('checkRegex', { answer, reference: question.reference });
    if (!result.ok) {
      setFeedback({
        tone: 'bad',
        text: `${result.error.message}${result.error.hint ? ` ${result.error.hint}` : ''}`,
      });
      return;
    }
    if (result.value.equivalent) {
      setFeedback({
        tone: 'good',
        text: 'Correct. Your expression describes exactly this language.',
      });
      onAnswer('correct');
      return;
    }
    const shown = result.value.witness === '' ? 'the empty string' : `"${result.value.witness}"`;
    setFeedback({
      tone: 'bad',
      text:
        result.value.acceptedBy === 'first'
          ? `Not quite. Your expression matches ${shown}, which is not in the language.`
          : `Not quite. Your expression misses ${shown}, which is in the language.`,
    });
    onAnswer('incorrect');
  };

  return (
    <>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Your regular expression
      </label>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <Input
          id={id}
          value={answer}
          spellCheck={false}
          autoComplete="off"
          className="max-w-sm font-mono"
          onChange={(event) => setAnswer(event.target.value)}
        />
        <Button size="md" type="submit" disabled={!answer.trim()}>
          Check with the engine
        </Button>
      </form>
      {feedback ? (
        <p
          role="status"
          className={`mt-2 text-sm ${feedback.tone === 'good' ? 'text-success' : 'text-danger'}`}
        >
          {feedback.text}
        </p>
      ) : null}
      {revealed ? (
        <Explanation question={question} outcome={null} />
      ) : (
        <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => setRevealed(true)}>
          Show the solution
        </Button>
      )}
    </>
  );
}

/** One question of any type: prompt, optional hint, answer, solution and explanation. */
export function Question({
  question,
  number,
  onAnswer,
}: {
  question: PracticeProblem;
  number: number;
  onAnswer?: (outcome: Outcome) => void;
}) {
  const [showHint, setShowHint] = useState(false);
  const report = (outcome: Outcome) => onAnswer?.(outcome);
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-ink-muted">Q{number}</span>
        <Badge>{question.difficulty}</Badge>
        {question.exams.map((exam) => (
          <Badge key={exam}>{exam === 'GATE' ? 'GATE' : 'University'}</Badge>
        ))}
      </div>
      <p className="mb-3 text-sm font-medium whitespace-pre-line">{question.prompt}</p>
      {question.type === 'mcq' ? <McqBody question={question} onAnswer={report} /> : null}
      {question.type === 'short' ? <ShortBody question={question} onAnswer={report} /> : null}
      {question.type === 'regex' ? <RegexBody question={question} onAnswer={report} /> : null}
      {showHint ? (
        <p className="mt-2 flex gap-1.5 text-sm text-ink-muted">
          <Lightbulb aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          {question.hint}
        </p>
      ) : (
        <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => setShowHint(true)}>
          <Lightbulb aria-hidden="true" />
          Show a hint
        </Button>
      )}
    </li>
  );
}
