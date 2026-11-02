import type { QuizQuestion } from '@compilerlab/shared';
import { QUIZ_PASS_SCORE } from '@compilerlab/shared/progress';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Question, type Outcome } from './question';

/** A whole-number percentage, or null until every question has been answered. */
export function quizScore(outcomes: readonly Outcome[], total: number): number | null {
  const answered = outcomes.filter((outcome) => outcome !== null).length;
  if (total === 0 || answered < total) return null;
  const correct = outcomes.filter((outcome) => outcome === 'correct').length;
  return Math.round((correct / total) * 100);
}

export function Quiz({
  questions,
  onComplete,
}: {
  questions: readonly QuizQuestion[];
  onComplete: (score: number) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[]>(() => questions.map(() => null));
  const score = quizScore(outcomes, questions.length);
  const answered = outcomes.filter((outcome) => outcome !== null).length;

  const record = (index: number, outcome: Outcome) => {
    const next = outcomes.slice();
    next[index] = outcome;
    setOutcomes(next);
    const finished = quizScore(next, questions.length);
    if (finished !== null) onComplete(finished);
  };

  return (
    <div>
      <ol className="space-y-3">
        {questions.map((question, index) => (
          <Question
            key={`${attempt}-${question.id}`}
            question={question}
            number={index + 1}
            onAnswer={(outcome) => record(index, outcome)}
          />
        ))}
      </ol>
      <div
        role="status"
        className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 p-3 text-sm"
      >
        {score === null ? (
          <span className="text-ink-muted">
            {answered} of {questions.length} answered.
          </span>
        ) : (
          <>
            <span className="font-medium">
              You scored {score}%.{' '}
              {score >= QUIZ_PASS_SCORE
                ? 'That passes this topic.'
                : `${QUIZ_PASS_SCORE}% passes, so it is worth another look.`}
            </span>
            <Button
              size="sm"
              onClick={() => {
                setAttempt(attempt + 1);
                setOutcomes(questions.map(() => null));
              }}
            >
              <RotateCcw aria-hidden="true" />
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
