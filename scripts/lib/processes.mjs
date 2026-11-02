// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Kills a process and everything it started.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    // Children are spawned detached, so the negative pid addresses their process group.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Waits until a URL answers, or rejects after the timeout.
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Opens the default browser. A failure here is never fatal, because the URL is printed too.
 * @param {string} url
 */
export function openBrowser(url) {
  /** @type {[string, string[]]} */
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is already on screen.
  }
}

/** @param {string[]} argv */
export function shouldOpenBrowser(argv = process.argv) {
  return !argv.includes('--no-open') && !process.env.CI && !process.env.COMPILERLAB_NO_OPEN;
}
