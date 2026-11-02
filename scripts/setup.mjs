#!/usr/bin/env node
// @ts-check
// One-command setup for a fresh clone. Runs on bare Node, before any dependency exists.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkNode } from './lib/checks.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { ensureEnvFile, ROOT } from './lib/env.mjs';
import { bold, printCheck, printFix } from './lib/report.mjs';

/**
 * Runs npm without a shell. `npm run` provides npm_execpath; the shell fallback only
 * covers running this file directly, and its arguments are fixed strings.
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  const child = npmCli
    ? spawn(process.execPath, [npmCli, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawn(`npm ${args.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true });
  return new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

console.log(bold('Setting up CompilerLab'));

const node = checkNode();
printCheck(node.state, 'Node', node.detail);
printFix(node.fix);
if (node.state === 'fail') process.exit(1);

const envFile = ensureEnvFile();
printCheck('ok', '.env', envFile.created ? 'created from .env.example' : 'already exists, kept');

mkdirSync(join(ROOT, 'data'), { recursive: true });
printCheck('ok', 'data folder', join(ROOT, 'data'));

if (!process.argv.includes('--skip-install')) {
  console.log('\nInstalling dependencies...');
  const code = await runNpm(['install', '--no-audit', '--no-fund']);
  if (code !== 0) {
    console.error('\nnpm install failed. Check your network connection and run this again.');
    console.error('If it keeps failing, delete node_modules and retry: npm run setup');
    process.exit(code);
  }
}

console.log();
process.exitCode = await runDoctor();
if (process.exitCode === 0) {
  console.log(`\nSetup finished. Start the app with: ${bold('npm start')}`);
}
