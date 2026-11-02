// @ts-check
// Exits non-zero only when the app cannot run. Missing lab tools and a missing Gemini key
// are warnings, because the app has fallbacks for both.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkGemini, checkNode, checkTools, toolFix } from './checks.mjs';
import { dependenciesInstalled, ensureEnvFile, readEnv, ROOT } from './env.mjs';
import { bold, dim, printCheck, printFix } from './report.mjs';

/** @returns {{ state: 'ok' | 'warn' | 'fail', detail: string, fix: string[] }} */
function checkDatabase() {
  if (!dependenciesInstalled()) {
    return {
      state: 'fail',
      detail: 'Dependencies are not fully installed.',
      fix: ['Run: npm run setup'],
    };
  }
  try {
    const Database = createRequire(join(ROOT, 'apps', 'server', 'package.json'))('better-sqlite3');
    new Database(':memory:').close();
    return { state: 'ok', detail: 'better-sqlite3 loaded', fix: [] };
  } catch {
    if (process.getBuiltinModule?.('node:sqlite')) {
      return {
        state: 'warn',
        detail: "better-sqlite3 could not load, so the app will use Node's built-in node:sqlite.",
        fix: ['To restore it, delete node_modules and run: npm run setup'],
      };
    }
    return {
      state: 'fail',
      detail: 'No SQLite driver could load.',
      fix: ['Switch to Node 22 LTS, delete node_modules and run: npm run setup'],
    };
  }
}

/** @returns {Promise<number>} the process exit code */
export async function runDoctor() {
  const envFile = ensureEnvFile();
  const env = readEnv();
  let failed = false;

  console.log(bold('CompilerLab doctor'));
  console.log(dim(`Platform: ${process.platform} ${process.arch}`));
  if (envFile.created) console.log(dim('Created .env from .env.example'));
  console.log();

  const node = checkNode();
  printCheck(node.state, 'Node', node.detail);
  printFix(node.fix);
  failed ||= node.state === 'fail';

  const database = checkDatabase();
  printCheck(database.state, 'SQLite', database.detail);
  printFix(database.fix);
  failed ||= database.state === 'fail';

  const tools = await checkTools();
  for (const tool of tools) {
    printCheck(tool.state, tool.label, tool.version ?? 'not found');
  }
  const missing = tools.filter((tool) => tool.state !== 'ok').map((tool) => tool.label);
  if (missing.length > 0) {
    console.log(`       To run real tools in the lab, install ${missing.join(', ')}:`);
    printFix(toolFix(missing, process.platform));
    console.log('       Until then the lab labels its results "Simulated".');
  }

  const gemini = checkGemini(env);
  printCheck(gemini.state, 'Gemini key', gemini.detail);
  printFix(gemini.fix);

  console.log();
  console.log(
    failed ? 'Fix the FAIL items above, then run this again.' : 'CompilerLab is ready to run.',
  );
  return failed ? 1 : 0;
}
