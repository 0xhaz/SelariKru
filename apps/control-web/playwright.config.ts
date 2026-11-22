import { defineConfig } from '@playwright/test';
import { ORIGIN, PW_PORT } from './tests/origin.ts';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: ORIGIN, browserName: 'chromium', reducedMotion: 'reduce' },
  webServer: { command: `pnpm exec vite --port ${PW_PORT} --strictPort`, url: `${ORIGIN}/tests/harness/index.html`, reuseExistingServer: false, timeout: 60_000 },
});
