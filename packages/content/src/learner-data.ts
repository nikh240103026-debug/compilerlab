import {
  CheatSheetListSchema,
  glossarySlug,
  GlossaryTermSchema,
  PlacementQuizSchema,
  SyllabusListSchema,
  TopQuestionListSchema,
  WorkedProblemListSchema,
  type ExamResources,
  type GlossaryEntry,
  type PlacementQuestion,
} from '@compilerlab/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import rawModules from '../data/modules.json';
import type { ContentProblem } from './lessons';

const KNOWN_MODULES = new Set(rawModules.map((module) => module.id));

function readDataFile(contentDir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(contentDir, 'data', name), 'utf8'));
}

/** Names the file and the field, because this message ends up in a content author's terminal. */
function parseDataFile<S extends z.ZodType>(contentDir: string, name: string, schema: S) {
  const parsed = schema.safeParse(readDataFile(contentDir, name));
  if (parsed.success) return parsed.data as z.output<S>;
  const issue = parsed.error.issues[0];
  throw new Error(`${name}: ${issue?.path.join('.') || 'file'}: ${issue?.message}`);
}

export interface GlossaryIndex {
  /** Sorted by term, ignoring case. */
  terms: GlossaryEntry[];
  /** A bad term is skipped and reported here, like a bad lesson. */
  problems: ContentProblem[];
}

/**
 * Reads `packages/content/data/glossary.json`, one term at a time, so one typo costs one term.
 * The format is documented in docs/CONTENT_GUIDE.md.
 */
export function loadGlossary(contentDir: string): GlossaryIndex {
  const file = 'data/glossary.json';
  const raw = readDataFile(contentDir, 'glossary.json');
  if (!Array.isArray(raw)) {
    return { terms: [], problems: [{ file, message: 'The file must be a list of terms.' }] };
  }

  const terms = new Map<string, GlossaryEntry>();
  const problems: ContentProblem[] = [];
  raw.forEach((value: unknown, index) => {
    const parsed = GlossaryTermSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = `item ${index + 1}, ${issue?.path.join('.') || 'term'}`;
      problems.push({ file, message: `${where}: ${issue?.message}` });
      return;
    }
    const { term, module } = parsed.data;
    const slug = glossarySlug(term);
    if (!KNOWN_MODULES.has(module)) {
      problems.push({ file, message: `"${term}" names an unknown module: ${module}.` });
    } else if (!slug || terms.has(slug)) {
      problems.push({ file, message: `"${term}" is listed twice.` });
    } else {
      terms.set(slug, { ...parsed.data, slug });
    }
  });

  // A related term that does not exist yet is still useful text, so it stays and is reported.
  for (const entry of terms.values()) {
    for (const name of entry.related) {
      if (!terms.has(glossarySlug(name))) {
        problems.push({ file, message: `"${entry.term}" relates to "${name}", which is missing.` });
      }
    }
  }

  return {
    terms: [...terms.values()].toSorted((a, b) =>
      a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }),
    ),
    problems,
  };
}

/** Everything the exam prep center reads. Throws with a readable message if a file is invalid. */
export function loadExamResources(contentDir: string): ExamResources {
  return {
    syllabi: parseDataFile(contentDir, 'syllabi.json', SyllabusListSchema),
    cheatSheets: parseDataFile(contentDir, 'cheat-sheets.json', CheatSheetListSchema),
    topQuestions: parseDataFile(contentDir, 'top-questions.json', TopQuestionListSchema),
    workedProblems: parseDataFile(contentDir, 'worked-problems.json', WorkedProblemListSchema),
  };
}

export function loadPlacementQuiz(contentDir: string): PlacementQuestion[] {
  return parseDataFile(contentDir, 'placement.json', PlacementQuizSchema);
}
