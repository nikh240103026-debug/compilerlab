// @ts-check
// Bundles the server and the workspace packages it uses. Third-party dependencies stay
// external, so native modules load from node_modules.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';

const serverDir = join(ROOT, 'apps', 'server');
const dependenciesOf = (/** @type {string} */ dir) =>
  Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {});

// The workspace packages get bundled, but what they depend on must stay external too. Some of
// those are CommonJS, which cannot be inlined into an ES module bundle.
const external = [serverDir, join(ROOT, 'packages', 'content'), join(ROOT, 'packages', 'shared')]
  .flatMap(dependenciesOf)
  .filter((name) => !name.startsWith('@compilerlab/'));

await build({
  entryPoints: [join(serverDir, 'src', 'index.ts')],
  outfile: join(serverDir, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  logLevel: 'warning',
});

console.log('Built apps/server/dist/index.js');
