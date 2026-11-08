// Regenerates suites/feedback-board/manifest.json from the test titles:  pnpm --filter @selarikru/verifier manifest
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = resolve(dirname(fileURLToPath(import.meta.url)), '../suites/feedback-board');
const files: Array<[string, 'vitest' | 'playwright']> = [['api/feedback.test.ts', 'vitest'], ['browser/feedback.spec.ts', 'playwright']];
const byId: Record<string, Array<{ runner: string; file: string; title: string }>> = {};
for (const [file, runner] of files) {
  for (const m of readFileSync(join(suite, file), 'utf8').matchAll(/^\s*(?:it|test)\('((?:[^'\\]|\\.)*)'/gm)) {
    const title = m[1]!.replace(/\\'/g, "'");
    (byId[title.slice(0, 5)] ??= []).push({ runner, file, title });
  }
}
const ids = Object.keys(byId).sort();
if (ids.length !== 8) throw new Error(`expected FB-01..FB-08, found ${ids.join(',')}`);
const manifest = {
  suiteId: 'feedback-board',
  version: '0.1',
  specification: 'docs/demo-project.md section 3',
  fixtures: 'fixtures/feedback-fixtures.json',
  tools: { node: '24.x', pnpm: '9.12.2', vitest: '5.1.0', '@playwright/test': '1.65.0', playwrightImage: 'mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d', browser: 'chromium' },
  criteria: ids.map((id) => ({ id, tests: byId[id] })),
};
writeFileSync(join(suite, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(ids.map((i) => `${i}: ${byId[i]!.length} tests`).join('\n'));
