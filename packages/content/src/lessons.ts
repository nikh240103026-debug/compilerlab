import {
  LessonMetaSchema,
  TopicBankSchema,
  type LessonSummary,
  type TopicBank,
} from '@compilerlab/shared';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ContentProblem {
  file: string;
  message: string;
}

export interface LessonIndex {
  lessons: LessonSummary[];
  /** A bad file is skipped and reported here, so one typo cannot take the whole course down. */
  problems: ContentProblem[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function findMdxFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findMdxFiles(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** Reads every lesson's frontmatter from `packages/content/lessons`. */
export function loadLessonIndex(contentDir: string): LessonIndex {
  const lessonsDir = join(contentDir, 'lessons');
  const lessons: LessonSummary[] = [];
  const problems: ContentProblem[] = [];

  for (const file of findMdxFiles(lessonsDir)) {
    const path = relative(lessonsDir, file).split(sep).join('/');
    try {
      const match = FRONTMATTER.exec(readFileSync(file, 'utf8'));
      if (!match) throw new Error('The file has no frontmatter.');
      const parsed = LessonMetaSchema.safeParse(parseYaml(match[1] as string));
      if (!parsed.success) {
        const { path: where, message } = parsed.error.issues[0] as {
          path: PropertyKey[];
          message: string;
        };
        throw new Error(`${where.join('.') || 'frontmatter'}: ${message}`);
      }
      if (lessons.some((lesson) => lesson.id === parsed.data.id)) {
        throw new Error(`The topic id ${parsed.data.id} is used twice.`);
      }
      lessons.push({ ...parsed.data, path });
    } catch (error) {
      problems.push({ file: path, message: (error as Error).message });
    }
  }

  lessons.sort((a, b) => a.module.localeCompare(b.module) || a.order - b.order);
  return { lessons, problems };
}

/** Reads a topic's questions and flashcards. Returns null if it has none. Throws if invalid. */
export function loadTopicBank(contentDir: string, topicId: string): TopicBank | null {
  const file = join(contentDir, 'banks', `${topicId}.json`);
  if (!existsSync(file)) return null;
  return TopicBankSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
