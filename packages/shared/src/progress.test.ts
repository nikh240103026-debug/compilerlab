import { describe, expect, it } from 'vitest';
import { TopicProgressPatchSchema } from './content';
import { isTopicComplete, topicMastery, type TopicProgress } from './progress';

const progress = (fields: Partial<TopicProgress>): TopicProgress => ({
  topicId: 't',
  read: false,
  visualizerUsed: false,
  bestQuizScore: null,
  updatedAt: '',
  ...fields,
});

describe('isTopicComplete', () => {
  it('needs reading, a visualizer and a quiz score of at least 70', () => {
    const full = { read: true, visualizerUsed: true };
    expect(isTopicComplete(progress({ ...full, bestQuizScore: 70 }))).toBe(true);
    expect(isTopicComplete(progress({ ...full, bestQuizScore: 69 }))).toBe(false);
    expect(isTopicComplete(progress({ ...full, bestQuizScore: null }))).toBe(false);
    expect(isTopicComplete(progress({ read: true, bestQuizScore: 100 }))).toBe(false);
    expect(isTopicComplete(progress({ visualizerUsed: true, bestQuizScore: 100 }))).toBe(false);
    expect(isTopicComplete(undefined)).toBe(false);
  });
});

describe('a topic with no visualizer', () => {
  const done = progress({ read: true, bestQuizScore: 100 });

  it('can still be completed', () => {
    expect(isTopicComplete(done, false)).toBe(true);
    expect(isTopicComplete(done, true)).toBe(false);
    expect(isTopicComplete(progress({ read: true }), false)).toBe(false);
  });

  it('can still reach full mastery', () => {
    expect(topicMastery(done, false)).toBe(100);
    expect(topicMastery(progress({ read: true }), false)).toBe(40);
  });
});

describe('topicMastery', () => {
  it('runs from 0 to 100', () => {
    expect(topicMastery(undefined)).toBe(0);
    expect(topicMastery(progress({}))).toBe(0);
    expect(topicMastery(progress({ read: true, visualizerUsed: true, bestQuizScore: 100 }))).toBe(
      100,
    );
  });

  it('weights the quiz most', () => {
    expect(topicMastery(progress({ read: true }))).toBe(20);
    expect(topicMastery(progress({ bestQuizScore: 50 }))).toBe(30);
  });
});

describe('TopicProgressPatchSchema', () => {
  it('accepts the ways progress can change', () => {
    expect(TopicProgressPatchSchema.parse({ read: true })).toEqual({ read: true });
    expect(TopicProgressPatchSchema.parse({ quizScore: 80 })).toEqual({ quizScore: 80 });
  });

  it.each([[{ read: false }], [{ quizScore: 101 }], [{ quizScore: 1.5 }], [{ other: 1 }]])(
    'rejects %j, because progress only moves forward through this API',
    (patch) => {
      expect(TopicProgressPatchSchema.safeParse(patch).success).toBe(false);
    },
  );
});
