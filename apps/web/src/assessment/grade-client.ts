import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { runEngineJob } from '@/visualizers/engine/client';

/**
 * Marks an answer in the Web Worker. A job that fails, say because the worker hit its time limit,
 * should not cost the student the marks, so the answer waits for a self-mark instead.
 */
export async function gradeInWorker(
  question: PracticeProblem,
  answer: QuestionAnswer | null,
): Promise<GradeResult> {
  const result = await runEngineJob('gradeAnswer', { question, answer });
  if (result.ok) return result.value;
  return {
    verdict: 'pending',
    score: 0,
    summary: `The engine could not mark this answer, so please mark it yourself. ${result.error.message}`,
    details: result.error.hint ? [result.error.hint] : [],
    gradedBy: 'self',
  };
}
