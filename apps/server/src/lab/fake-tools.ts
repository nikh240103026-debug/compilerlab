import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LabToolchain, LabToolId } from './toolchain';

/**
 * Stand-ins for flex and gcc, written in JavaScript, so the pipeline can be tested on any
 * machine. They copy the real tools' message formats. What "compiling" means here is that the
 * first source file, which is really JavaScript, becomes the program.
 */
const FAKE_FLEX = String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const name = process.argv[process.argv.length - 1];
const source = readFileSync(name, 'utf8');
writeFileSync('flex-args.json', JSON.stringify(process.argv.slice(2)));
if (source.includes('FLEX_ERROR')) {
  console.error('"' + name + '", line 3: unrecognized rule');
  process.exit(1);
}
if (source.includes('FLEX_WARNING')) console.error(name + ':4: warning, rule cannot be matched');
const marker = source.indexOf('%%PROGRAM');
writeFileSync('lex.yy.c', marker === -1 ? 'process.stdout.write("no program");' : source.slice(marker + 9));
`;

const FAKE_GCC = String.raw`
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync('gcc-args.json', JSON.stringify(args));
const first = args.find((arg) => /\.(c|cpp)$/.test(arg));
const source = readFileSync(first, 'utf8');
if (source.includes('COMPILE_ERROR')) {
  console.error(first + ": In function 'main':");
  console.error(first + ":2:5: error: 'x' undeclared (first use in this function)");
  console.error('    2 |     x = 1;');
  console.error('      |     ^');
  console.error(first + ':2:5: note: each undeclared identifier is reported only once');
  process.exit(1);
}
if (source.includes('COMPILE_WARNING')) {
  console.error("lex.yy.c:10:1: warning: 'yyunput' defined but not used [-Wunused-function]");
  console.error("main.c:1:1: warning: unused variable 'q' [-Wunused-variable]");
}
if (source.includes('COMPILE_FOREVER')) for (;;) {}
copyFileSync(first, 'program.js');
`;

export interface FakeTools {
  toolchain: LabToolchain;
  /** Tools to pretend are not installed. */
  missing: Set<LabToolId>;
  dispose(): Promise<void>;
}

/**
 * Removes a test's temporary folder. On Windows, a program that was just killed still holds its
 * working folder for a moment, and Node 22's rmSync gives up at once. A folder left behind in
 * the temp directory is harmless, so that alone never fails a test.
 */
export async function removeTestFolder(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function createFakeTools(): FakeTools {
  const directory = mkdtempSync(join(tmpdir(), 'compilerlab-fake-tools-'));
  writeFileSync(join(directory, 'flex.cjs'), FAKE_FLEX);
  writeFileSync(join(directory, 'gcc.cjs'), FAKE_GCC);
  const missing = new Set<LabToolId>();
  return {
    missing,
    toolchain: {
      find: async (id) =>
        missing.has(id)
          ? null
          : {
              command: process.execPath,
              prefixArgs: [join(directory, id === 'flex' ? 'flex.cjs' : 'gcc.cjs')],
            },
      program: (runDirectory) => ({
        command: process.execPath,
        prefixArgs: [join(runDirectory, 'program.js')],
      }),
      environment: () => ({
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
      }),
    },
    dispose: () => removeTestFolder(directory),
  };
}
