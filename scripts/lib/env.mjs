// @ts-check
// Scripts in this folder run before `npm install`, so they use only Node built-ins.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Parses the subset of dotenv syntax that .env.example uses.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim();
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[key] = value;
  }
  return values;
}

/**
 * True once `npm install` has finished. A failed install can leave a partial node_modules.
 * @param {string} [root]
 */
export function dependenciesInstalled(root = ROOT) {
  return ['tsx/dist/cli.mjs', 'vite/bin/vite.js'].every((file) =>
    existsSync(join(root, 'node_modules', file)),
  );
}

/**
 * Creates .env from .env.example. Never overwrites an existing .env.
 * @param {string} [root]
 * @returns {{ created: boolean, path: string }}
 */
export function ensureEnvFile(root = ROOT) {
  const path = join(root, '.env');
  if (existsSync(path)) return { created: false, path };
  copyFileSync(join(root, '.env.example'), path);
  return { created: true, path };
}

/**
 * Returns .env values overlaid with the real environment, which always wins.
 * @param {string} [root]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string | undefined>}
 */
export function readEnv(root = ROOT, env = process.env) {
  const path = join(root, '.env');
  const fromFile = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  return { ...fromFile, ...env };
}
