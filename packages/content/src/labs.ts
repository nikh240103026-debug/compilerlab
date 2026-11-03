import { LabExerciseMetaSchema, type LabExercise } from '@compilerlab/shared';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ContentProblem } from './lessons';

export interface LabExerciseIndex {
  exercises: LabExercise[];
  /** A bad exercise is skipped and reported here, like a bad lesson. */
  problems: ContentProblem[];
}

function findExerciseFolders(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(directory, entry.name);
    return existsSync(join(path, 'exercise.json')) ? [path] : findExerciseFolders(path);
  });
}

function readFolder(directory: string): { name: string; content: string }[] {
  if (!existsSync(directory)) throw new Error(`The folder ${directory} is missing.`);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      // Git may check files out with CRLF on Windows, and C does not care either way.
      content: readFileSync(join(directory, entry.name), 'utf8').replace(/\r\n/g, '\n'),
    }));
}

/**
 * Reads every exercise from `packages/content/labs`. Each one is a folder with exercise.json, a
 * starter folder and a solution folder, so the code can be read and edited as real files.
 */
export function loadLabExercises(contentDir: string): LabExerciseIndex {
  const labsDir = join(contentDir, 'labs');
  const exercises: LabExercise[] = [];
  const problems: ContentProblem[] = [];

  for (const folder of findExerciseFolders(labsDir)) {
    const path = relative(labsDir, folder).split(sep).join('/');
    try {
      const parsed = LabExerciseMetaSchema.safeParse(
        JSON.parse(readFileSync(join(folder, 'exercise.json'), 'utf8')),
      );
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${issue?.path.join('.') || 'exercise'}: ${issue?.message}`);
      }
      if (exercises.some((exercise) => exercise.id === parsed.data.id)) {
        throw new Error(`The exercise id ${parsed.data.id} is used twice.`);
      }
      exercises.push({
        ...parsed.data,
        files: readFolder(join(folder, 'starter')),
        solution: readFolder(join(folder, 'solution')),
      });
    } catch (error) {
      problems.push({ file: path, message: (error as Error).message });
    }
  }

  exercises.sort((a, b) => a.module.localeCompare(b.module) || a.order - b.order);
  return { exercises, problems };
}
