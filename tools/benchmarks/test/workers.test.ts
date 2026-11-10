import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefaultPolicy } from '@selarikru/policy/load';
import type { Manifest } from '../src/manifest.ts';
import { buildReport, exportResults, type RawRecord } from '../src/report.ts';
import { DRY_RUN_WORKER, IN_REPO_STARTER, dryRunHarness, fakeRuntimeFactory, scriptedVerifier, type WorkerScript } from '../src/workers/dry-run.ts';
import { starterRepoFrom } from '../src/workers/isolation.ts';
import { runWorkerCohort, type WorkerEnvironment } from '../src/workers/runner.ts';
import { NO_STARTS } from '../src/manifest.ts';
import { preflight } from '../src/preflight.ts';
import { LiveRefusedError, plannedTrials } from '../src/trials.ts';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { HASHES, REPO_ROOT, resolvedManifest, started } from './fixtures.ts';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test';

let root: string;
let starterRepo: string;
let starterSha: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-workers-')));
  const files = execFileSync('git', ['-C', IN_REPO_STARTER, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  starterRepo = join(root, 'starter');
  starterSha = starterRepoFrom(IN_REPO_STARTER, starterRepo, files);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** The resolved fixture manifest, pinned to the test starter, with one block per mode unless told otherwise. */
function manifestFor(blocks = 1, over: (m: Manifest) => void = () => {}): Manifest {
  return resolvedManifest((m) => {
    m.repository.starterSha = starterSha;
    m.workers.attemptsPerRequiredMode = blocks;
    over(m);
  });
}

function env(o: { script?: WorkerScript; fail?: string[]; timeScale?: number; onTrialStart?: WorkerEnvironment['onTrialStart'] } = {}): WorkerEnvironment & { runtimes: ReturnType<typeof fakeRuntimeFactory> } {
  const runtimes = fakeRuntimeFactory(o.script ?? DRY_RUN_WORKER, [REPO_ROOT]);
  return {
    databaseUrl: DATABASE_URL, starterRepo, workRoot: join(root, 'work'), ...dryRunHarness('2.1.0'), policy: loadDefaultPolicy(),
    verifierRunner: scriptedVerifier(o.fail), verifierHost: 'local-docker', runtime: runtimes, runtimes,
    driverIntervalMs: 25, pollMs: 25, heartbeatMs: 50, ...(o.timeScale !== undefined ? { timeScale: o.timeScale } : {}), ...(o.onTrialStart ? { onTrialStart: o.onTrialStart } : {}),
  };
}

const workers = (rs: readonly RawRecord[], mode: string) => rs.filter((r) => r.mode === mode);

describe('T8.3 worker runner', () => {
  it('an L1 dry run drives the real control API, runner and verifier with a scripted worker and needs no model', async () => {
    const manifest = manifestFor(1);
    const e = env();
    const { records } = await runWorkerCohort({ manifest, env: e, live: null });
    const l1 = workers(records, 'L1');
    expect(l1).toHaveLength(1);
    const [r] = l1;
    expect(r!.status, JSON.stringify(r!.failures)).toBe('completed');
    expect(r!.dataKind).toBe('simulated');
    expect(r!.quality.allRequiredChecksPassed).toBe(true);
    expect(r!.timings.clockDomain).toBe('server-monotonic');
    expect(r!.timings.endToEndVerifiedMs).toBeGreaterThan(0);
    expect(r!.configuration.candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r!.operations.cleanupConfirmed).toBe(true);
    expect(r!.configuration.inferenceDestination).toBe('cloud');
    expect(r!.timings.initialSetupMs).toBeGreaterThan(0);
    // C1 and H2 are recorded Not measured, never faked.
    for (const mode of ['C1', 'H2']) {
      expect(workers(records, mode)).toEqual([expect.objectContaining({ status: 'not_run', failures: [expect.objectContaining({ category: 'cloud_unavailable' })] })]);
    }
    const file = exportResults({ manifest, starts: NO_STARTS, records, generatedAtUtc: '2026-11-20T10:00:00.000Z' });
    expect(buildReport(file, manifest)).toBeTruthy();
  }, 120_000);

  it('reset leaves no prior implementation or memory', async () => {
    const manifest = manifestFor(2);
    const starts: import('../src/workers/runner.ts').TrialStartState[] = [];
    const seen: { trial: number; files: string[]; home: string[] }[] = [];
    let trial = 0;
    const script: WorkerScript = (ctx) => {
      // What the worker finds before it writes: the starter's files, and in its agent home only what this trial's other worker left.
      seen.push({ trial, files: readdirSync(ctx.cwd, { recursive: true }).map(String), home: readdirSync(ctx.home, { recursive: true }).map(String) });
      ctx.write(`${ctx.role === 'frontend' ? 'src' : 'server'}/trial-${trial}.ts`, `export const trial = ${trial};\n`);
      mkdirSync(join(ctx.home, '.claude'), { recursive: true });
      writeFileSync(join(ctx.home, '.claude', `memory-trial-${trial}-${ctx.role}.md`), 'session memory\n');
    };
    const e = env({ script, onTrialStart: (s) => { trial += 1; starts.push(s); } });
    const { records } = await runWorkerCohort({ manifest, env: e, live: null });
    const l1 = workers(records, 'L1');
    expect(l1.map((r) => r.status)).toEqual(['completed', 'completed']);
    // The first trial left an implementation (its candidate) and session memory behind it...
    expect(seen.filter((x) => x.trial === 1)).toHaveLength(2);
    // ...and the second started from none of it: the same starter commit, no other ref, a clean worktree, a new schema with no earlier rows, an empty agent home.
    expect(starts).toHaveLength(2);
    for (const s of starts) {
      expect(s.repo).toEqual({ head: starterSha, refs: ['refs/heads/main'], clean: true });
      expect(s.priorRows).toEqual({ tasks: 0, events: 0, attempts: 0, runs: 0 });
      expect(s.agentHomeEntries).toEqual([]);
    }
    expect(starts[0]!.schemaName).not.toBe(starts[1]!.schemaName);
    expect(seen.filter((x) => x.trial === 2)).toHaveLength(2);
    for (const x of seen.filter((y) => y.trial === 2)) {
      expect(x.files.filter((f) => f.includes('trial-1'))).toEqual([]);
      expect(x.home.filter((f) => f.includes('trial-1'))).toEqual([]);
    }
    // A fresh agent session: one sandbox runtime per trial, each with its own sandboxes, none left.
    expect(e.runtimes.made.map((m) => m.trialId)).toEqual(l1.map((r) => r.trialId));
    expect(new Set(e.runtimes.made.flatMap((m) => m.sbx.calls.filter((c) => c[0] === 'create').map((c) => c[c.indexOf('--name') + 1]))).size).toBe(4);
    for (const m of e.runtimes.made) expect(m.sbx.sandboxes.size).toBe(0);
    // Each trial's directory, clone and agent home are gone, and the two candidates differ.
    expect(readdirSync(join(root, 'work'))).toEqual([]);
    expect(new Set(l1.map((r) => r.configuration.candidateSha)).size).toBe(2);
  }, 120_000);

  it('the deadline stops the attempt and records a timeout', async () => {
    const manifest = manifestFor(1);
    // A worker that never finishes on its own.
    const e = env({ script: () => false, timeScale: 1 / 900 });
    const started = Date.now();
    const { records } = await runWorkerCohort({ manifest, env: e, live: null });
    const [r] = workers(records, 'L1');
    expect(r!.status).toBe('timed_out');
    expect(r!.failures.map((f) => f.category)).toContain('attempt_deadline');
    expect(r!.timings.endToEndVerifiedMs).toBeNull();
    expect(r!.operations.cleanupConfirmed).toBe(true);
    expect(r!.confounders.join(' ')).toMatch(/time-compressed/);
    // The worker was stopped and its sandbox removed; the run did not wait past the deadline and the bounded stop.
    const streams = e.runtimes.made.flatMap((m) => m.sbx.streams);
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((s) => s.isEnded)).toBe(true);
    for (const m of e.runtimes.made) expect(m.sbx.sandboxes.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('timeouts and cancellations retained', async () => {
    const manifest = manifestFor(3);
    const operator = new AbortController();
    let trial = 0;
    const script: WorkerScript = () => {
      if (trial === 1) return false; // the first trial hangs until its deadline
      if (trial === 3) { operator.abort(); return false; } // the operator cancels the third while it runs
      return undefined;
    };
    const e = env({ script, timeScale: 1 / 450, onTrialStart: () => { trial += 1; } });
    const { records } = await runWorkerCohort({ manifest, env: e, live: null, signal: operator.signal });
    const l1 = workers(records, 'L1');
    expect(l1.map((r) => r.status)).toEqual(['timed_out', 'completed', 'cancelled']);
    expect(l1[2]!.failures.map((f) => f.category)).toContain('operator_cancelled');
    // Both are kept in the export and the report, and neither is replaced when the cohort continues.
    const file = exportResults({ manifest, starts: NO_STARTS, records, generatedAtUtc: '2026-11-20T10:00:00.000Z' });
    expect(file.records.filter((r) => r.mode === 'L1').map((r) => r.status)).toEqual(['timed_out', 'completed', 'cancelled']);
    expect(plannedTrials(manifest, 'workers', records).filter((p) => p.slot.mode === 'L1')).toEqual([]);
  }, 120_000);

  it('budget exhaustion marks remaining attempts not run', async () => {
    const manifest = manifestFor(3);
    const e = env();
    // Each dry-run trial reports $0.10 of estimated spend (two workers at $0.05). A $0.15 ceiling is spent by the second.
    const first = await runWorkerCohort({ manifest, env: e, live: null, budgetUsd: 0.15 });
    const l1 = workers(first.records, 'L1');
    expect(l1.map((r) => r.status)).toEqual(['completed', 'completed', 'not_run']);
    expect(l1[2]!.failures[0]!.category).toBe('budget_exhausted');
    expect(first.spentUsd).toBeCloseTo(0.2);
    // Not run is an infrastructure outcome: with more budget the cohort continues in the same slot with the next attempt, and the export accepts it.
    const second = await runWorkerCohort({ manifest, env: e, live: null, budgetUsd: 1, spentUsd: first.spentUsd, prior: first.records });
    expect(workers(second.records, 'L1').map((r) => [r.slotId, r.slotAttempt, r.status])).toEqual([['workers/block-3/L1', 2, 'completed']]);
    expect(second.spentUsd).toBeCloseTo(0.3);
    // The cloud modes stay recorded once as unavailable; they are not re-recorded.
    expect(workers(second.records, 'C1')).toEqual([]);
    const all = [...first.records, ...second.records];
    expect(exportResults({ manifest, starts: NO_STARTS, records: all, generatedAtUtc: '2026-11-20T10:00:00.000Z' }).records).toHaveLength(all.length);
  }, 120_000);

  it('refuses live dispatch unless preflight passes and the track started, before any trial runs', async () => {
    const e = env();
    const manifest = manifestFor(1);
    const blocked = preflight({ manifest, env: {}, verifier: { recorded: HASHES, recomputed: HASHES }, starts: NO_STARTS });
    await expect(runWorkerCohort({ manifest, env: e, live: { preflight: blocked, starts: NO_STARTS } })).rejects.toThrow(LiveRefusedError);
    const ok = preflight({ manifest, env: { ANTHROPIC_API_KEY: 'present' }, verifier: { recorded: HASHES, recomputed: HASHES }, starts: NO_STARTS });
    expect(ok.liveDispatch.workers.allowed).toBe(true);
    await expect(runWorkerCohort({ manifest, env: e, live: { preflight: ok, starts: NO_STARTS } })).rejects.toThrow(/cohort_not_started/);
    expect(e.runtimes.made).toEqual([]);
  });

  it('a live-path run with fake adapters produces measured records the T8.4 report accepts', async () => {
    // D6: the owner's CLI login, with the probe faked; no API key in the environment.
    const c = started(manifestFor(2, (m) => { m.credentials.mode = 'cli_login'; }));
    const pf = preflight({ manifest: c.manifest, env: {}, verifier: { recorded: HASHES, recomputed: HASHES }, starts: c.starts, cliLogin: { present: true, loggedIn: true } });
    const e = env({ fail: ['FB-03'] });
    const { records } = await runWorkerCohort({ manifest: c.manifest, env: e, live: { preflight: pf, starts: c.starts } });
    expect(records.every((r) => r.dataKind === 'measured')).toBe(true);
    // Every Track B record, run or not, names its credential mode and account tier.
    expect(records.every((r) => r.configuration.credentialMode === 'cli_login' && r.configuration.accountTier === 'tier-2')).toBe(true);
    const file = exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: '2026-11-20T10:00:00.000Z' });
    const report = buildReport(file, c.manifest);
    const l1 = report.workers.modes.find((x) => x.mode === 'L1')!;
    // Both completed, both failing FB-03 every time (repairs ran out): completed but not passed.
    expect(l1.completion).toEqual({ passed: 0, of: 2 });
    for (const mode of ['C1', 'H2']) expect(report.workers.modes.find((x) => x.mode === mode)!.status).toBe('Not measured');
    expect(existsSync(join(root, 'work'))).toBe(true);
  }, 120_000);

  it('a trial whose setup fails is abandoned, kept, and its slot retried with the next attempt', async () => {
    const manifest = manifestFor(1, (m) => { m.repository.starterSha = 'f'.repeat(40); });
    const first = await runWorkerCohort({ manifest, env: env(), live: null });
    const [r] = workers(first.records, 'L1');
    expect(r).toMatchObject({ status: 'abandoned', slotAttempt: 1, failures: [expect.objectContaining({ category: 'setup_failed' })] });
    expect(readdirSync(join(root, 'work'))).toEqual([]);
    expect(plannedTrials(manifest, 'workers', first.records).filter((p) => p.slot.mode === 'L1').map((p) => [p.slot.id, p.slotAttempt])).toEqual([['workers/block-1/L1', 2]]);
  });
});
