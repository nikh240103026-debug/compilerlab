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

/** Every box that must be ticked, and no others. */
const MultiSelectSchema = z.strictObject({
  ...questionFields,
  type: z.literal('multi'),
  options: z.array(text).min(2).max(8),
  /** Indexes into options. */
  answers: z.array(z.number().int().min(0)).min(1),
});

/** Answered in words. The student marks it against `solution`, or AI grades it if a key exists. */
const ShortAnswerSchema = z.strictObject({
  ...questionFields,
  type: z.literal('short'),
  /** What earns marks, for AI grading. Without one, the AI writes its own marking points. */
  rubric: z.array(z.strictObject({ point: text, marks: z.number().positive() })).optional(),
});

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

/** A sentence with gaps. Each run of three or more underscores in `text` is one blank. */
const FillBlankSchema = z.strictObject({
  ...questionFields,
  type: z.literal('fill'),
  text,
  /** For each blank in order, every answer that counts as right. */
  blanks: z.array(z.array(text).min(1)).min(1),
  /** Blanks ignore case and extra spaces unless this is true. */
  caseSensitive: z.boolean().optional(),
});

const MatchSchema = z.strictObject({
  ...questionFields,
  type: z.literal('match'),
  left: z.array(text).min(2).max(10),
  /** May hold more items than `left`, as distractors. Shown in the order written here. */
  right: z.array(text).min(2).max(12),
  /** For each item of `left`, the index in `right` that matches it. */
  pairs: z.array(z.number().int().min(0)),
});

/** Steps of a derivation, a parse or an algorithm. Written in the right order, then shuffled. */
const OrderSchema = z.strictObject({
  ...questionFields,
  type: z.literal('order'),
  items: z.array(text).min(2).max(12),
});

export const LR_PARSER_KINDS = ['lr0', 'slr', 'lalr', 'lr1'] as const;

/** Which table to complete. For all but `values`, the engine works out the right answers. */
const TableSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('first-follow'),
    grammar: text,
    /** Which columns to ask for. Both, if this is left out. */
    sets: z
      .array(z.enum(['first', 'follow']))
      .min(1)
      .optional(),
  }),
  z.strictObject({ kind: z.literal('ll1'), grammar: text }),
  z.strictObject({
    kind: z.literal('lr'),
    grammar: text,
    parser: z.enum(LR_PARSER_KINDS),
    /** `all` blanks every cell. `reduce` shows shifts and GOTOs, and asks only for reductions. */
    blanks: z.enum(['all', 'reduce']).optional(),
  }),
  z.strictObject({
    kind: z.literal('values'),
    columns: z.array(text).min(1),
    rows: z.array(text).min(1),
    /** One row of cells for each row. An empty string means the cell should stay empty. */
    answers: z.array(z.array(z.string())).min(1),
    /** True for a cell shown already filled in. Same shape as `answers`. */
    given: z.array(z.array(z.boolean())).optional(),
    caseSensitive: z.boolean().optional(),
  }),
]);

const TableProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('table'),
  table: TableSpecSchema,
});

/** Drawn on the canvas. The engine compares its language with `reference`, a regular expression. */
const AutomatonProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('automaton'),
  /** `dfa` also requires at most one move per symbol from each state. `nfa` allows anything. */
  machine: z.enum(['dfa', 'nfa']),
  reference: text,
  /** Asks for a machine this small, such as the minimal DFA. */
  maxStates: z.number().int().min(1).max(40).optional(),
});

/** Answered with a grammar, which the engine's parser tries on every example. */
const GrammarProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('grammar'),
  /** Sentences it must derive, with spaces between terminals. "" is the empty sentence. */
  accepts: z.array(z.string()).min(1),
  /** Sentences it must not derive. */
  rejects: z.array(z.string()),
  requires: z
    .array(z.enum(['ll1', 'no-left-recursion', 'unambiguous']))
    .min(1)
    .optional(),
});

/** Answered with the parser's moves, in order, which are compared with the engine's own trace. */
const TraceProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('trace'),
  grammar: text,
  /** The sentence to parse, with spaces between tokens. */
  input: z.string(),
  parser: z.enum(['ll1', ...LR_PARSER_KINDS]),
});

/** What does this program print? */
const OutputProblemSchema = z.strictObject({
  ...questionFields,
  type: z.literal('output'),
  code: text,
  language: z.enum(['c', 'cpp', 'lex', 'yacc', 'tac', 'text']),
  /** Compared ignoring line endings, and spaces at the ends of lines and of the whole output. */
  expected: z.string(),
});

export const PracticeProblemSchema = z.discriminatedUnion('type', [
  McqSchema,
  MultiSelectSchema,
  ShortAnswerSchema,
  RegexProblemSchema,
  FillBlankSchema,
  MatchSchema,
  OrderSchema,
  TableProblemSchema,
  AutomatonProblemSchema,
  GrammarProblemSchema,
  TraceProblemSchema,
  OutputProblemSchema,
]);

/** A quiz can use every question type. See TopicBankSchema for what it must contain. */
export const QuizQuestionSchema = PracticeProblemSchema;

const BLANK = /_{3,}/g;

/** How many blanks a fill-in-the-blank sentence has. */
export function countBlanks(sentence: string): number {
  return sentence.match(BLANK)?.length ?? 0;
}

/** What a schema cannot express about one question. Each problem has a path inside the question. */
export function questionProblems(
  question: z.infer<typeof PracticeProblemSchema>,
): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string) => problems.push({ path, message });
  switch (question.type) {
    case 'mcq':
      if (question.answer >= question.options.length) {
        add(['answer'], 'The answer index is past the end of the options.');
      }
      break;
    case 'multi':
      if (question.answers.some((answer) => answer >= question.options.length)) {
        add(['answers'], 'An answer index is past the end of the options.');
      }
      if (new Set(question.answers).size !== question.answers.length) {
        add(['answers'], 'An answer index is listed twice.');
      }
      break;
    case 'fill':
      if (countBlanks(question.text) !== question.blanks.length) {
        add(
          ['blanks'],
          `The text has ${countBlanks(question.text)} blanks, but ${question.blanks.length} sets of answers.`,
        );
      }
      break;
    case 'match':
      if (question.pairs.length !== question.left.length) {
        add(['pairs'], 'There must be one entry in pairs for each item of left.');
      }
      if (question.pairs.some((pair) => pair >= question.right.length)) {
        add(['pairs'], 'An index in pairs is past the end of right.');
      }
      break;
    case 'table': {
      const { table } = question;
      if (table.kind !== 'values') break;
      const fits = (rows: readonly (readonly unknown[])[]) =>
        rows.length === table.rows.length &&
        rows.every((row) => row.length === table.columns.length);
      if (!fits(table.answers)) {
        add(['table', 'answers'], 'Each row of answers must have one cell for each column.');
      }
      if (table.given && !fits(table.given)) {
        add(['table', 'given'], 'given must have the same rows and columns as answers.');
      }
      break;
    }
    case 'grammar': {
      const clash = question.accepts.find((sentence) => question.rejects.includes(sentence));
      if (clash !== undefined) add(['rejects'], `"${clash}" is in both accepts and rejects.`);
      break;
    }
    default:
      break;
  }
  return problems;
}

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
        for (const { path, message } of questionProblems(question)) {
          context.addIssue({ code: 'custom', path: [section, index, ...path], message });
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
