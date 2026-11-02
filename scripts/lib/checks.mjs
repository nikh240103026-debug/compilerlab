// @ts-check
// The environment checks behind `npm run doctor` and the app's Settings page.
// Uses only Node built-ins so it works before `npm install`.
import { spawn } from 'node:child_process';

export const SUPPORTED_NODE_MAJOR = 22;

/** @typedef {'ok' | 'warn' | 'fail'} CheckState */
/** @typedef {{ state: CheckState, detail: string, fix: string[] }} CheckResult */
/** @typedef {'flex' | 'bison' | 'gcc' | 'gpp' | 'make'} ToolId */
/** @typedef {{ id: ToolId, label: string, command: string }} Tool */
/** @typedef {(command: string, args: string[]) => Promise<string | null>} Probe */

/** @type {readonly Tool[]} */
export const TOOLS = [
  { id: 'flex', label: 'flex', command: 'flex' },
  { id: 'bison', label: 'bison', command: 'bison' },
  { id: 'gcc', label: 'gcc', command: 'gcc' },
  { id: 'gpp', label: 'g++', command: 'g++' },
  { id: 'make', label: 'make', command: 'make' },
];

/**
 * Exact commands that switch to the supported Node version.
 * @param {string} platform
 * @returns {string[]}
 */
export function nodeFix(platform) {
  if (platform === 'win32') {
    return [
      'winget install --id CoreyButler.NVMforWindows -e',
      `nvm install ${SUPPORTED_NODE_MAJOR}`,
      `nvm use ${SUPPORTED_NODE_MAJOR}`,
      'Then open a new terminal and run: npm run setup',
    ];
  }
  return [
    'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash',
    'nvm install   # reads .nvmrc in this folder',
    'nvm use',
    'Then run: npm run setup',
  ];
}

/**
 * Exact commands that install the given tools on this OS.
 * @param {readonly string[]} labels tool labels as shown to the user, such as "g++"
 * @param {string} platform
 * @returns {string[]}
 */
export function toolFix(labels, platform) {
  if (labels.length === 0) return [];
  const missing = new Set(labels);
  if (platform === 'win32') {
    const msys = [];
    if (missing.has('flex')) msys.push('flex');
    if (missing.has('bison')) msys.push('bison');
    if (missing.has('make')) msys.push('make');
    if (missing.has('gcc') || missing.has('g++')) msys.push('mingw-w64-ucrt-x86_64-gcc');
    return [
      'Option A, MSYS2 (runs from Windows):',
      '  winget install --id MSYS2.MSYS2 -e',
      `  In the "MSYS2 UCRT64" terminal: pacman -S --needed ${msys.join(' ')}`,
      '  Add C:\\msys64\\ucrt64\\bin and C:\\msys64\\usr\\bin to PATH, or set the tool paths in Settings.',
      'Option B, WSL2 (run all of CompilerLab inside Ubuntu):',
      '  wsl --install -d Ubuntu',
      `  In Ubuntu: sudo apt update && sudo apt install -y ${labels.join(' ')}`,
      '  Then clone this project inside WSL and run npm run setup there.',
    ];
  }
  if (platform === 'darwin') {
    const steps = [];
    if (missing.has('gcc') || missing.has('g++') || missing.has('make')) {
      steps.push('xcode-select --install   # provides gcc, g++ and make');
    }
    const brew = labels.filter((label) => label === 'flex' || label === 'bison');
    if (brew.length > 0) {
      steps.push(`brew install ${brew.join(' ')}`);
      steps.push(
        `Homebrew does not link them by default, so add to ~/.zshrc: export PATH="${brew
          .map((tool) => `$(brew --prefix)/opt/${tool}/bin`)
          .join(':')}:$PATH"`,
      );
    }
    return steps;
  }
  return [`sudo apt update && sudo apt install -y ${labels.join(' ')}`];
}

/**
 * @param {string} [version]
 * @param {string} [platform]
 * @returns {CheckResult}
 */
export function checkNode(version = process.version, platform = process.platform) {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  if (major === SUPPORTED_NODE_MAJOR) {
    return { state: 'ok', detail: `Node ${version}`, fix: [] };
  }
  if (major > SUPPORTED_NODE_MAJOR) {
    return {
      state: 'warn',
      detail: `Node ${version} is newer than the pinned Node ${SUPPORTED_NODE_MAJOR} LTS. It should work, but only ${SUPPORTED_NODE_MAJOR} is supported.`,
      fix: nodeFix(platform),
    };
  }
  return {
    state: 'fail',
    detail: `Node ${version} is too old. CompilerLab needs Node ${SUPPORTED_NODE_MAJOR} LTS.`,
    fix: nodeFix(platform),
  };
}

/**
 * Runs a command and returns the first line of its output, or null when it cannot run.
 * Uses an argument array and never a shell.
 * @type {Probe}
 */
export function probe(command, args) {
  return new Promise((resolve) => {
    let output = '';
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) resolve(null);
      else
        resolve(
          output
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim() ?? '',
        );
    });
  });
}

/**
 * @param {Tool} tool
 * @param {{ override?: string, run?: Probe }} [options]
 * @returns {Promise<{ id: ToolId, label: string, state: CheckState, version: string | null, command: string }>}
 */
export async function checkTool(tool, { override = '', run = probe } = {}) {
  const command = override.trim() || tool.command;
  const version = await run(command, ['--version']);
  return {
    id: tool.id,
    label: tool.label,
    state: version === null ? 'warn' : 'ok',
    version,
    command,
  };
}

/**
 * Reports only whether a key exists. The value is never returned or printed.
 * @param {Record<string, string | undefined>} env
 * @returns {CheckResult & { configured: boolean }}
 */
export function checkGemini(env) {
  const configured = Boolean(env.GEMINI_API_KEY?.trim());
  if (configured) {
    return { state: 'ok', configured, detail: 'GEMINI_API_KEY is set', fix: [] };
  }
  return {
    state: 'warn',
    configured,
    detail: 'GEMINI_API_KEY is not set. AI features will show an offline state.',
    fix: [
      'Create a key at https://aistudio.google.com/apikey',
      'Put it in .env as GEMINI_API_KEY=your-key, then restart the app.',
    ],
  };
}

/**
 * @param {{ override?: Partial<Record<ToolId, string>>, run?: Probe }} [options]
 */
export function checkTools({ override = {}, run = probe } = {}) {
  return Promise.all(TOOLS.map((tool) => checkTool(tool, { override: override[tool.id], run })));
}
