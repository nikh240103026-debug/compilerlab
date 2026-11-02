#!/usr/bin/env node
// @ts-check
// `npm run start:prod`: serves the built app and API from Fastify on one port.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureEnvFile, readEnv, ROOT } from './lib/env.mjs';
import { killTree, openBrowser, shouldOpenBrowser, waitForHttp } from './lib/processes.mjs';
import { bold, dim } from './lib/report.mjs';

const entry = join(ROOT, 'apps', 'server', 'dist', 'index.js');
if (!existsSync(entry) || !existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('No production build found. Run: npm run build');
  process.exit(1);
}

ensureEnvFile();
const port = Number(readEnv().PORT) || 4317;
const server = spawn(process.execPath, [entry], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  windowsHide: true,
});

let stopping = false;
const stop = () => {
  stopping = true;
  killTree(server);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  if (!stopping) process.exit(code ?? 1);
});

const url = `http://127.0.0.1:${port}`;
await waitForHttp(`${url}/api/health`);
console.log(`\n${bold('CompilerLab is running')} at ${url}`);
console.log(dim('Press Ctrl+C to stop.\n'));
if (shouldOpenBrowser()) openBrowser(url);
