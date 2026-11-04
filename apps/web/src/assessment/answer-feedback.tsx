import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useAskAi } from '@/components/error-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ExplainWrongAnswer, ShortAnswerAiGrade } from './ai-tools';
import { describeAnswer, optionsOf } from './answer-text';

const AutomatonFigure = lazy(() => import('@/visualizers/automaton-figure'));

const VERDICTS: Readonly<
  Record<GradeResult['verdict'], { icon: ReactNode; label: string; tone: string }>
> = {
  correct: {
    icon: <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />,
    label: 'Correct',
    tone: 'text-success',
  },
  partial: {
    icon: <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />,
    label: 'Partly right',
    tone: 'text-warning',
  },
  incorrect: {
    icon: <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />,
    label: 'Not quite',
    tone: 'text-danger',
  },
  pending: {
    icon: <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />,
    label: 'Waiting for a mark',
    tone: 'text-ink',
  },
  unanswered: {
    icon: <CircleMinus aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />,
    label: 'Not answered',
    tone: 'text-ink',
  },
};

const GRADED_BY: Readonly<Record<GradeResult['gradedBy'], string>> = {
  'answer-key': 'Answer key',
  engine: 'Checked by the engine',
  self: 'Marked by you',
  ai: 'AI-graded',
};

export function VerdictLabel({ verdict }: { verdict: GradeResult['verdict'] }) {
  const { icon, label, tone } = VERDICTS[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${tone}`}>
      {icon}
      {label}
    </span>
  );
}

function SelfMark({
  onMark,
  current,
}: {
  onMark: (grade: GradeResult) => void;
  current: GradeResult;
}) {
  const mark = (right: boolean) =>
    onMark({
      verdict: right ? 'correct' : 'incorrect',
      score: right ? 1 : 0,
      summary: right ? 'You marked this as right.' : 'You marked this as not yet right.',
      details: [],
      gradedBy: 'self',
    });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{current.verdict === 'pending' ? 'How did you do?' : 'Change your mark:'}</span>
      <Button size="sm" onClick={() => mark(true)}>
        I got it
      </Button>
      <Button size="sm" variant="ghost" onClick={() => mark(false)}>
        Not yet
      </Button>
    </div>
  );
}

/**
 * What a student sees once an answer is marked: the verdict and why, the solution, and help. With
 * `onMark`, a short answer can be self-marked, or AI-graded if there is a key.
 */
export function AnswerFeedback({
  question,
  answer,
  grade,
  topicId,
  marks,
  onMark,
}: {
  question: PracticeProblem;
  answer: QuestionAnswer | null;
  grade: GradeResult;
  topicId?: string | undefined;
  /** What this question is worth. */
  marks?: number | undefined;
  onMark?: ((grade: GradeResult) => void) | undefined;
}) {
  const askAi = useAskAi();
  const wrong = grade.verdict === 'incorrect' || grade.verdict === 'partial';
  const canSelfMark =
    Boolean(onMark) &&
    (grade.verdict === 'pending' || grade.gradedBy === 'self' || grade.gradedBy === 'ai');
  const expectedOutput = question.type === 'output' ? grade.expected?.[0] : undefined;
  const expectedMoves = question.type === 'trace' ? Object.values(grade.expected ?? {}) : [];

  return (
    <div className="mt-3 space-y-2 rounded-md bg-surface-2 p-3 text-sm">
      <div role="status" className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictLabel verdict={grade.verdict} />
          <Badge>{GRADED_BY[grade.gradedBy]}</Badge>
        </div>
        <p>{grade.summary}</p>
        {grade.details.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-ink-muted">
            {grade.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
        {grade.counterexample !== undefined ? (
          <p>
            Counterexample:{' '}
            <code className="font-mono">
              {grade.counterexample === '' ? 'the empty string' : `"${grade.counterexample}"`}
            </code>
          </p>
        ) : null}
      </div>

      {expectedOutput !== undefined ? (
        <div>
          <p className="font-medium">What it prints</p>
          <pre className="mt-0.5 overflow-x-auto font-mono text-[0.8125rem]">{expectedOutput}</pre>
        </div>
      ) : null}
      {expectedMoves.length > 0 && grade.verdict !== 'correct' ? (
        <details>
          <summary className="cursor-pointer font-medium">The parser's moves</summary>
          <ol className="mt-1 list-decimal pl-6 font-mono text-[0.8125rem]">
            {expectedMoves.map((move, index) => (
              <li key={index}>{move}</li>
            ))}
          </ol>
        </details>
      ) : null}

      <div>
        <p className="font-medium">Solution</p>
        <p className="mt-0.5 whitespace-pre-line">{question.solution}</p>
      </div>
      {question.type === 'automaton' && grade.verdict !== 'correct' ? (
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <AutomatonFigure
            regex={question.reference}
            show="minimal"
            caption="The minimal DFA for this language, which the engine computed"
          />
        </Suspense>
      ) : null}
      <div>
        <p className="font-medium">Why</p>
        <p className="mt-0.5 text-ink-muted">{question.explanation}</p>
      </div>

      {canSelfMark && onMark ? (
        <div className="space-y-2 border-t border-line pt-2">
          <SelfMark onMark={onMark} current={grade} />
          {question.type === 'short' && answer?.type === 'short' ? (
            <ShortAnswerAiGrade
              question={question}
              text={answer.text}
              maxMarks={marks ?? 1}
              topicId={topicId}
              onGraded={onMark}
            />
          ) : null}
        </div>
      ) : null}

      {wrong ? (
        <div className="space-y-1 border-t border-line pt-2">
          <ExplainWrongAnswer question={question} answer={answer} grade={grade} topicId={topicId} />
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2"
            onClick={() =>
              void askAi(`I got this question wrong: "${question.prompt}" Can you explain it?`, {
                quiz: {
                  question: question.prompt,
                  ...(optionsOf(question) ? { options: optionsOf(question) } : {}),
                  studentAnswer: describeAnswer(question, answer),
                  correctAnswer: question.solution,
                },
              })
            }
          >
            <Sparkles aria-hidden="true" />
            Ask AI
          </Button>
        </div>
      ) : null}
    </div>
  );
}
