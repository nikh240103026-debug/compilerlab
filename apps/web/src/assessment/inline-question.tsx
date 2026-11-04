import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { isAnswerEmpty } from '@compilerlab/shared/assessment';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AnswerFeedback } from './answer-feedback';
import { AnswerInput } from './answer-input';
import { gradeInWorker } from './grade-client';

/**
 * A question answered on the spot, in a lesson or the list of AI-generated questions. This file is
 * the lazy part of a lesson's Question, so a lesson only pays for it if a question needs it.
 */
export default function InlineQuestion({
  question,
  topicId,
  allowRetry = true,
  onAnswer,
}: {
  question: PracticeProblem;
  topicId?: string | undefined;
  /** A quiz counts the first try, so it turns this off. */
  allowRetry?: boolean | undefined;
  onAnswer?: ((right: boolean) => void) | undefined;
}) {
  const [answer, setAnswer] = useState<QuestionAnswer | null>(null);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const applyGrade = (next: GradeResult) => {
    setGrade(next);
    if (next.verdict !== 'pending') onAnswer?.(next.verdict === 'correct');
  };

  const check = async () => {
    setChecking(true);
    applyGrade(await gradeInWorker(question, answer));
    setChecking(false);
  };

  return (
    <>
      <AnswerInput
        key={attempt}
        question={question}
        value={answer}
        onChange={setAnswer}
        disabled={grade !== null}
        grade={grade}
      />
      {grade ? (
        <>
          <AnswerFeedback
            question={question}
            answer={answer}
            grade={grade}
            topicId={topicId}
            onMark={applyGrade}
          />
          {allowRetry && grade.verdict !== 'correct' && grade.verdict !== 'pending' ? (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => {
                setGrade(null);
                setAttempt(attempt + 1);
              }}
            >
              <RotateCcw aria-hidden="true" />
              Change my answer
            </Button>
          ) : null}
        </>
      ) : (
        <Button
          size="sm"
          className="mt-2"
          disabled={checking || isAnswerEmpty(answer)}
          onClick={() => void check()}
        >
          {checking ? 'Checking...' : 'Check answer'}
        </Button>
      )}
    </>
  );
}
