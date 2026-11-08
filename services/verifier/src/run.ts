// Protected verifier runner.
//   CANDIDATE_DIR=<dir> RESULTS_PATH=<file.json> pnpm --filter @selarikru/verifier verify
// CANDIDATE_DIR is read-only input: it is copied to a fresh temp directory before anything is installed or built,
// so the candidate cannot write into the suite or the results. Results come only from the reports that the
// suite's own Vitest and Playwright runs write into a runner-owned directory, never from candidate-authored files.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree, sha256 } from './hashing.ts';

type Status = 'passed' | 'failed' | 'skipped' | 'error';
interface ManifestTest { runner: 'vitest' | 'playwright'; file: string; title: string }
interface Manifest { suiteId: string; version: string; tools: Record<string, string>; criteria: Array<{ id: string; tests: ManifestTest[] }> }
interface Observed { status: Status; message?: string }

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const suiteDir = join(pkgRoot, 'suites/feedback-board');
const ANSI = /\u001b\[[0-9;]*m/g;
const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}...[truncated]` : s);

function sh(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; output: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (b: Buffer) => { out = (out + b.toString()).slice(-8000); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += `\n[verifier] timed out after ${opts.timeoutMs / 1000}s`;
      try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ }
    }, opts.timeoutMs);
    p.once('error', (e) => { clearTimeout(timer); res({ code: -1, output: String(e) }); });
    p.once('close', (code) => { clearTimeout(timer); try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* none left */ } res({ code, output: out.replace(ANSI, '') }); });
  });
}

function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function vitestResults(report: any): Map<string, Observed> {
  const m = new Map<string, Observed>();
  for (const file of report?.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const status: Status = t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped';
      m.set(t.title, { status, ...(status === 'failed' ? { message: clip((t.failureMessages ?? []).join('\n').replace(ANSI, '')) } : {}) });
    }
  }
  return m;
}

function playwrightResults(report: any): Map<string, Observed> {
  const m = new Map<string, Observed>();
  const walk = (suite: any) => {
    for (const spec of suite.specs ?? []) {
      const test = spec.tests?.[0];
      const last = test?.results?.[test.results.length - 1];
      const status: Status = test?.status === 'skipped' || !last ? 'skipped' : spec.ok ? 'passed' : 'failed';
      const msg = last?.error?.message ?? (last?.errors ?? []).map((e: any) => e.message).join('\n');
      m.set(spec.title, { status, ...(status === 'failed' ? { message: clip(String(msg ?? '').replace(ANSI, '')) } : {}) });
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return m;
}

function pkgVersion(name: string): string | null {
  return readJson(join(pkgRoot, 'node_modules', name, 'package.json'))?.version ?? null;
}

function copyCandidate(src: string, dest: string) {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      if (['node_modules', 'dist', '.git', '.DS_Store'].includes(name)) return false;
      if (/\.sqlite(-wal|-shm)?$/.test(name)) return false;
      return !lstatSync(path).isSymbolicLink(); // never follow or copy links out of the candidate
    },
  });
}

async function main() {
  const candidateDir = resolve(process.env.CANDIDATE_DIR ?? process.argv[2] ?? '');
  const resultsArg = process.env.RESULTS_PATH ?? process.argv[3];
  if (!process.env.CANDIDATE_DIR && !process.argv[2]) throw new Error('CANDIDATE_DIR is required');
  if (!resultsArg) throw new Error('RESULTS_PATH is required');
  const resultsPath = resolve(resultsArg);
  if (!existsSync(join(candidateDir, 'package.json'))) throw new Error(`CANDIDATE_DIR has no package.json: ${candidateDir}`);

  const manifestRaw = readFileSync(join(suiteDir, 'manifest.json'));
  const manifest: Manifest = JSON.parse(manifestRaw.toString());
  const work = mkdtempSync(join(tmpdir(), 'selarikru-verify-'));
  const cand = join(work, 'candidate');
  const reports = join(work, 'reports');
  const runs = join(work, 'runs');
  mkdirSync(reports);
  mkdirSync(runs);
  copyCandidate(candidateDir, cand);
  const candidateTreeSha256 = hashTree(cand);

  const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', LANG: 'C.UTF-8', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
  const started = new Date();
  const setup: Record<string, { ok: boolean; detail?: string }> = {};
  const observed = { vitest: new Map<string, Observed>(), playwright: new Map<string, Observed>() };
  let setupFailure: string | null = null;

  const install = await sh('pnpm', ['install', '--frozen-lockfile'], { cwd: cand, env: baseEnv, timeoutMs: 600_000 });
  setup.install = { ok: install.code === 0, ...(install.code === 0 ? {} : { detail: clip(install.output) }) };
  if (install.code !== 0) setupFailure = `pnpm install --frozen-lockfile failed (exit ${install.code}): ${clip(install.output, 1500)}`;
  if (!setupFailure) {
    const build = await sh('pnpm', ['build'], { cwd: cand, env: baseEnv, timeoutMs: 600_000 });
    setup.build = { ok: build.code === 0, ...(build.code === 0 ? {} : { detail: clip(build.output) }) };
    if (build.code !== 0) setupFailure = `pnpm build failed (exit ${build.code}): ${clip(build.output, 1500)}`;
  }

  if (!setupFailure) {
    const env: NodeJS.ProcessEnv = { ...baseEnv, VERIFY_APP_DIR: cand, VERIFY_RUN_DIR: runs, VERIFY_REPORT_DIR: reports };
    const v = await sh('pnpm', ['exec', 'vitest', 'run', '--config', join(suiteDir, 'vitest.config.ts'), '--reporter=json', `--outputFile=${join(reports, 'vitest.json')}`], { cwd: pkgRoot, env, timeoutMs: 1_200_000 });
    setup.apiSuite = { ok: v.code === 0, detail: clip(v.output, 500) };
    observed.vitest = vitestResults(readJson(join(reports, 'vitest.json')));
    const p = await sh('pnpm', ['exec', 'playwright', 'test', '--config', join(suiteDir, 'playwright.config.ts')], { cwd: pkgRoot, env, timeoutMs: 1_200_000 });
    setup.browserSuite = { ok: p.code === 0, detail: clip(p.output, 500) };
    observed.playwright = playwrightResults(readJson(join(reports, 'playwright.json')));
  }

  const criteria = manifest.criteria.map((c) => {
    const tests = c.tests.map((t) => {
      const o: Observed = setupFailure
        ? { status: 'failed', message: setupFailure }
        : (observed[t.runner].get(t.title) ?? { status: 'error', message: `no ${t.runner} result for this test (verifier did not produce a report entry)` });
      return { runner: t.runner, title: t.title, status: o.status, ...(o.message ? { message: o.message } : {}) };
    });
    const has = (s: Status) => tests.some((t) => t.status === s);
    const status: Status = has('failed') ? 'failed' : has('error') ? 'error' : has('skipped') ? 'skipped' : 'passed';
    return {
      id: c.id,
      status,
      evidenceReferences: c.tests.map((t) => `${manifest.suiteId}/${t.file}#${t.title}`),
      failures: tests.filter((t) => t.status !== 'passed').map((t) => ({ test: t.title, status: t.status, message: t.message ?? '' })),
      tests: tests.map(({ runner, title, status: s }) => ({ runner, title, status: s })),
    };
  });

  const allPassed = criteria.length === 8 && criteria.every((c) => c.status === 'passed');
  const hashes = readJson(join(suiteDir, 'HASHES.json'));
  const result = {
    protocolVersion: '0.1',
    verifier: {
      suiteId: manifest.suiteId,
      suiteVersion: manifest.version,
      manifestSha256: sha256(manifestRaw),
      verifierSha: hashTree(suiteDir, { exclude: (p) => p === 'HASHES.json' }),
      recordedHashes: hashes,
      image: process.env.VERIFY_IMAGE ?? null,
      tools: { node: process.version, vitest: pkgVersion('vitest'), playwright: pkgVersion('@playwright/test') },
    },
    candidate: { treeSha256: candidateTreeSha256 },
    startedAtUtc: started.toISOString(),
    endedAtUtc: new Date().toISOString(),
    setup,
    quality: { allRequiredChecksPassed: allPassed, criteria },
  };

  mkdirSync(dirname(resultsPath), { recursive: true });
  const tmp = `${resultsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, resultsPath);
  if (process.env.VERIFY_KEEP !== '1') rmSync(work, { recursive: true, force: true });
  console.log(criteria.map((c) => `${c.id} ${c.status}`).join('\n'));
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(`verifier runner error: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
