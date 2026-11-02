import { DEFAULT_GEMINI_MODEL, DEFAULT_SERVER_PORT, type DbDriver } from '@compilerlab/shared';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_SERVER_PORT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('warn'),
  GEMINI_API_KEY: z.string().trim().default(''),
  GEMINI_MODEL: z.string().trim().default(DEFAULT_GEMINI_MODEL),
  COMPILERLAB_DATA_DIR: z.string().default('data'),
  SQLITE_DRIVER: z.enum(['better-sqlite3', 'node:sqlite']).optional(),
});

export interface AppConfig {
  isProduction: boolean;
  port: number;
  logLevel: string;
  geminiApiKey: string;
  geminiModel: string;
  rootDir: string;
  dataDir: string;
  dbDriver: DbDriver | undefined;
  version: string;
}

/** Finds the project root from anywhere, so source and bundled builds both work. */
export function findRepoRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'compilerlab') {
      return dir;
    }
    if (dirname(dir) === dir) throw new Error(`Could not find the project root from ${start}`);
  }
}

export function loadConfig(env: Record<string, string | undefined>, rootDir: string): AppConfig {
  // A blank value in .env (`PORT=`) means "use the default".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Please fix these values in .env:\n${problems.join('\n')}`);
  }
  const values = parsed.data;
  return {
    isProduction: values.NODE_ENV === 'production',
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    geminiApiKey: values.GEMINI_API_KEY,
    geminiModel: values.GEMINI_MODEL,
    rootDir,
    dataDir: resolve(rootDir, values.COMPILERLAB_DATA_DIR),
    dbDriver: values.SQLITE_DRIVER,
    version: JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version,
  };
}
