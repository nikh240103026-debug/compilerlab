import { loadLessonIndex, loadTopicBank } from '@compilerlab/content';
import {
  QUESTION_DIFFICULTIES,
  type AssessmentCatalog,
  type CatalogTopic,
  type GeneratedQuestion,
  type LessonSummary,
  type QuestionDifficulty,
  type QuestionType,
  type TopicBank,
} from '@compilerlab/shared';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface CourseTopic {
  lesson: LessonSummary;
  bank: TopicBank;
}

/**
 * Reads every topic's bank. Parsing them all takes a moment and the hub asks often, so a parsed bank
 * is kept until its file changes. A broken bank is left out and logged, as with a broken lesson.
 */
export class CourseCatalog {
  private readonly cache = new Map<string, { changedAt: number; bank: TopicBank | null }>();

  constructor(
    private readonly contentDir: string,
    private readonly onProblem: (file: string, message: string) => void,
  ) {}

  private bankOf(topicId: string): TopicBank | null {
    const file = join(this.contentDir, 'banks', `${topicId}.json`);
    let changedAt: number;
    try {
      changedAt = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.cache.get(topicId);
    if (cached?.changedAt === changedAt) return cached.bank;
    let bank: TopicBank | null = null;
    try {
      bank = loadTopicBank(this.contentDir, topicId);
    } catch (error) {
      this.onProblem(file, (error as Error).message);
    }
    this.cache.set(topicId, { changedAt, bank });
    return bank;
  }

  topics(): CourseTopic[] {
    const { lessons, problems } = loadLessonIndex(this.contentDir);
    for (const problem of problems) this.onProblem(problem.file, problem.message);
    return lessons.flatMap((lesson) => {
      const bank = this.bankOf(lesson.id);
      return bank ? [{ lesson, bank }] : [];
    });
  }
}

/** Question counts for the setup form. Questions of a kind nobody selected are never sent. */
export function summarizeCatalog(
  topics: readonly CourseTopic[],
  generated: readonly GeneratedQuestion[],
): AssessmentCatalog {
  return {
    topics: topics.map(({ lesson, bank }): CatalogTopic => {
      const byType: Partial<Record<QuestionType, number>> = {};
      const byDifficulty = Object.fromEntries(
        QUESTION_DIFFICULTIES.map((level) => [level, 0]),
      ) as Record<QuestionDifficulty, number>;
      for (const question of [...bank.practice, ...bank.quiz]) {
        byType[question.type] = (byType[question.type] ?? 0) + 1;
        byDifficulty[question.difficulty] += 1;
      }
      const own = generated.filter((item) => item.topicId === lesson.id);
      return {
        topicId: lesson.id,
        moduleId: lesson.module,
        title: lesson.title,
        order: lesson.order,
        total: bank.practice.length + bank.quiz.length,
        byType,
        byDifficulty,
        generated: own.length,
        generatedReviewed: own.filter((item) => item.reviewed).length,
      };
    }),
  };
}
