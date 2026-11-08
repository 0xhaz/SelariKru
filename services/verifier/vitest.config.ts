import { defineConfig } from 'vitest/config';

// Unit tests of the runner-side code in src/. The acceptance suite under suites/ has its own config and is run by the verifier itself.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
