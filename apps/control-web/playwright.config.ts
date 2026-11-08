import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', browserName: 'chromium', reducedMotion: 'reduce' },
  webServer: { command: 'pnpm exec vite --port 5174 --strictPort', url: 'http://127.0.0.1:5174/tests/harness/index.html', reuseExistingServer: false, timeout: 60_000 },
});
