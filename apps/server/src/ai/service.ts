import { loadLabExercises } from '@compilerlab/content';
import {
  AI_TASK_SCHEMAS,
  type AiAnswerMeta,
  type AiChatRequest,
  type AiContext,
  type AiFeedbackRequest,
  type AiQuota,
  type AiSource,
  type AiStatus,
  type AiStreamEvent,
  type AiTaskName,
  type AiTaskRequest,
  type AiTaskResponse,
  type LabExercise,
} from '@compilerlab/shared';
import type { z } from 'zod';
import type { AppConfig } from '../config';
import type { SqlDatabase } from '../db/driver';
import { readSettings } from '../settings-repo';
import type { AiClient, AiMessage } from './client';
import { AiCancelled, AiFailure, aiMessage, toAiFailure } from './errors';
import { describeIssues, parseJsonReply, schemaAsText, toGeminiSchema } from './json-reply';
import { LessonSearch, type LessonChunk } from './lesson-search';
import { chatMessages, searchTextFor, systemInstruction, taskMessages } from './prompts';
import { AiQueue, type QueueHooks } from './queue';
import {
  aiRequestsToday,
  cacheKeyOf,
  countAiRequest,
  readCache,
  saveFeedback,
  writeCache,
} from './store';
import { AI_TASKS, type AiTaskDefinition, type TaskTools } from './tasks';

const CHAT_TEMPERATURE = 0.4;
const CHAT_MAX_TOKENS = 4096;
const TASK_MAX_TOKENS = 4096;
const TOKEN_CEILING = 32_768;
/** Tries at getting a valid reply. Each one also has the queue's retries for 429 and 5xx. */
const TASK_ATTEMPTS = 3;
/** How long a failed connection keeps the status at "offline" without a new attempt. */
const OFFLINE_MEMORY_MS = 60_000;

export interface AiServiceDeps {
  config: AppConfig;
  db: SqlDatabase;
  client: AiClient;
  /** Logs only an error's code and status, because its text could quote a prompt. */
  onFailure?: (failure: AiFailure) => void;
}

function sourcesOf(chunks: readonly LessonChunk[]): AiSource[] {
  const seen = new Set<string>();
  const sources: AiSource[] = [];
  for (const { topicId, module, topicTitle, heading } of chunks) {
    const key = `${topicId}\n${heading}`;
    if (!seen.has(key)) {
      seen.add(key);
      sources.push({ topicId, module, topicTitle, heading });
    }
  }
  return sources;
}

function waitNote(seconds: number, reason: 'limit' | 'retry'): string {
  return reason === 'limit'
    ? `Waiting about ${seconds} s for a free slot, to stay inside the free-tier limit.`
    : `Gemini is busy, so trying again in about ${seconds} s.`;
}

export class AiService {
  private readonly queue: AiQueue;
  private readonly search: LessonSearch;
  private readonly tools: TaskTools;
  private lastProblem: { code: 'offline' | 'daily_limit'; at: number } | null = null;

  constructor(private readonly deps: AiServiceDeps) {
    this.queue = new AiQueue(deps.config.geminiRequestsPerMinute);
    this.search = new LessonSearch(deps.config.contentDir);
    this.tools = {
      lessonText: (topicId, maxChars) => {
        const text = this.search.lessonText(topicId);
        return text === null || maxChars === undefined ? text : text.slice(0, maxChars);
      },
      exercise: (id) => this.exercises().find((exercise) => exercise.id === id) ?? null,
    };
  }

  close(): void {
    this.queue.close();
  }

  /** Settings first, then GEMINI_MODEL. */
  private model(): string {
    return readSettings(this.deps.db).geminiModel || this.deps.config.geminiModel;
  }

  private exercises(): LabExercise[] {
    return loadLabExercises(this.deps.config.contentDir).exercises;
  }

  private quota(): AiQuota {
    const { geminiRequestsPerMinute: perMinuteLimit, geminiRequestsPerDay: perDayLimit } =
      this.deps.config;
    const { usedThisMinute, resetsInSeconds } = this.queue.usage();
    const usedToday = aiRequestsToday(this.deps.db);
    return {
      perMinuteLimit,
      usedThisMinute,
      remainingThisMinute: Math.max(0, perMinuteLimit - usedThisMinute),
      resetsInSeconds,
      usedToday,
      perDayLimit,
      remainingToday: Math.max(0, perDayLimit - usedToday),
    };
  }

  status(): AiStatus {
    const base = {
      configured: this.deps.client.available,
      model: this.model(),
      quota: this.quota(),
    };
    if (!base.configured) {
      return {
        ...base,
        state: 'no_key',
        message: aiMessage('no_key'),
        retryAfterSeconds: null,
      };
    }
    const problem = this.lastProblem;
    if (problem?.code === 'daily_limit' && isSameDay(problem.at, Date.now())) {
      return {
        ...base,
        state: 'rate_limited',
        message: aiMessage('daily_limit'),
        retryAfterSeconds: null,
      };
    }
    const { waitSeconds } = this.queue.usage();
    if (waitSeconds > 0) {
      return {
        ...base,
        state: 'rate_limited',
        message: `The tutor is close to its free-tier limit, so new questions wait about ${waitSeconds} s.`,
        retryAfterSeconds: waitSeconds,
      };
    }
    if (problem?.code === 'offline' && Date.now() - problem.at < OFFLINE_MEMORY_MS) {
      return { ...base, state: 'offline', message: aiMessage('offline'), retryAfterSeconds: null };
    }
    return { ...base, state: 'ready', message: '', retryAfterSeconds: null };
  }

  /** Streams an answer. Never throws: every failure becomes an `error` event. */
  async chat(
    request: AiChatRequest,
    send: (event: AiStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { client, db } = this.deps;
    const model = this.model();
    const chunks = this.search.find(searchTextFor(request.question, request.context), {
      topicId: request.context?.topic?.id,
    });
    const sources = sourcesOf(chunks);
    const prompt = {
      system: systemInstruction({ level: request.level, socratic: request.socratic }),
      messages: chatMessages(request, chunks),
    };
    const key = cacheKeyOf({ kind: 'chat', model, ...prompt });
    const meta = (cached: boolean, truncated: boolean): AiAnswerMeta => ({
      model,
      cached,
      truncated,
      sources,
      quota: this.quota(),
    });

    if (!request.fresh) {
      const saved = readCache<{ text: string }>(db, key);
      if (saved) {
        send({ type: 'delta', text: saved.text });
        send({ type: 'done', ...meta(true, false) });
        return;
      }
    }

    let text = '';
    let truncated = false;
    try {
      if (!client.available) throw new AiFailure('no_key');
      await this.queue.run(
        async () => {
          countAiRequest(db);
          const pieces = client.stream({
            model,
            ...prompt,
            temperature: CHAT_TEMPERATURE,
            maxOutputTokens: CHAT_MAX_TOKENS,
            signal,
          });
          for await (const piece of pieces) {
            if (signal.aborted) throw new AiCancelled();
            if (piece.text) {
              text += piece.text;
              send({ type: 'delta', text: piece.text });
            }
            if (piece.finishReason === 'MAX_TOKENS') truncated = true;
          }
          // A model that says nothing has not answered, so this counts as a failure to retry.
          if (!text.trim()) throw new AiFailure('upstream', { retryable: true });
        },
        {
          signal,
          canRetry: () => text === '',
          onWait: (waitSeconds, reason) =>
            send({ type: 'status', message: waitNote(waitSeconds, reason), waitSeconds }),
        },
      );
    } catch (error) {
      if (error instanceof AiCancelled || signal.aborted) return;
      const failure = this.noteFailure(error);
      send({
        type: 'error',
        code: failure.code,
        message: failure.friendlyMessage,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
      return;
    }
    this.lastProblem = null;
    // A cut-off answer is worth showing, but not worth repeating to the next person who asks.
    if (!truncated) writeCache(db, { key, kind: 'chat', model, response: { text } });
    send({ type: 'done', ...meta(false, truncated) });
  }

  /**
   * Runs a named task and returns JSON that has passed its schema. The input's problems throw a
   * ZodError, which the error handler shows as a 400. Everything else throws an `AiFailure`.
   */
  async runTask(request: AiTaskRequest, signal: AbortSignal): Promise<AiTaskResponse> {
    const { client, db } = this.deps;
    const { task: name, context } = request;
    const schemas = AI_TASK_SCHEMAS[name];
    const input: unknown = schemas.input.parse(request.input);
    // The registry pairs each task with its own types. They cannot be followed through a variable.
    const task = AI_TASKS[name] as unknown as AiTaskDefinition<unknown, unknown>;
    const output = schemas.output as z.ZodType;

    const model = this.model();
    const chunks = this.search.find(task.search?.(input) ?? searchTextFor('', context), {
      topicId: context?.topic?.id,
    });
    const sources = sourcesOf(chunks);
    const prompt = {
      system: systemInstruction({ level: request.level, json: true }),
      messages: taskMessages(task.prompt(input, this.tools), context, chunks),
    };
    const key = cacheKeyOf({ kind: name, model, ...prompt });
    const respond = (data: unknown, cached: boolean): AiTaskResponse => ({
      task: name,
      data,
      aiGenerated: true,
      label: 'AI-generated',
      model,
      cached,
      truncated: false,
      sources,
      quota: this.quota(),
    });

    if (task.cacheable && !request.fresh) {
      const saved = readCache<{ data: unknown }>(db, key);
      if (saved) return respond(saved.data, true);
    }

    const hooks: QueueHooks = { signal };
    try {
      if (!client.available) throw new AiFailure('no_key');
      const data = await this.generateValid(name, task, output, input, context, {
        model,
        system: prompt.system,
        messages: prompt.messages,
        hooks,
      });
      this.lastProblem = null;
      if (task.cacheable) writeCache(db, { key, kind: name, model, response: { data } });
      return respond(data, false);
    } catch (error) {
      if (error instanceof AiCancelled || signal.aborted) throw new AiCancelled();
      throw this.noteFailure(error);
    }
  }

  recordFeedback(feedback: AiFeedbackRequest): number {
    return saveFeedback(this.deps.db, feedback);
  }

  /** Asks until a reply parses and passes its checks, telling the model what was wrong each time. */
  private async generateValid(
    name: AiTaskName,
    task: AiTaskDefinition<unknown, unknown>,
    output: z.ZodType,
    input: unknown,
    context: AiContext | undefined,
    request: { model: string; system: string; messages: AiMessage[]; hooks: QueueHooks },
  ): Promise<unknown> {
    const { client, db } = this.deps;
    const { model, hooks } = request;
    const messages = [...request.messages];
    let system = request.system;
    let jsonSchema: unknown = toGeminiSchema(output);
    let maxOutputTokens = task.maxOutputTokens ?? TASK_MAX_TOKENS;

    for (let attempt = 1; attempt <= TASK_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await this.queue.run(() => {
          countAiRequest(db);
          return client.generate({
            model,
            system,
            messages,
            temperature: task.temperature,
            maxOutputTokens,
            jsonSchema,
            signal: hooks.signal,
          });
        }, hooks);
      } catch (error) {
        const failure = toAiFailure(error);
        // Some models refuse a schema parameter. The same schema still works when written out.
        if (failure.code === 'bad_request' && jsonSchema !== undefined) {
          jsonSchema = undefined;
          system = `${system}\n\nThe JSON schema to match:\n${schemaAsText(output)}`;
          continue;
        }
        throw failure;
      }

      const parsed = parseJsonReply(result.text);
      let problem: string;
      if (parsed.ok) {
        const valid = output.safeParse(parsed.value);
        if (valid.success) {
          const custom = task.check?.(valid.data, input, context, this.tools) ?? null;
          if (custom === null) return task.finish ? task.finish(valid.data, input) : valid.data;
          problem = custom;
        } else {
          problem = describeIssues(valid.error);
        }
      } else {
        problem = 'The reply was not complete, valid JSON.';
      }
      // A reply cut off at the length limit needs room, not a correction.
      if (result.finishReason === 'MAX_TOKENS') {
        maxOutputTokens = Math.min(maxOutputTokens * 2, TOKEN_CEILING);
        continue;
      }
      messages.push(
        { role: 'model', text: result.text },
        {
          role: 'user',
          text: `That reply cannot be used. ${problem} Reply again with the full corrected JSON for the task "${name}", and nothing else.`,
        },
      );
    }
    throw new AiFailure('invalid_output');
  }

  private noteFailure(error: unknown): AiFailure {
    const failure = toAiFailure(error);
    if (failure.code === 'offline' || failure.code === 'daily_limit') {
      this.lastProblem = { code: failure.code, at: Date.now() };
    }
    this.deps.onFailure?.(failure);
    return failure;
  }
}

function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
