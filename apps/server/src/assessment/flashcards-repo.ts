import {
  SM2_NEW_CARD,
  addDaysToDate,
  localDateString,
  sm2Next,
  type FlashcardCounts,
  type FlashcardReviewResult,
  type FlashcardSession,
  type FlashcardTopicCount,
  type FlashcardView,
  type Sm2State,
} from '@compilerlab/shared';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from '../db/driver';
import type { CourseTopic } from './catalog';

/** A session is capped so a large backlog stays doable, and new cards wait behind due ones. */
const SESSION_CARDS = 40;
const SESSION_NEW_CARDS = 20;

interface ReviewRow {
  card_key: string;
  ease: number;
  interval_days: number;
  repetitions: number;
  due_on: string;
}

/** A card has no id of its own, so its key comes from its topic and its question. */
export function flashcardKey(topicId: string, front: string): string {
  const hash = createHash('sha256').update(front).digest('hex').slice(0, 16);
  return `${topicId}:${hash}`;
}

function readReviews(db: SqlDatabase): Map<string, ReviewRow> {
  const rows = db
    .prepare('SELECT card_key, ease, interval_days, repetitions, due_on FROM flashcard_reviews')
    .all() as ReviewRow[];
  return new Map(rows.map((row) => [row.card_key, row]));
}

const stateOf = (row: ReviewRow): Sm2State => ({
  ease: row.ease,
  intervalDays: row.interval_days,
  repetitions: row.repetitions,
});

function allCards(topics: readonly CourseTopic[], reviews: ReadonlyMap<string, ReviewRow>) {
  return topics.flatMap(({ lesson, bank }) =>
    bank.flashcards.map((card): FlashcardView => {
      const key = flashcardKey(lesson.id, card.front);
      const review = reviews.get(key);
      return {
        key,
        topicId: lesson.id,
        moduleId: lesson.module,
        topicTitle: lesson.title,
        front: card.front,
        back: card.back,
        tags: card.tags,
        state: review ? stateOf(review) : null,
        dueOn: review?.due_on ?? null,
      };
    }),
  );
}

export function flashcardCounts(db: SqlDatabase, topics: readonly CourseTopic[]): FlashcardCounts {
  const today = localDateString();
  const byTopic = new Map<string, FlashcardTopicCount>();
  const counts: FlashcardCounts = { today, total: 0, due: 0, fresh: 0, topics: [] };
  for (const card of allCards(topics, readReviews(db))) {
    let topic = byTopic.get(card.topicId);
    if (!topic) {
      topic = {
        topicId: card.topicId,
        moduleId: card.moduleId,
        title: card.topicTitle,
        total: 0,
        due: 0,
        fresh: 0,
      };
      byTopic.set(card.topicId, topic);
    }
    topic.total += 1;
    counts.total += 1;
    if (card.dueOn === null) {
      topic.fresh += 1;
      counts.fresh += 1;
    } else if (card.dueOn <= today) {
      topic.due += 1;
      counts.due += 1;
    }
  }
  counts.topics = [...byTopic.values()];
  return counts;
}

export function flashcardSession(
  db: SqlDatabase,
  topics: readonly CourseTopic[],
  scope: { topicId?: string | undefined; moduleId?: string | undefined },
): FlashcardSession {
  const today = localDateString();
  const inScope = allCards(topics, readReviews(db)).filter(
    (card) =>
      (!scope.topicId || card.topicId === scope.topicId) &&
      (!scope.moduleId || card.moduleId === scope.moduleId),
  );
  const due = inScope
    .filter((card) => card.dueOn !== null && card.dueOn <= today)
    .sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string));
  const fresh = inScope.filter((card) => card.dueOn === null);
  const cards = [...due.slice(0, SESSION_CARDS)];
  cards.push(...fresh.slice(0, Math.min(SESSION_NEW_CARDS, SESSION_CARDS - cards.length)));
  return { today, cards, remaining: due.length + fresh.length - cards.length };
}

/** Records one SM-2 grade. `topicId` comes from the key, which only this server ever makes. */
export function reviewFlashcard(
  db: SqlDatabase,
  key: string,
  quality: number,
): FlashcardReviewResult {
  const row = db
    .prepare(
      'SELECT card_key, ease, interval_days, repetitions, due_on FROM flashcard_reviews WHERE card_key = ?',
    )
    .get(key) as ReviewRow | undefined;
  const state = sm2Next(row ? stateOf(row) : SM2_NEW_CARD, quality);
  const dueOn = addDaysToDate(localDateString(), state.intervalDays);
  db.prepare(
    `INSERT INTO flashcard_reviews
       (card_key, topic_id, ease, interval_days, repetitions, due_on, last_quality, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (card_key) DO UPDATE SET
       ease = excluded.ease,
       interval_days = excluded.interval_days,
       repetitions = excluded.repetitions,
       due_on = excluded.due_on,
       last_quality = excluded.last_quality,
       reviewed_at = excluded.reviewed_at`,
  ).run(
    key,
    key.split(':')[0] ?? key,
    state.ease,
    state.intervalDays,
    state.repetitions,
    dueOn,
    quality,
    Date.now(),
  );
  return { key, state, dueOn };
}
