import { loadLessonIndex } from '@compilerlab/content';
import type { AiSource } from '@compilerlab/shared';
import MiniSearch from 'minisearch';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { splitIntoSections, stripMdx } from './mdx-text';

export interface LessonChunk extends AiSource {
  id: string;
  text: string;
}

const STOP_WORDS = new Set(
  `a an and are as at be but by can do does for from how i in is it me my of on or that the this
   to was what when where which why will with you your`.split(/\s+/),
);

const MAX_QUERY_CHARS = 600;
/** A chunk from the lesson the student is reading counts for more. */
const CURRENT_TOPIC_BOOST = 1.6;

interface LessonIndex {
  signature: string;
  search: MiniSearch<LessonChunk>;
  texts: Map<string, string>;
}

/**
 * Finds the parts of the course that relate to a question, so answers are grounded on the lessons.
 * The index lives in memory, and is rebuilt only when a lesson file changes.
 */
export class LessonSearch {
  private index: LessonIndex | null = null;

  constructor(private readonly contentDir: string) {}

  /** The best matching chunks. Search is a help, not a need, so a failure just finds nothing. */
  find(
    query: string,
    options: { topicId?: string | undefined; limit?: number } = {},
  ): LessonChunk[] {
    const { topicId, limit = 4 } = options;
    if (!query.trim()) return [];
    try {
      const results = this.current().search.search(query.slice(0, MAX_QUERY_CHARS), {
        boostDocument: (_id, _term, stored) =>
          stored?.topicId === topicId ? CURRENT_TOPIC_BOOST : 1,
      });
      return results.slice(0, limit).map((result) => ({
        id: String(result.id),
        topicId: result.topicId as string,
        module: result.module as string,
        topicTitle: result.topicTitle as string,
        heading: result.heading as string,
        text: result.text as string,
      }));
    } catch {
      return [];
    }
  }

  /** A whole lesson as plain text, or null if there is no such lesson. */
  lessonText(topicId: string): string | null {
    try {
      return this.current().texts.get(topicId) ?? null;
    } catch {
      return null;
    }
  }

  private current(): LessonIndex {
    const { lessons } = loadLessonIndex(this.contentDir);
    const fileOf = (path: string) => join(this.contentDir, 'lessons', path);
    const signature = lessons
      .map((lesson) => `${lesson.path}:${statSync(fileOf(lesson.path)).mtimeMs}`)
      .join('\n');
    if (this.index?.signature === signature) return this.index;

    const search = new MiniSearch<LessonChunk>({
      fields: ['topicTitle', 'heading', 'text'],
      storeFields: ['topicId', 'module', 'topicTitle', 'heading', 'text'],
      processTerm: (term) => {
        const lower = term.toLowerCase();
        return STOP_WORDS.has(lower) ? null : lower;
      },
      searchOptions: {
        boost: { heading: 2, topicTitle: 1.5 },
        prefix: (term) => term.length >= 4,
        fuzzy: (term) => (term.length >= 5 ? 0.15 : false),
      },
    });
    const texts = new Map<string, string>();
    for (const lesson of lessons) {
      const text = stripMdx(readFileSync(fileOf(lesson.path), 'utf8'));
      texts.set(lesson.id, text);
      search.addAll(
        splitIntoSections(text).map((section, position) => ({
          id: `${lesson.id}#${position}`,
          topicId: lesson.id,
          module: lesson.module,
          topicTitle: lesson.title,
          heading: section.heading,
          text: section.text,
        })),
      );
    }
    this.index = { signature, search, texts };
    return this.index;
  }
}
