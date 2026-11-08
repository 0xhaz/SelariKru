import { defineConfig } from '@playwright/test';

const reportDir = process.env.VERIFY_REPORT_DIR;
if (!reportDir) throw new Error('VERIFY_REPORT_DIR is not set');

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 7_000 },
  reporter: [['json', { outputFile: `${reportDir}/playwright.json` }]],
  outputDir: `${reportDir}/pw-artifacts`,
  use: { browserName: 'chromium', headless: true, actionTimeout: 10_000, navigationTimeout: 20_000 },
});
