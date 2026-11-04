// Zod-free so the browser can use these without the validator in its bundle. The matching Zod
// schemas, and the input and output of every task, are in ai-schemas.ts.

export const AI_LEVELS = ['beginner', 'intermediate', 'exam'] as const;
export type AiLevel = (typeof AI_LEVELS)[number];

export const AI_LEVEL_LABELS: Readonly<Record<AiLevel, string>> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  exam: 'Exam-focused',
};

/**
 * Every structured task the server can run. Call one with `api.aiTask(name, input)` in the
 * browser, or `POST /api/ai/structured`. See docs/ARCHITECTURE.md.
 */
export const AI_TASK_NAMES = [
  'quiz-generate',
  'wrong-answer-explain',
  'short-answer-grade',
  'study-plan',
  'important-questions',
  'mock-paper',
  'viva-turn',
  'revision-sheet',
  'mnemonic-sheet',
  'topic-summary',
  'notes-to-flashcards',
  'mind-map',
  'project-design-review',
  'task-breakdown',
  'code-review',
  'fix-suggestions',
  'code-cross-check',
  'predict-check',
  'formal-check-explain',
] as const;
export type AiTaskName = (typeof AI_TASK_NAMES)[number];

/** Sizes the browser trims to before sending, and the server checks. */
export const AI_LIMITS = {
  question: 4000,
  historyTurns: 8,
  historyTurnChars: 4000,
  excerpt: 4000,
  label: 300,
  files: 8,
  fileChars: 16_000,
  logChars: 6000,
  stateChars: 3000,
  diagnostics: 20,
  tests: 40,
  testChars: 600,
  engineResults: 8,
  engineResultChars: 6000,
  notes: 20_000,
} as const;

export interface AiChatTurn {
  role: 'user' | 'model';
  text: string;
}

/** What the student is looking at. The browser attaches this to every AI call automatically. */
export interface AiContext {
  /** The app's path, such as /learn/lexical-analysis/regex-to-dfa. */
  page?: string | undefined;
  topic?:
    | {
        id: string;
        title?: string | undefined;
        /** The text the student selected, or the part of the lesson being asked about. */
        excerpt?: string | undefined;
      }
    | undefined;
  visualizer?:
    | {
        id: string;
        title?: string | undefined;
        /** What the student typed: the regex, grammar or code. */
        input?: string | undefined;
        /** Counts from 1. */
        step?: number | undefined;
        stepCount?: number | undefined;
        stepTitle?: string | undefined;
        stepExplanation?: string | undefined;
        /** The engine's snapshot for this step, as JSON. */
        state?: string | undefined;
      }
    | undefined;
  lab?:
    | {
        exerciseId?: string | undefined;
        exerciseTitle?: string | undefined;
        exerciseBrief?: string | undefined;
        pipeline?: string | undefined;
        /** "real" or "simulated". */
        engine?: string | undefined;
        activeFile?: string | undefined;
        files?: { name: string; content: string }[] | undefined;
        stdin?: string | undefined;
        buildLog?: string | undefined;
        output?: string | undefined;
        diagnostics?: string[] | undefined;
        /** Hidden tests appear here by name only, because the server never sends their details. */
        tests?:
          | {
              name: string;
              passed: boolean;
              hidden: boolean;
              input?: string | undefined;
              expected?: string | undefined;
              actual?: string | undefined;
            }[]
          | undefined;
      }
    | undefined;
  quiz?:
    | {
        question: string;
        options?: string[] | undefined;
        studentAnswer?: string | undefined;
        correctAnswer?: string | undefined;
      }
    | undefined;
  /**
   * Answers the engine computed, such as FIRST and FOLLOW sets or a parsing table. The model is
   * told these are correct and must use them rather than work them out again.
   */
  engine?: { label: string; result: string }[] | undefined;
}

export interface AiChatRequest {
  question: string;
  /** The recent conversation, oldest first, without the current question. */
  history?: AiChatTurn[] | undefined;
  context?: AiContext | undefined;
  level?: AiLevel | undefined;
  /** Hints and guiding questions first, and the full answer only when the student asks. */
  socratic?: boolean | undefined;
  /** Skips the saved copy of an identical earlier answer. */
  fresh?: boolean | undefined;
}

export type AiErrorCode =
  | 'no_key'
  | 'invalid_key'
  | 'offline'
  | 'rate_limited'
  | 'daily_limit'
  | 'model_not_found'
  | 'blocked'
  | 'invalid_output'
  | 'timeout'
  | 'upstream'
  | 'bad_request'
  | 'busy';

/** A hint for the student. The per-minute count is enforced here, the daily one is only counted. */
export interface AiQuota {
  perMinuteLimit: number;
  usedThisMinute: number;
  remainingThisMinute: number;
  /** Seconds until the oldest request leaves the one-minute window. */
  resetsInSeconds: number;
  usedToday: number;
  perDayLimit: number;
  remainingToday: number;
}

export type AiState = 'ready' | 'no_key' | 'offline' | 'rate_limited';

export interface AiStatus {
  state: AiState;
  /** Whether a key exists. The key itself never leaves the server. */
  configured: boolean;
  /** A sentence for the student. Empty when everything is ready. */
  message: string;
  model: string;
  retryAfterSeconds: number | null;
  quota: AiQuota;
}

/** A piece of the course an answer was grounded on. */
export interface AiSource {
  topicId: string;
  /** The course module, which is the other half of the lesson's address. */
  module: string;
  topicTitle: string;
  heading: string;
}

export interface AiAnswerMeta {
  model: string;
  /** True when this came from the local copy of an identical earlier request. */
  cached: boolean;
  /** True when the model stopped at its length limit. */
  truncated: boolean;
  sources: AiSource[];
  quota: AiQuota;
}

/** One server-sent event from `POST /api/ai/chat`. */
export type AiStreamEvent =
  | { type: 'status'; message: string; waitSeconds: number }
  | { type: 'delta'; text: string }
  | ({ type: 'done' } & AiAnswerMeta)
  | { type: 'error'; code: AiErrorCode; message: string; retryAfterSeconds: number | null };

export interface AiTaskRequest<Input = unknown> {
  task: AiTaskName;
  input: Input;
  context?: AiContext | undefined;
  level?: AiLevel | undefined;
  fresh?: boolean | undefined;
}

/** The reply from `POST /api/ai/structured`. Everything in `data` was checked against a schema. */
export interface AiTaskResponse<Output = unknown> extends AiAnswerMeta {
  task: AiTaskName;
  data: Output;
  /** Part 8 asks for AI output to stay labeled until a person has reviewed it. */
  aiGenerated: true;
  label: 'AI-generated';
}

export interface AiFeedbackRequest {
  /** Where the answer appeared: "chat", or a task name. */
  source: string;
  question: string;
  answer: string;
  note?: string | undefined;
  topicId?: string | undefined;
  model?: string | undefined;
}

export interface AiFeedbackResponse {
  id: number;
}

/** These mean AI is unavailable right now, so the page shows a calm notice and not an error. */
export function isAiUnavailable(code: string): boolean {
  return ['no_key', 'offline', 'rate_limited', 'daily_limit', 'invalid_key', 'busy'].includes(code);
}

const CUT_MARK = '\n[... the middle was cut to keep this short ...]\n';

/** Keeps the start and the end, which is where code's includes and a log's last error usually are. */
export function clipAiText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= CUT_MARK.length) return text.slice(0, max);
  const room = max - CUT_MARK.length;
  const head = Math.ceil((room * 2) / 3);
  return `${text.slice(0, head)}${CUT_MARK}${text.slice(text.length - (room - head))}`;
}

/** True when `clipAiText` removed part of this text, so an exact search in it cannot be trusted. */
export function wasAiTextClipped(text: string): boolean {
  return text.includes(CUT_MARK);
}

function clipOptional(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : clipAiText(text, max);
}

/** Makes a context fit the limits, so a very large file is shortened and never refused. */
export function trimAiContext(context: AiContext): AiContext {
  const { page, topic, visualizer, lab, quiz, engine } = context;
  const label = AI_LIMITS.label;
  return {
    ...(page ? { page: page.slice(0, label) } : {}),
    ...(topic
      ? {
          topic: {
            id: topic.id.slice(0, label),
            title: clipOptional(topic.title, label),
            excerpt: clipOptional(topic.excerpt, AI_LIMITS.excerpt),
          },
        }
      : {}),
    ...(visualizer
      ? {
          visualizer: {
            ...visualizer,
            id: visualizer.id.slice(0, label),
            title: clipOptional(visualizer.title, label),
            input: clipOptional(visualizer.input, AI_LIMITS.excerpt),
            stepTitle: clipOptional(visualizer.stepTitle, label),
            stepExplanation: clipOptional(visualizer.stepExplanation, AI_LIMITS.excerpt),
            state: clipOptional(visualizer.state, AI_LIMITS.stateChars),
          },
        }
      : {}),
    ...(lab
      ? {
          lab: {
            ...lab,
            exerciseId: clipOptional(lab.exerciseId, label),
            exerciseTitle: clipOptional(lab.exerciseTitle, label),
            exerciseBrief: clipOptional(lab.exerciseBrief, AI_LIMITS.excerpt),
            pipeline: clipOptional(lab.pipeline, label),
            engine: clipOptional(lab.engine, label),
            activeFile: clipOptional(lab.activeFile, label),
            files: lab.files?.slice(0, AI_LIMITS.files).map((file) => ({
              name: file.name.slice(0, label),
              content: clipAiText(file.content, AI_LIMITS.fileChars),
            })),
            stdin: clipOptional(lab.stdin, AI_LIMITS.logChars),
            buildLog: clipOptional(lab.buildLog, AI_LIMITS.logChars),
            output: clipOptional(lab.output, AI_LIMITS.logChars),
            diagnostics: lab.diagnostics
              ?.slice(0, AI_LIMITS.diagnostics)
              .map((item) => clipAiText(item, AI_LIMITS.excerpt)),
            tests: lab.tests?.slice(0, AI_LIMITS.tests).map((test) => ({
              ...test,
              name: test.name.slice(0, label),
              input: clipOptional(test.input, AI_LIMITS.testChars),
              expected: clipOptional(test.expected, AI_LIMITS.testChars),
              actual: clipOptional(test.actual, AI_LIMITS.testChars),
            })),
          },
        }
      : {}),
    ...(quiz
      ? {
          quiz: {
            question: clipAiText(quiz.question, AI_LIMITS.excerpt),
            options: quiz.options?.slice(0, 8).map((option) => clipAiText(option, label)),
            studentAnswer: clipOptional(quiz.studentAnswer, AI_LIMITS.excerpt),
            correctAnswer: clipOptional(quiz.correctAnswer, AI_LIMITS.excerpt),
          },
        }
      : {}),
    ...(engine
      ? {
          engine: engine.slice(0, AI_LIMITS.engineResults).map((item) => ({
            label: item.label.slice(0, label),
            result: clipAiText(item.result, AI_LIMITS.engineResultChars),
          })),
        }
      : {}),
  };
}

/** Keeps the latest turns, each cut to size. */
export function trimAiHistory(history: readonly AiChatTurn[]): AiChatTurn[] {
  return history.slice(-AI_LIMITS.historyTurns).map((turn) => ({
    role: turn.role,
    text: clipAiText(turn.text, AI_LIMITS.historyTurnChars),
  }));
}
