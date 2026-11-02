// Checks all course content on every test run: frontmatter, question banks, that lessons compile,
// that they use only known components, and that anything the engine can verify is true.
import {
  attempt,
  buildLexer,
  dfaAccepts,
  minimizeDfa,
  parseLexSpec,
  parseRegex,
  subsetConstruct,
  thompson,
} from '@compilerlab/engine';
import { VISUALIZER_IDS } from '@compilerlab/shared/constants';
import { compile } from '@mdx-js/mdx';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import rehypeKatex from 'rehype-katex';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { describe, expect, it } from 'vitest';
import { modules } from './index';
import { loadLessonIndex, loadTopicBank } from './lessons';

const CONTENT_DIR = resolve(import.meta.dirname, '..');
const { lessons, problems } = loadLessonIndex(CONTENT_DIR);

const ALLOWED_COMPONENTS = new Set(['Callout', 'TryIt', 'AutomatonFigure']);
const REQUIRED_SECTIONS = ['## Why this matters', '## Worked example', '## Common mistakes'];
const PLACEHOLDER = /lorem ipsum|\bTODO\b|\bTBD\b|coming soon/i;

const sourceOf = (path: string) => readFileSync(join(CONTENT_DIR, 'lessons', path), 'utf8');

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(tag)?.[1];
}

function dfaFor(regex: string) {
  return minimizeDfa(subsetConstruct(thompson(parseRegex(regex)).nfa).dfa).dfa;
}

describe('the lesson index', () => {
  it('has no broken lessons', () => {
    expect(problems).toEqual([]);
  });

  it('gives each lesson a real module and a unique place in it', () => {
    const moduleIds = new Set(modules.map((module) => module.id));
    for (const lesson of lessons) expect(moduleIds).toContain(lesson.module);
    const places = lessons.map((lesson) => `${lesson.module}#${lesson.order}`);
    expect(new Set(places).size).toBe(places.length);
  });
});

describe.each(lessons.map((lesson) => [lesson.id, lesson] as const))('topic %s', (_id, lesson) => {
  const source = sourceOf(lesson.path);
  const body = source.replace(/^---[\s\S]*?\n---/, '');
  // Code samples may contain anything, such as Flex's <INITIAL>, without being components.
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

  it('lists only prerequisites that exist', () => {
    const ids = new Set(lessons.map((other) => other.id));
    for (const prerequisite of lesson.prerequisites) expect(ids).toContain(prerequisite);
    expect(lesson.prerequisites).not.toContain(lesson.id);
  });

  it('follows the topic template', () => {
    for (const section of REQUIRED_SECTIONS) expect(body).toContain(section);
  });

  it('has no placeholder text', () => {
    expect(body).not.toMatch(PLACEHOLDER);
  });

  it('compiles, including its math', async () => {
    await compile(source, {
      remarkPlugins: [remarkFrontmatter, remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: true, strict: 'ignore' }]],
    });
  });

  it('uses only components that exist', () => {
    const used = [...prose.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1] as string);
    for (const name of used) expect(ALLOWED_COMPONENTS).toContain(name);
  });

  it('gives every visualizer a valid starting input', () => {
    for (const { id, props } of lesson.visualizers) {
      expect(VISUALIZER_IDS).toContain(id);
      if (props?.regex) expect(attempt(() => parseRegex(props.regex as string)).ok).toBe(true);
      if (props?.rules) {
        expect(attempt(() => buildLexer(parseLexSpec(props.rules as string))).ok).toBe(true);
      }
    }
  });

  it('points every button and figure in the text at something real', () => {
    for (const [tag] of body.matchAll(/<TryIt\b[^>]*>/g)) {
      expect(VISUALIZER_IDS).toContain(attribute(tag, 'visualizer'));
      const regex = attribute(tag, 'regex');
      if (regex) expect(attempt(() => parseRegex(regex)).ok, tag).toBe(true);
    }
    for (const [tag] of body.matchAll(/<AutomatonFigure\b[^>]*>/g)) {
      const regex = attribute(tag, 'regex');
      expect(regex, tag).toBeTruthy();
      expect(attempt(() => parseRegex(regex as string)).ok, tag).toBe(true);
    }
  });

  describe('question bank', () => {
    const bank = loadTopicBank(CONTENT_DIR, lesson.id);

    it('exists and is valid', () => {
      expect(bank).not.toBeNull();
    });

    it('has distinct options on every multiple-choice question', () => {
      for (const question of [...(bank?.quiz ?? []), ...(bank?.practice ?? [])]) {
        if (question.type === 'mcq') {
          expect(new Set(question.options).size, question.id).toBe(question.options.length);
        }
      }
    });

    it('has no placeholder text', () => {
      expect(JSON.stringify(bank)).not.toMatch(PLACEHOLDER);
    });

    it('states regex problems the engine agrees with', () => {
      for (const problem of bank?.practice ?? []) {
        if (problem.type !== 'regex') continue;
        const dfa = dfaFor(problem.reference);
        expect(problem.accepts.length + problem.rejects.length, problem.id).toBeGreaterThan(0);
        for (const text of problem.accepts)
          expect(dfaAccepts(dfa, text), `${problem.id}: ${text}`).toBe(true);
        for (const text of problem.rejects)
          expect(dfaAccepts(dfa, text), `${problem.id}: ${text}`).toBe(false);
      }
    });
  });
});

describe('loadLessonIndex and loadTopicBank', () => {
  it('finds nothing in a folder with no lessons, instead of failing', () => {
    expect(loadLessonIndex(join(CONTENT_DIR, 'no-such-folder'))).toEqual({
      lessons: [],
      problems: [],
    });
    expect(loadTopicBank(CONTENT_DIR, 'no-such-topic')).toBeNull();
  });
});
