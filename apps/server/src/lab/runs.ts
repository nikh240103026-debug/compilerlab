import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { LabFile } from '@compilerlab/shared';

const RUNS_KEPT = 20;
const RUN_MAX_AGE_MS = 60 * 60 * 1000;

export function runsDirectory(dataDir: string): string {
  return join(dataDir, 'runs');
}

/** A new, empty folder for one job. */
export async function createRunDirectory(dataDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const directory = join(runsDirectory(dataDir), `${stamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Writes a job's files. The names were validated already, but this is the last line of defense:
 * nothing is written unless the final path is directly inside the run folder.
 */
export async function writeRunFiles(directory: string, files: readonly LabFile[]): Promise<void> {
  for (const file of files) {
    const target = resolve(directory, file.name);
    const inside = relative(directory, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || /[\\/]/.test(inside)) {
      throw new Error(`Refused to write outside the run folder: ${file.name}`);
    }
    // "wx" fails rather than following anything that is already there.
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
  }
}

/** Deletes old runs. A folder still in use on Windows stays until the next sweep. */
export async function sweepRuns(
  dataDir: string,
  { now = Date.now(), keep = RUNS_KEPT, maxAgeMs = RUN_MAX_AGE_MS } = {},
): Promise<void> {
  const root = runsDirectory(dataDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const runs = await Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      try {
        return { path, modified: (await stat(path)).mtimeMs };
      } catch {
        return { path, modified: 0 };
      }
    }),
  );
  runs.sort((a, b) => b.modified - a.modified);
  await Promise.all(
    runs
      .filter((run, index) => index >= keep || now - run.modified > maxAgeMs)
      .map((run) => rm(run.path, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})),
  );
}
