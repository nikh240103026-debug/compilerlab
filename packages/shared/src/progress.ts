// Zod-free so the web app's initial bundle can use it.

export interface TopicProgress {
  topicId: string;
  read: boolean;
  visualizerUsed: boolean;
  /** The best quiz score so far, from 0 to 100. */
  bestQuizScore: number | null;
  updatedAt: string;
}

export const QUIZ_PASS_SCORE = 70;

/**
 * Part 11's rule: a topic is complete once it is read, explored, and the quiz is passed.
 * A topic with no visualizer has nothing to explore, so that part does not apply to it.
 */
export function isTopicComplete(
  progress: TopicProgress | undefined,
  hasVisualizer = true,
): boolean {
  if (!progress) return false;
  return (
    progress.read &&
    (progress.visualizerUsed || !hasVisualizer) &&
    (progress.bestQuizScore ?? 0) >= QUIZ_PASS_SCORE
  );
}

/** A score from 0 to 100 for the mastery meter. The quiz counts most, because it tests recall. */
export function topicMastery(progress: TopicProgress | undefined, hasVisualizer = true): number {
  if (!progress) return 0;
  const quiz = (progress.bestQuizScore ?? 0) * 0.6;
  if (!hasVisualizer) return Math.round((progress.read ? 40 : 0) + quiz);
  return Math.round((progress.read ? 20 : 0) + (progress.visualizerUsed ? 20 : 0) + quiz);
}
