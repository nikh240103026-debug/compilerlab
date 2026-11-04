import { z } from 'zod';
import { AI_LEVELS, AI_LIMITS, AI_TASK_NAMES, type AiTaskName } from './ai';

const text = z.string().trim().min(1);
const slug = z.string().regex(/^[a-z0-9-]+$/);
const shortText = z.string().max(AI_LIMITS.label);
const passage = z.string().trim().min(1).max(AI_LIMITS.excerpt);
const difficulty = z.enum(['easy', 'medium', 'hard']);
const examStyle = z.enum(['GATE', 'university']);
const severity = z.enum(['high', 'medium', 'low']);

const FileSchema = z.strictObject({
  name: z.string().trim().min(1).max(AI_LIMITS.label),
  content: z.string().max(AI_LIMITS.fileChars),
});

export const AiContextSchema = z.strictObject({
  page: shortText.optional(),
  topic: z
    .strictObject({
      id: shortText,
      title: shortText.optional(),
      excerpt: z.string().max(AI_LIMITS.excerpt).optional(),
    })
    .optional(),
  visualizer: z
    .strictObject({
      id: shortText,
      title: shortText.optional(),
      input: z.string().max(AI_LIMITS.excerpt).optional(),
      step: z.number().int().min(0).optional(),
      stepCount: z.number().int().min(0).optional(),
      stepTitle: shortText.optional(),
      stepExplanation: z.string().max(AI_LIMITS.excerpt).optional(),
      state: z.string().max(AI_LIMITS.stateChars).optional(),
    })
    .optional(),
  lab: z
    .strictObject({
      exerciseId: shortText.optional(),
      exerciseTitle: shortText.optional(),
      exerciseBrief: z.string().max(AI_LIMITS.excerpt).optional(),
      pipeline: shortText.optional(),
      engine: shortText.optional(),
      activeFile: shortText.optional(),
      files: z.array(FileSchema).max(AI_LIMITS.files).optional(),
      stdin: z.string().max(AI_LIMITS.logChars).optional(),
      buildLog: z.string().max(AI_LIMITS.logChars).optional(),
      output: z.string().max(AI_LIMITS.logChars).optional(),
      diagnostics: z.array(z.string().max(AI_LIMITS.excerpt)).max(AI_LIMITS.diagnostics).optional(),
      tests: z
        .array(
          z.strictObject({
            name: shortText,
            passed: z.boolean(),
            hidden: z.boolean(),
            input: z.string().max(AI_LIMITS.testChars).optional(),
            expected: z.string().max(AI_LIMITS.testChars).optional(),
            actual: z.string().max(AI_LIMITS.testChars).optional(),
          }),
        )
        .max(AI_LIMITS.tests)
        .optional(),
    })
    .optional(),
  quiz: z
    .strictObject({
      question: z.string().max(AI_LIMITS.excerpt),
      options: z.array(shortText).max(8).optional(),
      studentAnswer: z.string().max(AI_LIMITS.excerpt).optional(),
      correctAnswer: z.string().max(AI_LIMITS.excerpt).optional(),
    })
    .optional(),
  engine: z
    .array(
      z.strictObject({
        label: shortText,
        result: z.string().max(AI_LIMITS.engineResultChars),
      }),
    )
    .max(AI_LIMITS.engineResults)
    .optional(),
});

const AiChatTurnSchema = z.strictObject({
  role: z.enum(['user', 'model']),
  text: z.string().max(AI_LIMITS.historyTurnChars),
});

export const AiChatRequestSchema = z.strictObject({
  question: z.string().trim().min(1, 'Type a question first.').max(AI_LIMITS.question),
  history: z.array(AiChatTurnSchema).max(AI_LIMITS.historyTurns).optional(),
  context: AiContextSchema.optional(),
  level: z.enum(AI_LEVELS).optional(),
  socratic: z.boolean().optional(),
  fresh: z.boolean().optional(),
});

export const AiTaskRequestSchema = z.strictObject({
  task: z.enum(AI_TASK_NAMES),
  input: z.unknown(),
  context: AiContextSchema.optional(),
  level: z.enum(AI_LEVELS).optional(),
  fresh: z.boolean().optional(),
});

export const AiFeedbackRequestSchema = z.strictObject({
  source: z.string().trim().min(1).max(AI_LIMITS.label),
  question: z.string().max(AI_LIMITS.question),
  answer: z.string().min(1).max(AI_LIMITS.notes),
  note: z.string().trim().max(AI_LIMITS.excerpt).optional(),
  topicId: shortText.optional(),
  model: shortText.optional(),
});

// The same fields as the course's own questions, so `<Question>` can show a generated one as is.
const generatedQuestionFields = {
  id: slug.describe('A short id of lowercase letters, digits and dashes, unique in this list.'),
  prompt: text,
  hint: text,
  solution: text,
  explanation: text.describe('Why the solution is right, including why the wrong answers fail.'),
  difficulty,
  tags: z.array(text).min(1),
  exams: z.array(examStyle).min(1),
};

export const AiGeneratedQuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...generatedQuestionFields,
    type: z.literal('mcq'),
    options: z.array(text).min(2).max(6),
    answer: z.number().int().min(0).describe('The index of the right option, counting from 0.'),
  }),
  z.strictObject({ ...generatedQuestionFields, type: z.literal('short') }),
]);

export type AiGeneratedQuestion = z.infer<typeof AiGeneratedQuestionSchema>;

const QuizGenerateOutput = z
  .strictObject({ questions: z.array(AiGeneratedQuestionSchema).min(1) })
  .superRefine(({ questions }, context) => {
    questions.forEach((question, index) => {
      if (question.type === 'mcq' && question.answer >= question.options.length) {
        context.addIssue({
          code: 'custom',
          path: ['questions', index, 'answer'],
          message: 'The answer index is past the end of the options.',
        });
      }
    });
    const ids = questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'Each question needs its own id.',
      });
    }
  });

const WrongAnswerOutput = z.strictObject({
  whyWrong: text.describe("Why the student's answer does not work."),
  whyCorrect: text.describe('Why the right answer is right.'),
  misconception: text.describe('The misunderstanding that probably led to this answer.'),
  tryThis: text.describe('One small thing to do or check next.'),
});

const ShortAnswerGradeOutput = z.strictObject({
  marks: z.number().min(0),
  maxMarks: z.number().min(0),
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  rubric: z.array(
    z.strictObject({
      point: text,
      awarded: z.number().min(0),
      comment: text,
    }),
  ),
  feedback: text,
  improvedAnswer: text.describe('A short model answer that would earn full marks.'),
});

const StudyPlanOutput = z.strictObject({
  summary: text,
  days: z
    .array(
      z.strictObject({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('The date, written as YYYY-MM-DD.'),
        focus: text,
        tasks: z
          .array(
            z.strictObject({
              task: text,
              minutes: z.number().int().min(1),
              topicId: z.string().optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  tips: z.array(text),
});

const ImportantQuestionsOutput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        question: text,
        why: text.describe('Why this question is likely, or what it tests.'),
        difficulty,
        marks: z.number().int().min(1),
        topicId: z.string().optional(),
        answerOutline: text,
      }),
    )
    .min(1),
});

const MockPaperOutput = z.strictObject({
  title: text,
  instructions: z.array(text),
  durationMinutes: z.number().int().min(1),
  totalMarks: z.number().min(0),
  sections: z
    .array(
      z.strictObject({
        title: text,
        questions: z
          .array(
            z.strictObject({
              type: z.enum(['mcq', 'short', 'long']),
              prompt: text,
              options: z.array(text).optional(),
              marks: z.number().min(0),
              topicId: z.string().optional(),
              answer: text.describe('The right option or a marking outline.'),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

const VivaTurnOutput = z.strictObject({
  evaluation: z
    .strictObject({
      score: z.number().min(0).max(10),
      feedback: text,
      missedPoints: z.array(text),
    })
    .optional()
    .describe("Left out only when there is no answer to judge yet, on the viva's first turn."),
  nextQuestion: text,
  done: z.boolean().describe('True when the viva has covered enough to stop.'),
});

const RevisionSheetOutput = z.strictObject({
  title: text,
  sections: z.array(z.strictObject({ heading: text, points: z.array(text).min(1) })).min(1),
  formulas: z.array(z.strictObject({ name: text, formula: text, note: z.string() })),
  traps: z.array(text).describe('Common mistakes to avoid in an exam.'),
});

const MnemonicSheetOutput = z.strictObject({
  title: text,
  mnemonics: z.array(z.strictObject({ concept: text, mnemonic: text, expansion: text })).min(1),
  cheatSheet: z.array(z.strictObject({ heading: text, items: z.array(text).min(1) })),
});

const TopicSummaryOutput = z.strictObject({
  title: text,
  summary: text,
  keyPoints: z.array(text).min(1),
  terms: z.array(z.strictObject({ term: text, meaning: text })),
  commonMistakes: z.array(text),
});

const FlashcardsOutput = z.strictObject({
  flashcards: z
    .array(z.strictObject({ front: text, back: text, tags: z.array(text).min(1) }))
    .min(1),
});

/** A flat list, because a recursive schema is hard on the model and easy to draw from this. */
const MindMapOutput = z
  .strictObject({
    title: text,
    nodes: z
      .array(
        z.strictObject({
          id: text,
          label: text,
          parent: z.string().describe('The id of the parent node. Empty for the one root node.'),
          note: z.string().optional(),
        }),
      )
      .min(2),
  })
  .superRefine(({ nodes }, context) => {
    const ids = new Set(nodes.map((node) => node.id));
    if (ids.size !== nodes.length) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: 'Each node needs its own id.' });
    }
    if (nodes.filter((node) => node.parent === '').length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: 'Exactly one node must be the root, with an empty parent.',
      });
    }
    nodes.forEach((node, index) => {
      if (node.parent !== '' && !ids.has(node.parent)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'parent'],
          message: `The parent ${node.parent} is not in the list.`,
        });
      }
    });
  });

const DesignReviewOutput = z.strictObject({
  overall: text,
  strengths: z.array(text),
  risks: z.array(z.strictObject({ issue: text, severity, suggestion: text })),
  nextSteps: z.array(text).min(1),
  questions: z.array(text).describe('Questions the student should be able to answer.'),
});

const TaskBreakdownOutput = z.strictObject({
  summary: text,
  tasks: z
    .array(
      z.strictObject({
        id: text,
        title: text,
        detail: text,
        estimateHours: z.number().min(0),
        dependsOn: z.array(z.string()).describe('The ids of tasks to finish first.'),
        doneWhen: text.describe('How the student will know this task is finished.'),
      }),
    )
    .min(1),
});

const CodeReviewOutput = z.strictObject({
  summary: text,
  issues: z.array(
    z.strictObject({
      file: z.string(),
      line: z.number().int().min(1).optional(),
      severity,
      problem: text,
      suggestion: text,
    }),
  ),
  strengths: z.array(text),
  complexity: text.describe('Time and space complexity in a sentence or two.'),
});

const FixSuggestionsOutput = z.strictObject({
  summary: text,
  hints: z.array(text).describe('Ordered from the gentlest hint to the most direct one.'),
  edits: z
    .array(
      z.strictObject({
        file: z.string().min(1),
        find: z
          .string()
          .describe('Text copied exactly from the file. Empty only to create a new file.'),
        replace: z.string(),
        explanation: text,
      }),
    )
    .describe('Empty when only hints were asked for.'),
});

const CodeCrossCheckOutput = z.strictObject({
  matchesExpected: z.enum(['yes', 'partly', 'no', 'unknown']),
  behaviorSummary: text,
  mismatches: z.array(text),
  testInputs: z.array(
    z.strictObject({
      input: z.string(),
      why: text,
      expected: z.string().describe('What the program should print, if that can be known.'),
    }),
  ),
  styleNotes: z.array(text),
  complexity: text,
  differencesFromReference: z
    .array(text)
    .describe('Differences in approach, in words only. Never quote the reference solution.'),
});

const PredictCheckOutput = z.strictObject({
  verdict: z.enum(['correct', 'partly', 'incorrect']),
  feedback: text,
});

const FormalExplainOutput = z.strictObject({
  headline: text,
  explanation: text,
  mistakes: z.array(z.strictObject({ what: text, why: text, fix: text })),
  nextStep: text,
});

/** The contract of every task. The server checks each model reply against `output`. */
export const AI_TASK_SCHEMAS = {
  'quiz-generate': {
    input: z.strictObject({
      topicId: slug,
      difficulty,
      count: z.number().int().min(1).max(10).default(5),
      kinds: z
        .array(z.enum(['mcq', 'short']))
        .min(1)
        .default(['mcq']),
      /** Prompts already seen, so a new batch does not repeat them. */
      avoid: z.array(z.string().max(AI_LIMITS.excerpt)).max(50).default([]),
    }),
    output: QuizGenerateOutput,
  },
  'wrong-answer-explain': {
    input: z.strictObject({
      question: passage,
      options: z.array(shortText).max(8).optional(),
      correctAnswer: passage,
      studentAnswer: passage,
      explanation: z.string().max(AI_LIMITS.excerpt).optional(),
      topicId: slug.optional(),
    }),
    output: WrongAnswerOutput,
  },
  'short-answer-grade': {
    input: z.strictObject({
      question: passage,
      studentAnswer: z.string().trim().max(AI_LIMITS.excerpt),
      modelAnswer: z.string().max(AI_LIMITS.excerpt).optional(),
      rubric: z
        .array(z.strictObject({ point: shortText, marks: z.number().min(0) }))
        .max(20)
        .optional(),
      maxMarks: z.number().min(0).max(100),
      topicId: slug.optional(),
    }),
    output: ShortAnswerGradeOutput,
  },
  'study-plan': {
    input: z.strictObject({
      examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-05-20.'),
      /** Today's date on the student's computer. */
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      hoursPerDay: z.number().min(0.25).max(24),
      weakTopics: z
        .array(
          z.strictObject({
            topicId: shortText,
            title: shortText.optional(),
            /** The mastery meter, from 0 to 100. */
            mastery: z.number().min(0).max(100).optional(),
          }),
        )
        .max(100),
      goal: z.string().max(AI_LIMITS.label).optional(),
    }),
    output: StudyPlanOutput,
  },
  'important-questions': {
    input: z.strictObject({
      topicIds: z.array(slug).min(1).max(30),
      exam: examStyle,
      count: z.number().int().min(1).max(50).default(10),
    }),
    output: ImportantQuestionsOutput,
  },
  'mock-paper': {
    input: z.strictObject({
      topicIds: z.array(slug).min(1).max(30),
      exam: examStyle,
      durationMinutes: z.number().int().min(5).max(360),
      totalMarks: z.number().int().min(1).max(300),
      mix: z
        .strictObject({
          mcq: z.number().int().min(0).max(100),
          short: z.number().int().min(0).max(100),
          long: z.number().int().min(0).max(100),
        })
        .optional(),
      negativeMarking: z.boolean().default(false),
    }),
    output: MockPaperOutput,
  },
  'viva-turn': {
    input: z.strictObject({
      topicId: slug.optional(),
      topicTitle: shortText.optional(),
      difficulty: difficulty.default('medium'),
      /** The viva so far, oldest first. */
      transcript: z
        .array(
          z.strictObject({
            question: z.string().max(AI_LIMITS.excerpt),
            answer: z.string().max(AI_LIMITS.excerpt),
          }),
        )
        .max(30)
        .default([]),
      /** The question just asked, and the student's spoken or typed answer to it. */
      currentQuestion: z.string().max(AI_LIMITS.excerpt).optional(),
      answer: z.string().max(AI_LIMITS.excerpt).optional(),
    }),
    output: VivaTurnOutput,
  },
  'revision-sheet': {
    input: z.strictObject({
      topicIds: z.array(slug).min(1).max(30),
      minutes: z.number().int().min(1).max(240).optional(),
      exam: examStyle.optional(),
    }),
    output: RevisionSheetOutput,
  },
  'mnemonic-sheet': {
    input: z.strictObject({
      topicIds: z.array(slug).min(1).max(30),
      focus: z.string().max(AI_LIMITS.label).optional(),
    }),
    output: MnemonicSheetOutput,
  },
  'topic-summary': {
    input: z.strictObject({
      topicId: slug,
      length: z.enum(['short', 'medium', 'long']).default('medium'),
    }),
    output: TopicSummaryOutput,
  },
  'notes-to-flashcards': {
    input: z.strictObject({
      notes: z.string().trim().min(1, 'Add some notes first.').max(AI_LIMITS.notes),
      topicId: slug.optional(),
      count: z.number().int().min(1).max(40).default(10),
    }),
    output: FlashcardsOutput,
  },
  'mind-map': {
    input: z.strictObject({ topicId: slug }),
    output: MindMapOutput,
  },
  'project-design-review': {
    input: z.strictObject({
      description: passage,
      stage: z.string().max(AI_LIMITS.label).optional(),
      goals: z.string().max(AI_LIMITS.excerpt).optional(),
      files: z.array(FileSchema).max(AI_LIMITS.files).default([]),
    }),
    output: DesignReviewOutput,
  },
  'task-breakdown': {
    input: z.strictObject({
      goal: passage,
      stage: z.string().max(AI_LIMITS.label).optional(),
      currentState: z.string().max(AI_LIMITS.excerpt).optional(),
      hoursAvailable: z.number().min(0).max(10_000).optional(),
    }),
    output: TaskBreakdownOutput,
  },
  'code-review': {
    input: z.strictObject({
      files: z.array(FileSchema).min(1).max(AI_LIMITS.files),
      goal: z.string().max(AI_LIMITS.excerpt).optional(),
      focus: z.string().max(AI_LIMITS.label).optional(),
    }),
    output: CodeReviewOutput,
  },
  'fix-suggestions': {
    input: z.strictObject({
      /** "hints" never returns code. "full" returns edits the student can accept or reject. */
      mode: z.enum(['hints', 'full']),
      problem: passage,
    }),
    output: FixSuggestionsOutput,
  },
  'code-cross-check': {
    input: z.strictObject({
      /** With an exercise, the server compares against its reference solution privately. */
      exerciseId: slug.optional(),
      expectedBehavior: z.string().max(AI_LIMITS.excerpt).optional(),
    }),
    output: CodeCrossCheckOutput,
  },
  'predict-check': {
    input: z.strictObject({
      guess: z.string().trim().min(1, 'Type your prediction first.').max(AI_LIMITS.excerpt),
      current: z.strictObject({ title: shortText, explanation: z.string().max(AI_LIMITS.excerpt) }),
      /** The real next step, from the engine. The AI only compares the guess with it. */
      actual: z.strictObject({ title: shortText, explanation: z.string().max(AI_LIMITS.excerpt) }),
    }),
    output: PredictCheckOutput,
  },
  'formal-check-explain': {
    input: z.strictObject({
      kind: z.enum(['grammar', 'dfa', 'nfa', 'regex']),
      submission: z.string().trim().min(1).max(AI_LIMITS.excerpt),
      /** What the submission was meant to do. */
      goal: z.string().max(AI_LIMITS.excerpt).optional(),
      /** The engine's verdict, which is the source of truth. The AI only puts it into words. */
      engine: z.strictObject({
        correct: z.boolean(),
        summary: z.string().trim().min(1).max(AI_LIMITS.excerpt),
        findings: z.array(z.string().max(AI_LIMITS.excerpt)).max(30).default([]),
        counterexample: z.string().max(AI_LIMITS.excerpt).optional(),
      }),
    }),
    output: FormalExplainOutput,
  },
} as const satisfies Record<AiTaskName, { input: z.ZodType; output: z.ZodType }>;

/** What a caller passes, where anything with a default may be left out. */
export type AiTaskInput<N extends AiTaskName> = z.input<(typeof AI_TASK_SCHEMAS)[N]['input']>;
/** What a task's prompt receives, after validation has filled in the defaults. */
export type AiTaskParsedInput<N extends AiTaskName> = z.output<
  (typeof AI_TASK_SCHEMAS)[N]['input']
>;
export type AiTaskOutput<N extends AiTaskName> = z.output<(typeof AI_TASK_SCHEMAS)[N]['output']>;
