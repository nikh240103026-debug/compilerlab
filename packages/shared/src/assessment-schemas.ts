import { z } from 'zod';
import { AiGeneratedQuestionSchema } from './ai-schemas';
import { ASSESSMENT_MODES, QUESTION_DIFFICULTIES, QUESTION_TYPES } from './assessment';

const slug = z.string().regex(/^[a-z0-9-]+$/);
const limitedText = z.string().max(20_000);
const questionKey = z.string().min(1).max(300);

/** Starting a test. What is left out takes the same default the setup form starts from. */
export const AttemptConfigSchema = z.strictObject({
  mode: z.enum(ASSESSMENT_MODES),
  title: z.string().trim().min(1).max(120).optional(),
  topicIds: z.array(slug).max(300).default([]),
  moduleIds: z.array(slug).max(20).default([]),
  questionCount: z.number().int().min(1).max(100).default(10),
  durationMinutes: z.number().int().min(1).max(600).nullable().default(null),
  totalMarks: z.number().int().min(1).max(1000).nullable().default(null),
  negativeFraction: z.number().min(0).max(1).default(0),
  negativeMcqOnly: z.boolean().default(true),
  mix: z
    .partialRecord(z.enum(QUESTION_TYPES), z.number().int().min(0).max(100))
    .nullable()
    .default(null),
  difficulty: z.enum(['any', ...QUESTION_DIFFICULTIES]).default('any'),
  exam: z.enum(['any', 'GATE', 'university']).default('any'),
  generated: z.enum(['none', 'reviewed', 'all']).default('reviewed'),
  retryOf: z.string().max(64).nullable().default(null),
});

const DrawnAutomatonSchema = z.strictObject({
  states: z
    .array(
      z.strictObject({
        id: z.string().max(80),
        label: z.string().max(40),
        accepting: z.boolean(),
        x: z.number(),
        y: z.number(),
      }),
    )
    .max(200),
  transitions: z
    .array(
      z.strictObject({
        id: z.string().max(80),
        from: z.string().max(80),
        to: z.string().max(80),
        label: z.string().max(200),
      }),
    )
    .max(1000),
  startId: z.string().max(80).nullable(),
});

const QuestionAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mcq'), choice: z.number().int().min(0).nullable() }),
  z.strictObject({ type: z.literal('multi'), choices: z.array(z.number().int().min(0)).max(20) }),
  z.strictObject({ type: z.literal('short'), text: limitedText }),
  z.strictObject({ type: z.literal('regex'), text: limitedText }),
  z.strictObject({ type: z.literal('fill'), blanks: z.array(limitedText).max(50) }),
  z.strictObject({
    type: z.literal('match'),
    choices: z.array(z.number().int().min(0).nullable()).max(50),
  }),
  z.strictObject({ type: z.literal('order'), order: z.array(z.number().int().min(0)).max(50) }),
  z.strictObject({ type: z.literal('table'), cells: z.record(z.string().max(300), limitedText) }),
  z.strictObject({ type: z.literal('automaton'), drawing: DrawnAutomatonSchema }),
  z.strictObject({ type: z.literal('grammar'), text: limitedText }),
  z.strictObject({ type: z.literal('trace'), moves: z.array(z.string().max(1000)).max(2000) }),
  z.strictObject({ type: z.literal('output'), text: limitedText }),
]);

const GradeResultSchema = z.strictObject({
  verdict: z.enum(['correct', 'partial', 'incorrect', 'pending', 'unanswered']),
  score: z.number().min(0).max(1),
  summary: limitedText,
  details: z.array(limitedText).max(200),
  gradedBy: z.enum(['answer-key', 'engine', 'self', 'ai']),
  counterexample: limitedText.optional(),
  parts: z.record(z.string().max(300), z.boolean()).optional(),
  expected: z.record(z.string().max(300), limitedText).optional(),
});

export const SaveAnswerSchema = z.strictObject({
  key: questionKey,
  answer: QuestionAnswerSchema.nullable(),
  grade: GradeResultSchema.nullable().optional(),
  seconds: z.number().int().min(0).max(100_000),
  flagged: z.boolean(),
  currentIndex: z.number().int().min(0).max(1000),
});

export const FinishAttemptSchema = z.strictObject({
  grades: z.record(questionKey, GradeResultSchema),
});

export const MarkAnswerSchema = z.strictObject({
  key: questionKey,
  grade: GradeResultSchema,
});

export const FlashcardReviewSchema = z.strictObject({
  key: z.string().min(1).max(200),
  /** SM-2's grade. */
  quality: z.number().int().min(0).max(5),
});

export const SaveGeneratedSchema = z.strictObject({
  topicId: slug,
  difficulty: z.enum(QUESTION_DIFFICULTIES),
  model: z.string().max(200).nullable(),
  questions: z.array(AiGeneratedQuestionSchema).min(1).max(20),
});

export const UpdateGeneratedSchema = z.strictObject({ reviewed: z.boolean() });
