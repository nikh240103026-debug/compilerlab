import { compileScanner, runScanner, Utf8Decoder } from '@compilerlab/engine';
import { labFileNameProblem, normalizeOutput, type LabExercise } from '@compilerlab/shared';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLabExercises } from './labs';
import { loadLessonIndex } from './lessons';

const contentDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { exercises, problems } = loadLabExercises(contentDir);

function runSimulated(source: string, stdin: string): string {
  const decoder = new Utf8Decoder();
  let output = '';
  const steps = runScanner(compileScanner(source), stdin, {
    write: (stream, bytes) => {
      if (stream === 'stdout') output += decoder.write(bytes);
    },
  });
  for (let state = steps.next(); !state.done; state = steps.next());
  return output;
}

const lexFile = (files: LabExercise['files']) => {
  const file = files.find(({ name }) => name.endsWith('.l'));
  if (!file) throw new Error('This exercise has no .l file.');
  return file.content;
};

describe('the lab exercises', () => {
  it('all load', () => {
    expect(problems).toEqual([]);
  });

  it('meet the target of at least 8 for Module 1', () => {
    const count = exercises.filter(({ module }) => module === 'lexical-analysis').length;
    expect(count).toBeGreaterThanOrEqual(8);
  });

  it('link only to lessons that exist', () => {
    const lessons = new Set(loadLessonIndex(contentDir).lessons.map(({ id }) => id));
    for (const exercise of exercises) {
      for (const topic of exercise.topics) expect(lessons, exercise.id).toContain(topic);
    }
  });

  it('use file names the lab accepts', () => {
    for (const { name } of exercises.flatMap(({ files, solution }) => [...files, ...solution])) {
      expect(labFileNameProblem(name), name).toBeNull();
    }
  });

  it('keep the same files in the starter and the solution', () => {
    for (const exercise of exercises) {
      expect(exercise.solution.map(({ name }) => name)).toEqual(
        exercise.files.map(({ name }) => name),
      );
    }
  });

  it('agree with the word count the Lex lesson quotes', () => {
    const exercise = exercises.find(({ id }) => id === 'word-counter') as LabExercise;
    expect(normalizeOutput(runSimulated(lexFile(exercise.solution), 'a bb\n\n'))).toBe('2 2 6');
  });

  describe.each(exercises.map((exercise) => [exercise.id, exercise] as const))(
    '%s',
    (_id, exercise) => {
      it('has a solution that passes every test', () => {
        for (const test of exercise.tests) {
          expect(
            normalizeOutput(runSimulated(lexFile(exercise.solution), test.input)),
            test.name,
          ).toBe(normalizeOutput(test.expected));
        }
      });

      it('has a starter that runs but does not already pass', () => {
        const starter = lexFile(exercise.files);
        const results = exercise.tests.map(
          (test) =>
            normalizeOutput(runSimulated(starter, test.input)) === normalizeOutput(test.expected),
        );
        expect(results).toContain(false);
      });

      it('has starting input that the solution can run on', () => {
        expect(() => runSimulated(lexFile(exercise.solution), exercise.stdin)).not.toThrow();
      });
    },
  );
});

describe('loadLabExercises', () => {
  const folder = () => mkdtempSync(join(tmpdir(), 'compilerlab-labs-'));
  const valid = {
    id: 'sample',
    module: 'lexical-analysis',
    topics: ['lex-and-flex'],
    order: 1,
    title: 'Sample',
    difficulty: 'easy',
    tags: ['flex'],
    exams: ['university'],
    brief: 'Do the thing.',
    pipeline: 'lex',
    stdin: '',
    tests: [
      { name: 'Visible', input: '', expected: '' },
      { name: 'Hidden', input: '', expected: '', hidden: true },
    ],
    hints: ['One', 'Two'],
    explanation: 'Because.',
  };
  const writeExercise = (root: string, name: string, meta: object, withFolders = true) => {
    const path = join(root, 'labs', 'module', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'exercise.json'), JSON.stringify(meta));
    if (withFolders) {
      mkdirSync(join(path, 'starter'));
      mkdirSync(join(path, 'solution'));
      writeFileSync(join(path, 'starter', 'a.l'), 'line\r\nline\r\n');
      writeFileSync(join(path, 'solution', 'a.l'), '%%\n');
    }
  };

  it('reads a valid exercise and normalizes line endings', () => {
    const root = folder();
    try {
      writeExercise(root, 'sample', valid);
      const loaded = loadLabExercises(root);
      expect(loaded.problems).toEqual([]);
      expect(loaded.exercises[0]?.files).toEqual([{ name: 'a.l', content: 'line\nline\n' }]);
      expect(loaded.exercises[0]?.tests[0]?.hidden).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a schema problem', { ...valid, difficulty: 'impossible' }, true, 'difficulty'],
    ['no hidden test', { ...valid, tests: [valid.tests[0], valid.tests[0]] }, true, 'hidden'],
    ['no visible test', { ...valid, tests: [valid.tests[1], valid.tests[1]] }, true, 'visible'],
    ['a missing folder', valid, false, 'missing'],
  ])('skips and reports %s', (_name, meta, withFolders, expected) => {
    const root = folder();
    try {
      writeExercise(root, 'sample', meta, withFolders);
      const loaded = loadLabExercises(root);
      expect(loaded.exercises).toEqual([]);
      expect(loaded.problems[0]?.message).toContain(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a duplicate id and broken JSON', () => {
    const root = folder();
    try {
      writeExercise(root, 'one', valid);
      writeExercise(root, 'two', valid);
      const path = join(root, 'labs', 'module', 'three');
      mkdirSync(path);
      writeFileSync(join(path, 'exercise.json'), '{ not json');
      const loaded = loadLabExercises(root);
      expect(loaded.exercises).toHaveLength(1);
      expect(loaded.problems).toHaveLength(2);
      expect(loaded.problems.map(({ message }) => message).join(' ')).toContain('used twice');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds no exercises when there is no labs folder', () => {
    const root = folder();
    try {
      expect(loadLabExercises(root)).toEqual({ exercises: [], problems: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
