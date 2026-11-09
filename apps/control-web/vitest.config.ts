import { defineConfig } from 'vitest/config';

// Pure view logic only; browser behaviour is covered by the Playwright specs in tests/.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
