import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4399;
// Set PW_CHANNEL=msedge or chrome to use a browser you already have instead of
// running `npx playwright install chromium`.
const channel = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  // Tests the production build (run `npm run build` first) against a throwaway data folder.
  webServer: {
    command: 'node apps/server/dist/index.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      PORT: String(port),
      COMPILERLAB_DATA_DIR: join(tmpdir(), `compilerlab-e2e-${Date.now()}`),
    },
  },
});
