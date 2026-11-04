// The assessment's worker jobs, spread into engine/jobs.ts as the parsing ones are. The engine stays
// off the main thread and out of the page chunks, so a test page loads quickly.
import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { gradeAnswer } from './grade';
import { buildQuestionModel, type QuestionModel } from './question-model';

export interface AssessmentJobTypes {
  gradeAnswer: {
    input: { question: PracticeProblem; answer: QuestionAnswer | null };
    output: GradeResult;
  };
  questionModel: { input: { question: PracticeProblem }; output: QuestionModel | null };
}

export const assessmentHandlers: {
  [K in keyof AssessmentJobTypes]: (
    input: AssessmentJobTypes[K]['input'],
  ) => AssessmentJobTypes[K]['output'];
} = {
  gradeAnswer: ({ question, answer }) => gradeAnswer(question, answer),
  questionModel: ({ question }) => buildQuestionModel(question),
};
