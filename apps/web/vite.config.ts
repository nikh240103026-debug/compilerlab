import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import rehypeKatex from 'rehype-katex';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { defineConfig } from 'vite';

// scripts/start.mjs passes these from .env. Vite never loads the root .env itself, so the
// Gemini key cannot reach client code.
const serverPort = Number(process.env.PORT) || 4317;
const webPort = Number(process.env.WEB_PORT) || 5173;
const monacoRoot = fileURLToPath(
  new URL('../../node_modules/monaco-editor/esm/vs', import.meta.url),
);

export default defineConfig({
  plugins: [
    {
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [remarkFrontmatter, remarkGfm, remarkMath],
        // Math is rendered at build time, so KaTeX's JavaScript never reaches the browser.
        rehypePlugins: [rehypeKatex],
      }),
    },
    react({ include: /\.(mdx|tsx?)$/ }),
    tailwindcss(),
  ],
  worker: { format: 'es' },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // The vim and emacs key bindings import Monaco by paths its current package map no longer
      // offers, and by its full entry. These point them at the same copy the editor uses.
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: `${monacoRoot}/$1.js` },
      { find: /^monaco-editor$/, replacement: `${monacoRoot}/editor/editor.api.js` },
      // The package map can only name .js files, and the editor needs one stylesheet directly.
      { find: /^monaco-editor\/(.+\.css)$/, replacement: `${monacoRoot}/$1` },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // The production content security policy only allows fonts served as files.
    assetsInlineLimit: 0,
  },
});
