import {
  isWeakTopic,
  type AssessmentSummary,
  type AssessmentTopicScore,
} from '@compilerlab/shared';
import type { SqlDatabase } from '../db/driver';
import { listAttempts } from './attempts-repo';
import type { CourseTopic } from './catalog';
import { flashcardCounts } from './flashcards-repo';

/** Old answers should not hold a topic down forever, so a score uses this many recent ones. */
const ANSWERS_PER_TOPIC = 30;
const RECENT_ATTEMPTS = 10;

interface GradedAnswerRow {
  topic_id: string;
  marks: number;
  score: number;
  updated_at: number;
}

export function readSummary(db: SqlDatabase, topics: readonly CourseTopic[]): AssessmentSummary {
  // Pending answers have no score yet, so they are not here.
  const rows = db
    .prepare(
      `SELECT answers.topic_id, answers.marks, answers.score, answers.updated_at
       FROM assessment_answers AS answers
       JOIN assessment_attempts AS attempts ON attempts.id = answers.attempt_id
       WHERE attempts.status = 'finished' AND answers.score IS NOT NULL
       ORDER BY answers.updated_at DESC`,
    )
    .all() as GradedAnswerRow[];

  const totals = new Map<
    string,
    { questions: number; earned: number; possible: number; lastAnsweredAt: number }
  >();
  for (const row of rows) {
    const topic = totals.get(row.topic_id) ?? {
      questions: 0,
      earned: 0,
      possible: 0,
      lastAnsweredAt: row.updated_at,
    };
    if (topic.questions < ANSWERS_PER_TOPIC) {
      topic.questions += 1;
      topic.earned += row.marks * row.score;
      topic.possible += row.marks;
    }
    totals.set(row.topic_id, topic);
  }

  const lessonOf = new Map(topics.map(({ lesson }) => [lesson.id, lesson]));
  const scores: AssessmentTopicScore[] = [...totals.entries()]
    .map(([topicId, topic]) => {
      const percent = topic.possible > 0 ? Math.round((topic.earned / topic.possible) * 100) : 0;
      const lesson = lessonOf.get(topicId);
      return {
        topicId,
        moduleId: lesson?.module ?? null,
        title: lesson?.title ?? topicId,
        questions: topic.questions,
        percent,
        lastAnsweredAt: topic.lastAnsweredAt,
        weak: isWeakTopic(percent, topic.questions),
      };
    })
    .sort((a, b) => a.percent - b.percent);

  const { finished, average } = db
    .prepare(
      `SELECT COUNT(*) AS finished, AVG(json_extract(result, '$.percent')) AS average
       FROM assessment_attempts WHERE status = 'finished'`,
    )
    .get() as { finished: number; average: number | null };
  const { total, due, fresh } = flashcardCounts(db, topics);

  return {
    topics: scores,
    weakTopics: scores.filter((score) => score.weak),
    recentAttempts: listAttempts(db, RECENT_ATTEMPTS),
    totals: {
      attemptsFinished: finished,
      questionsAnswered: rows.length,
      averagePercent: average === null ? null : Math.round(average),
    },
    flashcards: { total, due, fresh },
  };
}
