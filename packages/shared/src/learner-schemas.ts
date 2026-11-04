import { z } from 'zod';
import {
  DELETE_EVERYTHING_WORD,
  isCalendarDay,
  LEARNER_LIMITS,
  SEARCH_KINDS,
  STUDY_AREAS,
  type SearchKind,
} from './learner';

const slug = z.string().regex(/^[a-z0-9-]+$/);
const text = z.string().trim().min(1);
const calendarDay = z.string().refine(isCalendarDay, 'Use a date like 2027-05-20.');
const difficulty = z.enum(['easy', 'medium', 'hard']);
const examStyle = z.enum(['GATE', 'university']);

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

export const StudyTimeReportSchema = z.strictObject({
  day: calendarDay,
  seconds: z.number().int().min(1).max(LEARNER_LIMITS.heartbeatSeconds),
  area: z.enum(STUDY_AREAS),
  topicId: slug.max(200).optional(),
});
export type StudyTimeReport = z.infer<typeof StudyTimeReportSchema>;

export const NoteSaveSchema = z.strictObject({
  body: z.string().max(LEARNER_LIMITS.noteChars, 'This note is too long to save.'),
});

/**
 * The quote keeps the words around it, so it can be found again in the page even if the lesson
 * around it is edited later, and two identical phrases stay apart.
 */
export const HighlightCreateSchema = z.strictObject({
  topicId: slug.max(200),
  quote: z.string().min(1).max(LEARNER_LIMITS.quoteChars, 'Select a shorter passage to highlight.'),
  prefix: z.string().max(LEARNER_LIMITS.quoteContextChars),
  suffix: z.string().max(LEARNER_LIMITS.quoteContextChars),
});
export type HighlightCreate = z.infer<typeof HighlightCreateSchema>;

const PlacementResultSchema = z.strictObject({
  takenAt: z.string().max(40),
  correct: z.number().int().min(0),
  total: z.number().int().min(0),
  answers: z.array(z.strictObject({ moduleId: slug, correct: z.boolean() })).max(40),
  recommendedModule: slug.nullable(),
  recommendedTopic: slug.nullable(),
  reason: text.max(400),
});
export type PlacementResult = z.infer<typeof PlacementResultSchema>;

export const OnboardingStateSchema = z.strictObject({
  tour: z.enum(['pending', 'done', 'skipped']),
  placement: z.enum(['pending', 'done', 'skipped']),
  result: PlacementResultSchema.nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const ExamPlanSchema = z.strictObject({
  name: z.string().trim().max(120),
  date: calendarDay.nullable(),
  /** A preset's id, "custom", or null if none is picked yet. */
  syllabusId: slug.nullable(),
  /** The topics of a custom syllabus. */
  customTopics: z.array(slug).max(500),
  hoursPerDay: z.number().min(0.25).max(24),
});
export type ExamPlan = z.infer<typeof ExamPlanSchema>;

export const DeleteEverythingSchema = z.strictObject({
  confirm: z.literal(DELETE_EVERYTHING_WORD),
});

export const SearchQuerySchema = z.object({
  q: z.string().trim().max(LEARNER_LIMITS.searchQueryChars).default(''),
  kinds: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? [...SEARCH_KINDS]
        : (value
            .split(',')
            .filter((kind): kind is SearchKind =>
              (SEARCH_KINDS as readonly string[]).includes(kind),
            ) as SearchKind[]),
    ),
  limit: z.coerce.number().int().min(1).max(LEARNER_LIMITS.searchResults).default(20),
});

export const DashboardQuerySchema = z.object({ today: calendarDay });

// ---------------------------------------------------------------------------------------------
// Data files in packages/content/data. See docs/CONTENT_GUIDE.md.
// ---------------------------------------------------------------------------------------------

export const GlossaryTermSchema = z.strictObject({
  term: text.max(120),
  definition: text.max(2000),
  /** The course module where a student meets this term first. */
  module: slug,
  /** Other glossary terms, written exactly as they appear in their own `term`. */
  related: z.array(text).max(20).default([]),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

export interface GlossaryEntry extends GlossaryTerm {
  slug: string;
}

const SyllabusItemSchema = z.strictObject({
  id: slug,
  title: text,
  /** The course module this item belongs to. */
  module: slug,
  /** Exact topic ids. Wins over `match`. */
  topics: z.array(slug).optional(),
  /** Words to look for in a topic's id or title within the module. Leave out to take them all. */
  match: z.array(text).min(1).optional(),
});
export type SyllabusItem = z.infer<typeof SyllabusItemSchema>;

export const SyllabusSchema = z.strictObject({
  id: slug,
  name: text,
  kind: z.enum(['exam', 'university']),
  /** Where this came from, and what to check against. */
  note: text,
  items: z.array(SyllabusItemSchema).min(1),
});
export type Syllabus = z.infer<typeof SyllabusSchema>;

export const SyllabusListSchema = z.array(SyllabusSchema).min(1);

const CheatEntrySchema = z.strictObject({
  label: text,
  text: text.optional(),
  /** Set in a monospaced block, keeping its line breaks. */
  code: text.optional(),
});

export const CheatSheetSchema = z.strictObject({
  id: slug,
  title: text,
  module: slug,
  sections: z
    .array(z.strictObject({ heading: text, entries: z.array(CheatEntrySchema).min(1) }))
    .min(1),
});
export type CheatSheet = z.infer<typeof CheatSheetSchema>;

export const CheatSheetListSchema = z.array(CheatSheetSchema);

export const TopQuestionSchema = z.strictObject({
  id: slug,
  question: text,
  answer: text,
  module: slug,
  marks: z.number().int().min(1).max(20),
  difficulty,
  exams: z.array(examStyle).min(1),
});
export type TopQuestion = z.infer<typeof TopQuestionSchema>;

export const TopQuestionListSchema = z.array(TopQuestionSchema);

const workedFields = {
  id: slug,
  title: text,
  module: slug,
  statement: text,
  /** Where the book works the same example, when it does. */
  reference: text.optional(),
};

const WrittenStepSchema = z.strictObject({
  title: text,
  explanation: text,
  code: text.optional(),
});

/** The engine solves every method except `written`, so its answer cannot disagree with the book. */
export const WorkedProblemSchema = z.discriminatedUnion('method', [
  z.strictObject({ ...workedFields, method: z.literal('first-follow'), grammar: text }),
  z.strictObject({ ...workedFields, method: z.literal('ll1-table'), grammar: text }),
  z.strictObject({
    ...workedFields,
    method: z.literal('lr-table'),
    grammar: text,
    kind: z.enum(['lr0', 'slr', 'lr1', 'lalr']),
  }),
  z.strictObject({ ...workedFields, method: z.literal('left-recursion'), grammar: text }),
  z.strictObject({
    ...workedFields,
    method: z.literal('shift-reduce'),
    grammar: text,
    sentence: text,
    parser: z.enum(['lr0', 'slr', 'lr1', 'lalr']),
  }),
  z.strictObject({
    ...workedFields,
    method: z.literal('operator-precedence'),
    grammar: text,
    precedence: z.string(),
    sentence: text,
  }),
  z.strictObject({ ...workedFields, method: z.literal('thompson'), regex: text }),
  z.strictObject({ ...workedFields, method: z.literal('subset'), regex: text }),
  z.strictObject({ ...workedFields, method: z.literal('minimize'), regex: text }),
  z.strictObject({ ...workedFields, method: z.literal('followpos'), regex: text }),
  z.strictObject({
    ...workedFields,
    method: z.literal('written'),
    steps: z.array(WrittenStepSchema).min(1),
    answer: text,
  }),
]);
export type WorkedProblem = z.infer<typeof WorkedProblemSchema>;

export const WorkedProblemListSchema = z.array(WorkedProblemSchema);

export const PlacementQuestionSchema = z
  .strictObject({
    id: slug,
    module: slug,
    prompt: text,
    options: z.array(text).min(2).max(5),
    answer: z.number().int().min(0),
    explanation: text,
  })
  .refine((question) => question.answer < question.options.length, {
    path: ['answer'],
    message: 'The answer index is past the end of the options.',
  });
export type PlacementQuestion = z.infer<typeof PlacementQuestionSchema>;

export const PlacementQuizSchema = z.array(PlacementQuestionSchema).min(1);

/** Everything the exam prep center reads from the data files. */
export interface ExamResources {
  syllabi: Syllabus[];
  cheatSheets: CheatSheet[];
  topQuestions: TopQuestion[];
  workedProblems: WorkedProblem[];
}

// ---------------------------------------------------------------------------------------------
// What the notes, bookmarks and highlights routes return
// ---------------------------------------------------------------------------------------------

export interface LessonNote {
  topicId: string;
  body: string;
  /** ISO times, in UTC. */
  createdAt: string;
  updatedAt: string;
}

export interface LessonBookmark {
  topicId: string;
  createdAt: string;
}

export interface LessonHighlight extends HighlightCreate {
  id: number;
  createdAt: string;
}

export interface Notebook {
  notes: LessonNote[];
  bookmarks: LessonBookmark[];
  highlights: LessonHighlight[];
}
