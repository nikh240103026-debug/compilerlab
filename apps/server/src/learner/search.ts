import { loadGlossary, loadLessonIndex, modules } from '@compilerlab/content';
import type { LessonSummary, SearchHit, SearchKind, SearchResponse } from '@compilerlab/shared';
import MiniSearch, { type SearchResult } from 'minisearch';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { splitIntoSections, stripMdx } from '../ai/mdx-text';
import type { CourseCatalog } from '../assessment/catalog';
import type { SqlDatabase } from '../db/driver';
import { readNotes } from './notebook';

interface SearchDocument {
  id: string;
  kind: SearchKind;
  title: string;
  text: string;
  context: string;
  to: string;
  topicId: string | null;
}

const STOP_WORDS = new Set(
  `a an and are as at be but by can do does for from how i in is it of on or that the this to was
   what when where which why will with you your`.split(/\s+/),
);

/** A definition that matches is usually what someone searching wants most. */
const KIND_BOOST: Readonly<Record<SearchKind, number>> = {
  glossary: 1.4,
  lesson: 1.1,
  note: 1.2,
  question: 0.8,
};

/** Typing searches on every pause, so the files are only looked at again every few seconds. */
const RECHECK_MS = 3000;
const SNIPPET_CHARS = 170;
const SNIPPET_LEAD_CHARS = 50;

function newIndex(): MiniSearch<SearchDocument> {
  return new MiniSearch<SearchDocument>({
    fields: ['title', 'text'],
    storeFields: ['kind', 'title', 'text', 'context', 'to', 'topicId'],
    processTerm: (term) => {
      const lower = term.toLowerCase();
      return STOP_WORDS.has(lower) ? null : lower;
    },
    searchOptions: {
      boost: { title: 3 },
      // Prefixes make results appear while a word is still being typed.
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.15 : false),
      combineWith: 'AND',
    },
  });
}

/** Lesson text and notes are Markdown. A search result shows it as plain words. */
function plainWords(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/[`*_#>|$\\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippetOf(text: string, terms: readonly string[]): string {
  const words = plainWords(text);
  const lower = words.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0);
  const start = Math.max(
    0,
    (positions.length > 0 ? Math.min(...positions) : 0) - SNIPPET_LEAD_CHARS,
  );
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${words.slice(start, end).trim()}${end < words.length ? '…' : ''}`;
}

function toHit(result: SearchResult): SearchHit {
  return {
    id: String(result.id),
    kind: result.kind as SearchKind,
    title: plainWords(result.title as string),
    // A question's indexed text is only its tags, and its prompt is already the title.
    snippet: result.kind === 'question' ? '' : snippetOf(result.text as string, result.terms),
    context: result.context as string,
    to: result.to as string,
    topicId: result.topicId as string | null,
    terms: result.terms,
    score: result.score,
  };
}

/**
 * Part 11's search across lessons, glossary, notes and questions. The course content rarely
 * changes, so its index is kept until a file does. Notes change as the student types, so their small
 * index is rebuilt for each search and can never be out of date.
 */
export class GlobalSearch {
  private built: { signature: string; index: MiniSearch<SearchDocument> } | null = null;
  private checkedAt = 0;

  constructor(
    private readonly contentDir: string,
    private readonly db: SqlDatabase,
    private readonly catalog: CourseCatalog,
    private readonly onProblem: (message: string) => void,
  ) {}

  search(query: string, kinds: readonly SearchKind[], limit: number): SearchResponse {
    const trimmed = query.trim();
    if (!trimmed || kinds.length === 0) return { query: trimmed, hits: [] };
    const options = {
      filter: (result: SearchResult) => kinds.includes(result.kind as SearchKind),
      boostDocument: (_id: unknown, _term: string, stored?: Record<string, unknown>) =>
        KIND_BOOST[stored?.kind as SearchKind] ?? 1,
    };
    const { index, lessons } = this.content();
    const results = index.search(trimmed, options);
    if (kinds.includes('note')) results.push(...this.notesIndex(lessons).search(trimmed, options));

    // One lesson can match in many sections, and only its best one is worth a row.
    const seenLessons = new Set<string>();
    const hits = results
      .toSorted((a, b) => b.score - a.score)
      .filter((result) => {
        if (result.kind !== 'lesson') return true;
        const topicId = result.topicId as string;
        if (seenLessons.has(topicId)) return false;
        seenLessons.add(topicId);
        return true;
      })
      .slice(0, limit)
      .map(toHit);
    return { query: trimmed, hits };
  }

  private content(): { index: MiniSearch<SearchDocument>; lessons: LessonSummary[] } {
    const { lessons } = loadLessonIndex(this.contentDir);
    const now = Date.now();
    if (this.built && now - this.checkedAt < RECHECK_MS)
      return { index: this.built.index, lessons };
    this.checkedAt = now;

    const stamp = (path: string) => {
      try {
        return statSync(join(this.contentDir, path)).mtimeMs;
      } catch {
        return 0;
      }
    };
    const signature = [
      ...lessons.map((lesson) => `${lesson.path}:${stamp(`lessons/${lesson.path}`)}`),
      ...lessons.map((lesson) => `${lesson.id}:${stamp(`banks/${lesson.id}.json`)}`),
      `glossary:${stamp('data/glossary.json')}`,
    ].join('\n');
    if (this.built?.signature === signature) return { index: this.built.index, lessons };

    const index = newIndex();
    index.addAll([
      ...this.lessonDocuments(lessons),
      ...this.glossaryDocuments(),
      ...this.questionDocuments(),
    ]);
    this.built = { signature, index };
    return { index, lessons };
  }

  private lessonDocuments(lessons: readonly LessonSummary[]): SearchDocument[] {
    return lessons.flatMap((lesson) => {
      const file = join(this.contentDir, 'lessons', lesson.path);
      const sections = splitIntoSections(stripMdx(readFileSync(file, 'utf8')));
      return sections.map((section, position): SearchDocument => ({
        id: `lesson:${lesson.id}:${position}`,
        kind: 'lesson',
        title: lesson.title,
        text: `${section.heading}. ${section.text}`,
        context: section.heading,
        to: `/learn/${lesson.module}/${lesson.id}`,
        topicId: lesson.id,
      }));
    });
  }

  private glossaryDocuments(): SearchDocument[] {
    const moduleTitle = new Map(modules.map((module) => [module.id, module.title]));
    try {
      const { terms, problems } = loadGlossary(this.contentDir);
      for (const problem of problems) this.onProblem(`${problem.file}: ${problem.message}`);
      return terms.map((entry): SearchDocument => ({
        id: `glossary:${entry.slug}`,
        kind: 'glossary',
        title: entry.term,
        text: entry.definition,
        context: moduleTitle.get(entry.module) ?? entry.module,
        to: `/glossary?term=${encodeURIComponent(entry.slug)}`,
        topicId: null,
      }));
    } catch (error) {
      this.onProblem(`The glossary could not be read: ${(error as Error).message}`);
      return [];
    }
  }

  /** Only the prompt is indexed, because searching for an answer should not reveal it. */
  private questionDocuments(): SearchDocument[] {
    return this.catalog.topics().flatMap(({ lesson, bank }) =>
      (
        [
          ['quiz-heading', bank.quiz],
          ['practice-heading', bank.practice],
        ] as const
      ).flatMap(([section, questions]) =>
        questions.map((question): SearchDocument => ({
          id: `question:${lesson.id}:${question.id}`,
          kind: 'question',
          title: question.prompt,
          text: question.tags.join(' '),
          context: lesson.title,
          to: `/learn/${lesson.module}/${lesson.id}#${section}`,
          topicId: lesson.id,
        })),
      ),
    );
  }

  private notesIndex(lessons: readonly LessonSummary[]): MiniSearch<SearchDocument> {
    const index = newIndex();
    index.addAll(
      readNotes(this.db).flatMap((note) => {
        const lesson = lessons.find(({ id }) => id === note.topicId);
        if (!lesson) return [];
        return [
          {
            id: `note:${note.topicId}`,
            kind: 'note' as const,
            title: lesson.title,
            text: note.body,
            context: 'Your note',
            to: `/learn/${lesson.module}/${lesson.id}?panel=notes`,
            topicId: lesson.id,
          },
        ];
      }),
    );
    return index;
  }
}
