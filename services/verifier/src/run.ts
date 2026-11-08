// Protected verifier runner.
//   CANDIDATE_DIR=<dir> RESULTS_PATH=<file.json> pnpm --filter @selarikru/verifier verify
// CANDIDATE_DIR is read-only input: it is copied to a fresh temp directory before anything is installed or built,
// so the candidate cannot write into the suite or the results. Results come only from the reports that the
// suite's own Vitest and Playwright runs write into a runner-owned directory, never from candidate-authored files.
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, realpathSync, statSync, type Stats, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killCandidateProcesses as stopAll } from '../suites/feedback-board/lib/killcand.ts';
import { HASH_KEYS, hashTree, verifierHashes } from './hashing.ts';

type Status = 'passed' | 'failed' | 'skipped' | 'error';
interface ManifestTest { runner: 'vitest' | 'playwright'; file: string; title: string }
interface Manifest { suiteId: string; version: string; tools: Record<string, string>; criteria: Array<{ id: string; tests: ManifestTest[] }> }
interface Observed { status: Status; message?: string }

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const suiteDir = join(pkgRoot, 'suites/feedback-board');
const repoRoot = resolve(pkgRoot, '../..');
/** In the image, candidate code runs as an unprivileged user that cannot write the verifier tree or the reports. */
const CAND = process.env.VERIFY_CAND_UID ? { uid: Number(process.env.VERIFY_CAND_UID), gid: Number(process.env.VERIFY_CAND_GID ?? process.env.VERIFY_CAND_UID), home: process.env.VERIFY_CAND_HOME ?? '/home/cand' } : null;
let fatal: string | null = null;
/** Atomic, verified kill of every candidate process; if any survive, no verdict is produced (fail closed). */
const killCandidateProcesses = () => {
  if (!CAND) return;
  try { stopAll(CAND.uid, CAND.gid); } catch (e) { fatal ??= `candidate processes could not be stopped: ${(e as Error).message}`; }
};
function chownTree(path: string) {
  if (!CAND) return;
  chownSync(path, CAND.uid, CAND.gid);
  if (lstatSync(path).isDirectory()) for (const n of readdirSync(path)) chownTree(join(path, n));
}
const ANSI = /\u001b\[[0-9;]*m/g;
const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}...[truncated]` : s);

function sh(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; asCandidate?: boolean }): Promise<{ code: number | null; output: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.asCandidate && CAND ? { uid: CAND.uid, gid: CAND.gid } : {}) });
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

/**
 * Fail-closed check that the candidate uid cannot write anything root will execute or load: browsers, node, the verifier
 * tree and its node_modules, PATH directories, root's private temp and cache directories, and (for replacement by
 * rename) every ancestor directory. Sticky directories (/tmp) protect root-owned entries, so they are accepted as parents.
 */
function preflight(): string | null {
  if (!CAND) return null;
  const bad: string[] = [];
  const canWrite = (st: Stats) => (st.uid === CAND.uid ? !!(st.mode & 0o200) : st.gid === CAND.gid ? !!(st.mode & 0o020) : !!(st.mode & 0o002));
  const seen = new Set<string>();
  const check = (p: string, recurse: boolean) => {
    let real: string;
    try { real = realpathSync(p); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    const st = lstatSync(real);
    if (canWrite(st) || st.uid === CAND.uid) { bad.push(real); if (bad.length > 20) return; }
    if (st.isDirectory() && recurse) {
      for (const n of readdirSync(real)) {
        const child = join(real, n);
        const cst = lstatSync(child);
        if (cst.isSymbolicLink()) check(child, recurse); // follow once; realpath dedupes
        else check(child, recurse);
      }
    }
  };
  const ancestors = (p: string) => {
    for (let d = dirname(realpathSync(p)); ; d = dirname(d)) {
      const st = statSync(d);
      if ((canWrite(st) || st.uid === CAND.uid) && !(st.mode & 0o1000)) bad.push(`${d} (ancestor of ${p})`);
      if (d === '/') break;
    }
  };
  const trees = [
    process.env.PLAYWRIGHT_BROWSERS_PATH, pkgRoot, join(repoRoot, 'node_modules'), join(repoRoot, 'package.json'),
    '/usr/local/lib/node_modules', process.execPath, process.env.TMPDIR, process.env.PWTEST_CACHE_DIR, process.env.HOME, '/verifier-out',
  ].filter((x): x is string => !!x && existsSync(x));
  for (const t of trees) { check(t, true); ancestors(t); }
  for (const d of (process.env.PATH ?? '').split(':').filter((x) => existsSync(x))) { check(d, false); for (const n of readdirSync(d)) check(join(d, n), false); }
  return bad.length ? `isolation preflight failed: the candidate uid could write ${bad.slice(0, 20).join(', ')}` : null;
}

function integrity(): string | null {
  const recorded = readJson(join(suiteDir, 'HASHES.json'));
  if (!recorded) return 'HASHES.json is missing or unreadable';
  const actual = verifierHashes(pkgRoot, repoRoot);
  const bad = HASH_KEYS.filter((k) => recorded[k] !== actual[k]);
  return bad.length ? `verifier integrity check failed (changed: ${bad.join(', ')}); refusing to produce a verdict` : null;
}

async function main() {
  const candidateDir = resolve(process.env.CANDIDATE_DIR ?? process.argv[2] ?? '');
  const resultsArg = process.env.RESULTS_PATH ?? process.argv[3];
  if (!process.env.CANDIDATE_DIR && !process.argv[2]) throw new Error('CANDIDATE_DIR is required');
  if (!resultsArg) throw new Error('RESULTS_PATH is required');
  const resultsPath = resolve(resultsArg);
  if (!existsSync(join(candidateDir, 'package.json'))) throw new Error(`CANDIDATE_DIR has no package.json: ${candidateDir}`);
  if (CAND && process.getuid?.() !== 0) throw new Error('isolation requires the runner to start as root');

  const manifestRaw = readFileSync(join(suiteDir, 'manifest.json'));
  const manifest: Manifest = JSON.parse(manifestRaw.toString());
  const work = mkdtempSync(join(CAND ? '/tmp' : tmpdir(), 'selarikru-verify-')); // /tmp is sticky: the candidate cannot replace this root-owned directory
  chmodSync(work, 0o755);
  const cand = join(work, 'candidate');
  const reports = join(work, 'reports'); // root-owned: the candidate user can read but never write it
  const runs = join(work, 'runs');
  mkdirSync(reports, { mode: 0o755 });
  mkdirSync(runs);
  copyCandidate(candidateDir, cand);
  const candidateTreeSha256 = hashTree(cand);
  chownTree(cand);
  if (CAND) mkdirSync(CAND.home, { recursive: true }); // `runs` stays root-owned: per-case directories are handed over one by one

  const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: CAND ? '/tmp' : process.env.TMPDIR, HOME: CAND?.home ?? process.env.HOME, CI: 'true', LANG: 'C.UTF-8', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
  const started = new Date();
  const setup: Record<string, { ok: boolean; detail?: string }> = {};
  const observed = { vitest: new Map<string, Observed>(), playwright: new Map<string, Observed>() };
  let setupFailure: string | null = preflight() ?? integrity();
  const showSetup = process.env.VERIFY_SHOW_SETUP === '1';

  if (!setupFailure) {
    const install = await sh('pnpm', ['install', '--frozen-lockfile'], { cwd: cand, env: baseEnv, timeoutMs: 600_000, asCandidate: true });
    setup.install = { ok: install.code === 0, ...(install.code === 0 && !showSetup ? {} : { detail: clip(install.output) }) };
    if (install.code !== 0) setupFailure = `pnpm install --frozen-lockfile failed (exit ${install.code}): ${clip(install.output, 1500)}`;
  }
  if (!setupFailure) {
    const build = await sh('pnpm', ['build'], { cwd: cand, env: baseEnv, timeoutMs: 600_000, asCandidate: true });
    setup.build = { ok: build.code === 0, ...(build.code === 0 && !showSetup ? {} : { detail: clip(build.output) }) };
    if (build.code !== 0) setupFailure = `pnpm build failed (exit ${build.code}): ${clip(build.output, 1500)}`;
  }
  killCandidateProcesses();
  // the candidate's install/build ran first; check again that nothing the verdict depends on changed
  let tampered: string | null = null;
  if (!setupFailure) {
    tampered = preflight() ?? integrity();
    if (tampered) setupFailure = tampered;
  }

  if (!setupFailure) {
    const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PWTEST_CACHE_DIR: process.env.PWTEST_CACHE_DIR, VERIFY_APP_DIR: cand, VERIFY_RUN_DIR: runs, VERIFY_REPORT_DIR: reports, ...(CAND ? { VERIFY_CAND_UID: String(CAND.uid), VERIFY_CAND_GID: String(CAND.gid), VERIFY_CAND_HOME: CAND.home } : {}) };
    const v = await sh('pnpm', ['exec', 'vitest', 'run', '--config', join(suiteDir, 'vitest.config.ts'), '--reporter=json', `--outputFile=${join(reports, 'vitest.json')}`], { cwd: pkgRoot, env, timeoutMs: 1_200_000 });
    setup.apiSuite = { ok: v.code === 0, detail: clip(v.output, 500) };
    killCandidateProcesses();
    observed.vitest = vitestResults(readJson(join(reports, 'vitest.json')));
    const p = await sh('pnpm', ['exec', 'playwright', 'test', '--config', join(suiteDir, 'playwright.config.ts')], { cwd: pkgRoot, env, timeoutMs: 1_200_000 });
    setup.browserSuite = { ok: p.code === 0, detail: clip(p.output, 500) };
    killCandidateProcesses();
    observed.playwright = playwrightResults(readJson(join(reports, 'playwright.json')));
  }

  killCandidateProcesses();
  const fatalFile = join(reports, 'fatal.txt');
  const harnessFatal = existsSync(fatalFile) ? `harness: ${readFileSync(fatalFile, 'utf8')}` : null;
  const errorMsg = fatal ?? harnessFatal ?? preflight() ?? integrity(); // verifier-side problems: never a candidate verdict
  const failure = errorMsg ?? setupFailure;
  const failStatus: Status = errorMsg ? 'error' : 'failed';

  const criteria = manifest.criteria.map((c) => {
    const tests = c.tests.map((t) => {
      const o: Observed = failure
        ? { status: failStatus, message: failure }
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

  const allPassed = criteria.length === 8 && criteria.every((c) => c.status === 'passed') && !failure;
  const result = {
    protocolVersion: '0.1',
    verifier: {
      suiteId: manifest.suiteId,
      suiteVersion: manifest.version,
      ...verifierHashes(pkgRoot, repoRoot),
      recordedHashes: readJson(join(suiteDir, 'HASHES.json')),
      image: process.env.VERIFY_IMAGE ?? null,
      isolation: CAND ? `candidate code runs as uid ${CAND.uid}` : 'none (local run)',
      tools: { node: process.version, vitest: pkgVersion('vitest'), playwright: pkgVersion('@playwright/test') },
    },
    candidate: { treeSha256: candidateTreeSha256 },
    startedAtUtc: started.toISOString(),
    endedAtUtc: new Date().toISOString(),
    setup,
    quality: { allRequiredChecksPassed: allPassed, criteria },
  };

  // (candidate processes were verified gone just before the verdict was computed; nothing starts them again)
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
