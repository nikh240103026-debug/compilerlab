// @ts-check
// Bundles the server and the workspace packages it uses. Third-party dependencies stay
// external, so native modules load from node_modules.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';

const serverDir = join(ROOT, 'apps', 'server');
const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(serverDir, 'src', 'index.ts')],
  outfile: join(serverDir, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@compilerlab/')),
  logLevel: 'warning',
});

console.log('Built apps/server/dist/index.js');
