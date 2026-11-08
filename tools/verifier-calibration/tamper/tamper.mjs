// Hostile build/start script used ONLY by the verifier tamper check (run.ts --tamper). Runs as the unprivileged
// candidate user inside the verifier image, in `pnpm build` and `pnpm start`. It tries everything that could change what
// root executes or reads, or forge the verdict. Every write to a root-owned location must be denied. (Planting files in
// the world-writable /tmp is allowed to succeed, and is reported as PLANTED; it must have no effect on the verdict.)
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const quiet = process.argv.includes('--quiet');
const log = (m) => { if (!quiet) console.log(m); };
const attempt = (label, fn, { allowed = false } = {}) => {
  try {
    fn();
    log(allowed ? `TAMPER PLANTED ${label}` : `TAMPER WROTE ${label}`);
  } catch (e) {
    log(`TAMPER DENIED ${label}: ${e.code ?? e.message}`);
  }
};

const suite = '/verifier/services/verifier/suites/feedback-board';
const work = dirname(process.cwd()); // the runner's temp work directory (root-owned)
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';

let manifest = { criteria: [] };
try { manifest = JSON.parse(readFileSync(`${suite}/manifest.json`, 'utf8')); } catch { /* unreadable */ }
const titles = (runner) => manifest.criteria.flatMap((c) => c.tests.filter((t) => t.runner === runner).map((t) => t.title));
const fakeVitest = `import { it } from 'vitest';\n${titles('vitest').map((t) => `it(${JSON.stringify(t)}, () => {});`).join('\n')}\n`;
const fakePlaywright = `import { test } from '@playwright/test';\n${titles('playwright').map((t) => `test(${JSON.stringify(t)}, async () => {});`).join('\n')}\n`;
const allPassed = JSON.stringify({ quality: { allRequiredChecksPassed: true, criteria: manifest.criteria.map((c) => ({ id: c.id, status: 'passed' })) } });

function findFile(dir, name, depth = 0) {
  if (depth > 6) return null;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const r = findFile(p, name, depth + 1); if (r) return r; }
  }
  return null;
}

// 1. the suite, runner, manifest, hashes and tool tree that root runs
attempt('suite api test', () => writeFileSync(`${suite}/api/feedback.test.ts`, fakeVitest));
attempt('suite browser spec', () => writeFileSync(`${suite}/browser/feedback.spec.ts`, fakePlaywright));
attempt('suite harness', () => writeFileSync(`${suite}/lib/harness.ts`, 'export {};\n'));
attempt('suite manifest', () => writeFileSync(`${suite}/manifest.json`, JSON.stringify(manifest)));
attempt('suite hashes', () => writeFileSync(`${suite}/HASHES.json`, '{}'));
attempt('suite playwright config', () => writeFileSync(`${suite}/playwright.config.ts`, 'export default {};\n'));
attempt('runner', () => writeFileSync('/verifier/services/verifier/src/run.ts', 'process.exit(0);\n'));
attempt('new file in suite dir', () => writeFileSync(`${suite}/api/extra.test.ts`, fakeVitest));
attempt('verifier node_modules', () => writeFileSync('/verifier/node_modules/.pnpm/planted.js', 'x'));
attempt('playwright package', () => writeFileSync('/verifier/services/verifier/node_modules/@playwright/test/planted.js', 'x'));
// 2. things root executes
const shell = findFile(browsers, 'chrome-headless-shell');
attempt(`browser binary ${shell}`, () => writeFileSync(shell, '#!/bin/sh\ntouch /verifier-out/pwned\n'));
attempt('browser binary (replace via rename)', () => renameSync(shell, `${shell}.orig`));
attempt('new file in browsers dir', () => writeFileSync(join(browsers, 'planted'), 'x'));
attempt('browsers dir mode', () => chmodSync(browsers, 0o777));
attempt('node binary', () => writeFileSync('/usr/local/bin/node', '#!/bin/sh\n'));
attempt('pnpm', () => writeFileSync('/usr/local/lib/node_modules/pnpm/planted.js', 'x'));
// 3. temp and cache locations used by root's suite processes
attempt('root private tmp', () => writeFileSync('/verifier-tmp/planted', 'x'));
attempt('root playwright transform cache', () => { mkdirSync('/verifier-tmp/pw-cache', { recursive: true }); writeFileSync('/verifier-tmp/pw-cache/planted', 'x'); });
attempt('predictable /tmp transform cache', () => { mkdirSync('/tmp/playwright-transform-cache-0', { recursive: true }); writeFileSync('/tmp/playwright-transform-cache-0/planted', 'x'); }, { allowed: true });
attempt('predictable /tmp tsx cache', () => { mkdirSync('/tmp/tsx-0', { recursive: true }); writeFileSync('/tmp/tsx-0/planted', 'x'); }, { allowed: true });
// 4. reports, run directories and the results channel
attempt('reports vitest', () => writeFileSync(join(work, 'reports/vitest.json'), '{"testResults":[]}'));
attempt('reports playwright', () => writeFileSync(join(work, 'reports/playwright.json'), '{"suites":[]}'));
attempt('reports dir rename', () => renameSync(join(work, 'reports'), join(work, 'reports.moved')));
attempt('runs dir new entry', () => writeFileSync(join(work, 'runs/planted'), 'x'));
attempt('runs dir symlink', () => symlinkSync('/verifier-out/pwned', join(work, 'runs/case-evil')));
attempt('results file', () => writeFileSync('/verifier-out/result.json', allPassed));
attempt('results dir listing', () => readdirSync('/verifier-out'));

// 5. symlink race: a daemon that outlives the app and keeps trying to swap per-case directories for symlinks
const raceSource = `
const fs = require('node:fs'); const path = require('node:path');
const runs = process.argv[1]; const end = Date.now() + 120000;
while (Date.now() < end) {
  try { for (const n of fs.readdirSync(runs)) { if (!n.startsWith('case-')) continue;
    try { fs.renameSync(path.join(runs, n), path.join(runs, n + '.moved')); } catch {}
    try { fs.symlinkSync('/verifier-out', path.join(runs, n)); } catch {} } } catch {}
  try { fs.writeFileSync('/verifier-out/result.json', ${JSON.stringify(allPassed)}); } catch {}
  try { fs.writeFileSync('/verifier-tmp/pw-cache/x', 'x'); } catch {}
}`;
const runsDir = process.env.FEEDBACK_DB_PATH ? dirname(dirname(process.env.FEEDBACK_DB_PATH)) : join(work, 'runs');
spawn(process.execPath, ['-e', raceSource, runsDir], { detached: true, stdio: 'ignore' }).unref();
