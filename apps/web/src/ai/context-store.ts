import type { AiContext } from '@compilerlab/shared';
import { trimAiContext } from '@compilerlab/shared/ai';
import { useEffect, useRef } from 'react';

type Section = keyof AiContext;

// Each page registers a function, not a value, so typing in the editor costs nothing. The current
// state is only read at the moment a question is sent.
const providers = new Map<Section, () => unknown>();

/** Everything the open page knows, ready to send. Every AI call in the app starts from this. */
export function currentAiContext(extra?: AiContext): AiContext {
  const context: Record<string, unknown> = { page: window.location.pathname };
  for (const [section, read] of providers) {
    const value = read();
    if (value !== undefined && value !== null) context[section] = value;
  }
  return trimAiContext({ ...(context as AiContext), ...extra });
}

/** Adds what this component knows to every AI call while it is on the page. */
export function useAiContextSection<S extends Section>(section: S, read: () => AiContext[S]): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    const provider = () => latest.current();
    providers.set(section, provider);
    return () => {
      if (providers.get(section) === provider) providers.delete(section);
    };
  }, [section]);
}

let visualizerInput: string | undefined;

/**
 * A visualizer calls this with what the student typed: the regex, grammar or code. The Player then
 * includes it, so each visualizer only has to add this one line.
 */
export function useAiVisualizerInput(input: string): void {
  useEffect(() => {
    visualizerInput = input;
    return () => {
      if (visualizerInput === input) visualizerInput = undefined;
    };
  }, [input]);
}

export function currentVisualizerInput(): string | undefined {
  return visualizerInput;
}

/** A short list of what is being sent, so the student can see it. */
export function describeAiContext(context: AiContext): string[] {
  const parts: string[] = [];
  if (context.topic) parts.push(`Lesson: ${context.topic.title ?? context.topic.id}`);
  if (context.topic?.excerpt) parts.push('The text you selected');
  if (context.visualizer) {
    const { title, id, step, stepCount } = context.visualizer;
    parts.push(
      `${title ?? id}${step !== undefined ? `, step ${step}${stepCount ? ` of ${stepCount}` : ''}` : ''}`,
    );
  }
  if (context.lab) {
    const fileCount = context.lab.files?.length ?? 0;
    parts.push(
      `Lab: ${fileCount} file${fileCount === 1 ? '' : 's'}${context.lab.buildLog ? ' and the last build' : ''}`,
    );
  }
  if (context.quiz) parts.push('The quiz question');
  if (context.engine?.length) parts.push("The engine's results");
  return parts;
}
