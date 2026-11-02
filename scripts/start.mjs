#!/usr/bin/env node
// @ts-check
// `npm start`: launches the API server and the Vite dev server together and opens the browser.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { dependenciesInstalled, ensureEnvFile, readEnv, ROOT } from './lib/env.mjs';
import {
  isPortFree,
  killTree,
  openBrowser,
  shouldOpenBrowser,
  waitForHttp,
} from './lib/processes.mjs';
import { bold, dim } from './lib/report.mjs';

const startedAt = performance.now();

if (!dependenciesInstalled()) {
  console.error('Dependencies are not fully installed. Run: npm run setup');
  process.exit(1);
}

ensureEnvFile();
const env = readEnv();
const serverPort = Number(env.PORT) || 4317;
const webPort = Number(env.WEB_PORT) || 5173;

for (const [name, port, variable] of /** @type {const} */ ([
  ['API server', serverPort, 'PORT'],
  ['web app', webPort, 'WEB_PORT'],
])) {
  if (!(await isPortFree(port))) {
    console.error(`Port ${port} for the ${name} is in use. CompilerLab may already be running.`);
    console.error(`Close the other program, or set a different ${variable} in .env.`);
    process.exit(1);
  }
}

const childEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(serverPort),
  WEB_PORT: String(webPort),
};

/** @param {string} script @param {string[]} args @param {string} cwd */
function launch(script, args, cwd) {
  return spawn(process.execPath, [join(ROOT, 'node_modules', script), ...args], {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

const children = [
  launch(
    'tsx/dist/cli.mjs',
    ['watch', '--clear-screen=false', 'src/index.ts'],
    join(ROOT, 'apps', 'server'),
  ),
  launch('vite/bin/vite.js', ['--logLevel', 'warn'], join(ROOT, 'apps', 'web')),
];

let stopping = false;
/** @param {number} code */
function stop(code) {
  if (stopping) return;
  stopping = true;
  children.forEach(killTree);
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) {
  child.on('exit', () => {
    if (stopping) return;
    console.error('A CompilerLab process stopped unexpectedly. Shutting down.');
    console.error('Run `npm run doctor` if this keeps happening.');
    stop(1);
  });
}

const url = `http://127.0.0.1:${webPort}`;
try {
  await Promise.all([waitForHttp(`http://127.0.0.1:${serverPort}/api/health`), waitForHttp(url)]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
}

const seconds = ((performance.now() - startedAt) / 1000).toFixed(2);
console.log(`\n${bold('CompilerLab is running')} at ${url} ${dim(`(ready in ${seconds}s)`)}`);
console.log(dim('Press Ctrl+C to stop.\n'));
if (shouldOpenBrowser()) openBrowser(url);
