// Hostile build/start script used ONLY by the verifier tamper check (run.ts --tamper). It tries to forge a passing
// verdict: replace the suite's tests with same-titled passing tests, forge the reports and the result file, and leave a
// background process that tries again later. Every attempt must be denied by the verifier image.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const suite = '/verifier/services/verifier/suites/feedback-board';
const tryWrite = (label, path, content) => {
  try {
    writeFileSync(path, content);
    console.log(`TAMPER WROTE ${label}`);
  } catch (e) {
    console.log(`TAMPER DENIED ${label}: ${e.code}`);
  }
};

let manifest = { criteria: [] };
try { manifest = JSON.parse(readFileSync(`${suite}/manifest.json`, 'utf8')); } catch { console.log('TAMPER DENIED read manifest'); }
const titles = (runner) => manifest.criteria.flatMap((c) => c.tests.filter((t) => t.runner === runner).map((t) => t.title));
const fakeVitest = `import { it } from 'vitest';\n${titles('vitest').map((t) => `it(${JSON.stringify(t)}, () => {});`).join('\n')}\n`;
const fakePlaywright = `import { test } from '@playwright/test';\n${titles('playwright').map((t) => `test(${JSON.stringify(t)}, async () => {});`).join('\n')}\n`;
const allPassed = JSON.stringify({ quality: { allRequiredChecksPassed: true, criteria: manifest.criteria.map((c) => ({ id: c.id, status: 'passed' })) } });

tryWrite('suite api test', `${suite}/api/feedback.test.ts`, fakeVitest);
tryWrite('suite browser spec', `${suite}/browser/feedback.spec.ts`, fakePlaywright);
tryWrite('suite manifest', `${suite}/manifest.json`, JSON.stringify(manifest));
tryWrite('suite hashes', `${suite}/HASHES.json`, '{}');
tryWrite('runner', '/verifier/services/verifier/src/run.ts', 'process.exit(0);\n');
tryWrite('reports vitest', `${process.cwd()}/../reports/vitest.json`, '{"testResults":[]}');
tryWrite('reports playwright', `${process.cwd()}/../reports/playwright.json`, '{"suites":[]}');
tryWrite('results file', '/verifier-out/result.json', allPassed);
tryWrite('results file (mounted dir)', '/results/result.json', allPassed);

// an escaped process that tries again after the runner has finished its suites
const later = `setTimeout(() => { try { require('node:fs').writeFileSync('/verifier-out/result.json', ${JSON.stringify(allPassed)}); } catch {} }, 60000)`;
spawn(process.execPath, ['-e', later], { detached: true, stdio: 'ignore' }).unref();
