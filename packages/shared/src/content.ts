import { z } from 'zod';
import { VISUALIZER_IDS } from './constants';

const slug = z.string().regex(/^[a-z0-9-]+$/);
const text = z.string().trim().min(1);

export const ModuleSchema = z.strictObject({
  id: slug,
  number: z.number().int().min(0),
  title: text,
  summary: text,
  /** True for the phases drawn on the source-to-target pipeline. */
  pipelineStage: z.boolean(),
  optional: z.boolean(),
  /** The Part 14 milestone that delivers this module's lessons. */
  lessonsMilestone: z.number().int().min(2).max(12),
  topics: z.array(text).min(1),
  visualizers: z.array(text),
});

export const ModuleListSchema = z.array(ModuleSchema);

export type CourseModule = z.infer<typeof ModuleSchema>;

/** A lesson's frontmatter. The lesson body is MDX. */
export const LessonMetaSchema = z.strictObject({
  id: slug,
  /** The course module, which is the phase this topic belongs to. */
  module: slug,
  title: text,
  /** Position within the module. */
  order: z.number().int().min(1),
  estimatedMinutes: z.number().int().min(1).max(180),
  /** Topic ids to study first. */
  prerequisites: z.array(slug),
  outcomes: z.array(text).min(1),
  /** Shown beside the lesson, in tabs. */
  visualizers: z.array(
    z.strictObject({
      id: z.enum(VISUALIZER_IDS),
      label: text.optional(),
      /** Starting input, such as { regex: "(a|b)*abb" }. */
      props: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

export type LessonMeta = z.infer<typeof LessonMetaSchema>;

export interface LessonSummary extends LessonMeta {
  /** Path of the MDX file within packages/content/lessons, with forward slashes. */
  path: string;
}

const questionFields = {
  id: slug,
  prompt: text,
  hint: text,
  solution: text,
  explanation: text,
  difficulty: z.enum(['easy', 'medium', 'hard']),
  tags: z.array(text).min(1),
  /** The exam styles this question suits. */
  exams: z.array(z.enum(['GATE', 'university'])).min(1),
};

const McqSchema = z.strictObject({
  ...questionFields,
  type: z.literal('mcq'),
  options: z.array(text).min(2).max(6),
  /** Index into options. */
  answer: z.number().int().min(0),
});

/** Answered in words, then compared with `solution` by the student. */
const ShortAnswerSchema = z.strictObject({ ...questionFields, type: z.literal('short') });

/** Answered with a regular expression, which the engine checks for equivalence to `reference`. */
const RegexProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('regex'),
  reference: text,
  /** Examples that must be in the language. Tests check these against `reference`. */
  accepts: z.array(z.string()),
  /** Examples that must not be in the language. */
  rejects: z.array(z.string()),
});

export const QuizQuestionSchema = z.discriminatedUnion('type', [McqSchema, ShortAnswerSchema]);
export const PracticeProblemSchema = z.discriminatedUnion('type', [
  McqSchema,
  ShortAnswerSchema,
  RegexProblemSchema,
]);

export const FlashcardSchema = z.strictObject({
  front: text,
  back: text,
  tags: z.array(text).min(1),
});

/** Everything on a topic page besides the lesson text. */
export const TopicBankSchema = z
  .strictObject({
    summary: z.array(text).min(2),
    quiz: z.array(QuizQuestionSchema),
    practice: z.array(PracticeProblemSchema).min(3).max(10),
    flashcards: z.array(FlashcardSchema).min(3),
  })
  .superRefine((bank, context) => {
    for (const [section, questions] of [
      ['quiz', bank.quiz],
      ['practice', bank.practice],
    ] as const) {
      questions.forEach((question, index) => {
        if (question.type === 'mcq' && question.answer >= question.options.length) {
          context.addIssue({
            code: 'custom',
            path: [section, index, 'answer'],
            message: 'The answer index is past the end of the options.',
          });
        }
      });
    }
    const mcqCount = bank.quiz.filter((question) => question.type === 'mcq').length;
    if (mcqCount < 5 || mcqCount > 10) {
      context.addIssue({
        code: 'custom',
        path: ['quiz'],
        message: `A quiz needs 5 to 10 multiple-choice questions, and this has ${mcqCount}.`,
      });
    }
    if (!bank.quiz.some((question) => question.type === 'short')) {
      context.addIssue({
        code: 'custom',
        path: ['quiz'],
        message: 'A quiz needs at least one short-answer question.',
      });
    }
    const ids = [...bank.quiz, ...bank.practice].map((question) => question.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      context.addIssue({
        code: 'custom',
        path: ['quiz'],
        message: `The question id ${duplicate} is used twice.`,
      });
    }
  });

export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;
export type PracticeProblem = z.infer<typeof PracticeProblemSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;
export type TopicBank = z.infer<typeof TopicBankSchema>;

/** Progress only moves forward: the API can record new facts but never erases old ones. */
export const TopicProgressPatchSchema = z.strictObject({
  read: z.literal(true).optional(),
  visualizerUsed: z.literal(true).optional(),
  quizScore: z.number().int().min(0).max(100).optional(),
});

export type TopicProgressPatch = z.infer<typeof TopicProgressPatchSchema>;
