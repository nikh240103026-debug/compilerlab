import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { AI_LIMITS, clipAiText, isAiUnavailable } from '@compilerlab/shared/ai';
import { Sparkles, Square } from 'lucide-react';
import { AiResultFrame } from '@/ai/ai-answer';
import { AiMarkdown } from '@/ai/ai-markdown';
import { AiOfflineNotice, useAiHasNoKey } from '@/ai/offline-notice';
import { useAiTask } from '@/ai/use-ai-task';
import { Button } from '@/components/ui/button';
import { describeAnswer, optionsOf } from './answer-text';

const clip = (text: string) => clipAiText(text, AI_LIMITS.excerpt);

/** A failed request: a calm notice if AI is simply unavailable, and the reason if not. */
function TaskProblem({ error }: { error: { code: string; message: string } | null }) {
  if (!error) return null;
  return isAiUnavailable(error.code) ? (
    <AiOfflineNotice error={error} compact />
  ) : (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  );
}

/** Asks the AI why an answer is wrong. The right answer is given to it, and it cannot change it. */
export function ExplainWrongAnswer({
  question,
  answer,
  grade,
  topicId,
}: {
  question: PracticeProblem;
  answer: QuestionAnswer | null;
  grade: GradeResult | null;
  topicId?: string | undefined;
}) {
  const task = useAiTask('wrong-answer-explain');
  const noKey = useAiHasNoKey();
  const result = task.response?.data;
  // Without a key the solution and explanation are still on the page, so nothing more is needed.
  if (noKey) return null;

  const studentAnswer = describeAnswer(question, answer);
  const engineFindings = grade ? [grade.summary, ...grade.details].filter(Boolean).join(' ') : '';
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
            void task.run(
              {
                question: clip(question.prompt),
                ...(optionsOf(question)
                  ? {
                      options: (optionsOf(question) as string[])
                        .slice(0, 8)
                        .map((option) => option.slice(0, AI_LIMITS.label)),
                    }
                  : {}),
                correctAnswer: clip(question.solution),
                studentAnswer: clip(studentAnswer),
                explanation: clip(question.explanation),
                ...(topicId ? { topicId } : {}),
              },
              engineFindings
                ? {
                    context: {
                      engine: [
                        {
                          label: 'How this answer was marked',
                          result: engineFindings.slice(0, AI_LIMITS.engineResultChars),
                        },
                      ],
                    },
                  }
                : {},
            )
          }
        >
          <Sparkles aria-hidden="true" />
          Explain my mistake
        </Button>
      )}
      {task.running ? <p className="text-xs text-ink-muted">Writing an explanation...</p> : null}
      <TaskProblem error={task.error} />
      {task.response && result ? (
        <AiResultFrame
          meta={task.response}
          source="wrong-answer-explain"
          question={question.prompt}
          answer={JSON.stringify(result)}
          topicId={topicId}
        >
          <AiMarkdown text={`**Why your answer does not work.** ${result.whyWrong}`} />
          <AiMarkdown text={`**Why the right answer works.** ${result.whyCorrect}`} />
          <AiMarkdown text={`**What probably happened.** ${result.misconception}`} />
          <AiMarkdown text={`**Try this.** ${result.tryThis}`} />
        </AiResultFrame>
      ) : null}
    </div>
  );
}

/** AI marking of a short answer, against the question's rubric if it has one. */
export function ShortAnswerAiGrade({
  question,
  text,
  maxMarks,
  topicId,
  onGraded,
}: {
  question: Extract<PracticeProblem, { type: 'short' }>;
  text: string;
  maxMarks: number;
  topicId?: string | undefined;
  onGraded: (grade: GradeResult) => void;
}) {
  const task = useAiTask('short-answer-grade');
  const noKey = useAiHasNoKey();
  const result = task.response?.data;
  // With no key, marking yourself is the whole of it. This stays quiet rather than nag.
  if (noKey) return null;

  const rubricMarks = question.rubric?.reduce((sum, { marks }) => sum + marks, 0);
  const outOf = rubricMarks ?? maxMarks;

  const grade = async () => {
    const response = await task.run({
      question: clip(question.prompt),
      studentAnswer: clip(text),
      modelAnswer: clip(question.solution),
      ...(question.rubric
        ? {
            rubric: question.rubric.map(({ point, marks }) => ({
              point: point.slice(0, AI_LIMITS.label),
              marks,
            })),
          }
        : {}),
      maxMarks: outOf,
      ...(topicId ? { topicId } : {}),
    });
    if (!response) return;
    const { data } = response;
    onGraded({
      verdict: data.verdict,
      score: outOf > 0 ? Math.min(1, data.marks / outOf) : 0,
      summary: `AI marked this ${data.marks} out of ${outOf}. ${data.feedback}`,
      details: data.rubric.map(
        ({ point, awarded, comment }) => `${point}: ${awarded} marks. ${comment}`,
      ),
      gradedBy: 'ai',
    });
  };

  return (
    <div className="space-y-2">
      {task.running ? (
        <Button size="sm" variant="ghost" className="-ml-2" onClick={task.cancel}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      ) : (
        <Button size="sm" variant="ghost" className="-ml-2" onClick={() => void grade()}>
          <Sparkles aria-hidden="true" />
          {result ? 'Grade again with AI' : 'Grade with AI'}
        </Button>
      )}
      {task.running ? <p className="text-xs text-ink-muted">Grading your answer...</p> : null}
      <TaskProblem error={task.error} />
      {task.response && result ? (
        <AiResultFrame
          meta={task.response}
          source="short-answer-grade"
          question={question.prompt}
          answer={JSON.stringify(result)}
          topicId={topicId}
        >
          <p className="text-sm font-medium">
            {result.marks} out of {result.maxMarks} marks
          </p>
          <AiMarkdown text={result.feedback} />
          {result.rubric.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.rubric.map((item) => (
                <li key={item.point}>
                  {item.point}: {item.awarded}.{' '}
                  <span className="text-ink-muted">{item.comment}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <AiMarkdown text={`**A full-marks answer.** ${result.improvedAnswer}`} />
        </AiResultFrame>
      ) : null}
    </div>
  );
}
