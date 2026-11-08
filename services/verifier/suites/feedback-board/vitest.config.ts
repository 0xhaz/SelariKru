import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['api/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
