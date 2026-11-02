import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEnvFile, readEnv } from '../../../scripts/lib/env.mjs';
import { buildApp } from './app';
import { findRepoRoot, loadConfig, type AppConfig } from './config';
import { openAppDatabase } from './db/app-database';
import type { SqlDatabase } from './db/driver';

function fail(message: string): never {
  console.error(`\nCompilerLab could not start.\n${message}\n`);
  process.exit(1);
}

const rootDir = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
ensureEnvFile(rootDir);

let config: AppConfig;
try {
  config = loadConfig(readEnv(rootDir), rootDir);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let db: SqlDatabase;
try {
  db = await openAppDatabase(config.dataDir, {
    driver: config.dbDriver,
    onFallback: () =>
      console.warn(
        "better-sqlite3 could not load, so CompilerLab is using Node's built-in node:sqlite.\nRun `npm run doctor` for details.",
      ),
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(
    `The database in ${config.dataDir} could not be opened: ${reason}\nIf the file is damaged, run \`npm run reset\`. Your backups are kept.`,
  );
}

const app = await buildApp({
  config,
  db,
  ...(config.isProduction ? { webRoot: join(rootDir, 'apps', 'web', 'dist') } : {}),
});

async function shutdown() {
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  // Loopback only. Later LAN mode must opt in explicitly (docs/SPEC.md, Part 11).
  await app.listen({ host: '127.0.0.1', port: config.port });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    fail(`Port ${config.port} is in use. Close the other program or change PORT in .env.`);
  }
  throw error;
}
