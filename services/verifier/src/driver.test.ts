import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { schema, sql, type Db } from '../../../packages/persistence/src/index.ts';
import { PROJECT, RUN, TENANT, resetDb, seedTask, setupTestDb, specFor, type TestDb } from '../../workflow/test/helpers.ts';
import { verifierHashes } from './hashing.ts';
import { assembleCandidate } from './integrate.ts';
import { createVerificationDriver, startVerificationDriver, type VerificationDriverOptions } from './driver.ts';
import { candidateContentHash, type RunnerInput, type RunnerOutput, type VerifierRunner } from './service.ts';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'suites/feedback-board/manifest.json'), 'utf8'));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const VERIFIER = { kind: 'verifier', id: 'verifier-local-1' } as const;

let tdb: TestDb;
let db: Db;
let root: string;
let repo: string;
let artifacts: LocalDiskArtifactStore;
let baseSha: string;

const q = async (text: string): Promise<Record<string, unknown>[]> => [...(await db.execute(sql.raw(text)))];
const taskStatus = async (id: string) => String((await q(`SELECT status FROM task_status WHERE task_id = '${id}'`))[0]!['status']);

async function addDone(taskId: string, files: Record<string, string>, over: Parameters<typeof specFor>[1] = {}): Promise<void> {
  await seedTask(db, specFor(taskId, { baseSha, allowedPaths: ['src'], ...over }), 'verifying');
  const entries: unknown[] = [];
  for (const [path, content] of Object.entries(files)) {
    const ref = await artifacts.put(Buffer.from(content));
    entries.push({ path, status: 'added', kind: 'file', sha256: ref.sha256, linkTarget: null, size: ref.size });
  }
  const body = JSON.stringify({ schema: 1, taskId, revision: 1, baseSha, changes: entries });
  const manifestSha = (await artifacts.put(Buffer.from(body))).sha256;
  await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: `att_${taskId}`, taskId, revision: 1, attemptNumber: 1, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifestSha } });
}
async function assembled(): Promise<{ sha: string }> {
  const r = await assembleCandidate({ tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo }, { db, artifacts, workRoot: join(root, 'work') });
  if (!r.ok) throw new Error(`assembly failed: ${r.reason}`);
  return r;
}
function resultFor(input: RunnerInput, statuses: Record<string, 'passed' | 'failed' | 'skipped' | 'error'> = {}): unknown {
  const hashes = verifierHashes(pkgRoot, resolve(pkgRoot, '../..'));
  return {
    protocolVersion: '0.1', verifier: { suiteId: manifest.suiteId, suiteVersion: manifest.version, ...hashes, image: manifest.tools.playwrightImage, tools: { node: 'v24.0.0', vitest: '5.1.0', playwright: '1.65.0' } },
    candidate: { treeSha256: candidateContentHash(input.candidateDir) }, startedAtUtc: '2026-11-09T01:00:00.000Z', endedAtUtc: '2026-11-09T01:01:00.000Z', setup: {},
    quality: {
      allRequiredChecksPassed: Object.values(statuses).every((x) => x === 'passed'),
      criteria: manifest.criteria.map((c: { id: string; tests: { runner: string; title: string }[] }) => {
        const st = statuses[c.id] ?? 'passed';
        return { id: c.id, status: st, evidenceReferences: [], failures: st === 'passed' ? [] : [{ test: c.tests[0]!.title, status: st, message: 'boom' }], tests: c.tests.map((t) => ({ runner: t.runner, title: t.title, status: st })) };
      }),
    },
  };
}
function counting(statuses: Parameters<typeof resultFor>[1] = {}): { runner: VerifierRunner; calls: () => number } {
  let n = 0;
  return { calls: () => n, runner: async (input: RunnerInput): Promise<RunnerOutput> => { n += 1; return { exitCode: Object.values(statuses).some((s) => s !== 'passed') ? 1 : 0, result: resultFor(input, statuses), log: 'ran' }; } };
}
const options = (runner: VerifierRunner, over: Partial<VerificationDriverOptions> = {}): VerificationDriverOptions =>
  ({ db, artifacts, runner, verifier: VERIFIER, host: 'local-docker', tenantId: TENANT, repoPath: repo, workRoot: join(root, 'work'), ...over });

beforeAll(async () => {
  tdb = await setupTestDb();
  db = tdb.db;
  root = mkdtempSync(join(tmpdir(), 'verify-driver-'));
  artifacts = new LocalDiskArtifactStore(join(root, 'artifacts'));
  repo = join(root, 'source');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'src/base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD');
});
afterAll(async () => { await tdb.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals CASCADE`);
  await addDone('t1', { 'src/a.txt': 'a\n' });
});

describe('verification driver', () => {
  it('verification driver runs an assembled candidate once', async () => {
    const { sha } = await assembled();
    const { runner, calls } = counting();
    // Two concurrent passes, as a second process would make: one run.
    const a = createVerificationDriver(options(runner));
    const b = createVerificationDriver(options(runner));
    const [ta, tb] = await Promise.all([a.tick(), b.tick()]);
    expect([ta.verified, tb.verified].filter(Boolean)).toEqual([sha]);
    expect(calls()).toBe(1);
    expect(await taskStatus('t1')).toBe('verified');
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'ready_for_review' });
    // A later pass, and a restarted process, finds the record and leaves it.
    const restarted = createVerificationDriver(options(runner));
    expect(await restarted.tick()).toEqual({ verified: null, reaped: [] });
    expect(calls()).toBe(1);
    const started = await q(`SELECT actor_kind, payload FROM events WHERE type = 'verification.started'`);
    expect(started).toEqual([{ actor_kind: 'verifier', payload: { candidateSha: sha } }]);
  });

  it('a claim left by a crashed process is honoured until it expires, then the run happens', async () => {
    const { sha } = await assembled();
    const t0 = new Date('2026-11-09T02:00:00Z');
    await db.execute(sql`UPDATE candidates SET detail = jsonb_set(detail, '{verificationDriver}', jsonb_build_object('claimedAt', ${t0.toISOString()}::text, 'expiresAt', ${new Date(t0.getTime() + 1000).toISOString()}::text)) WHERE sha = ${sha}`);
    let clock = t0;
    const { runner, calls } = counting();
    const driver = createVerificationDriver(options(runner, { now: () => clock }));
    await driver.tick();
    expect(calls()).toBe(0);
    clock = new Date(t0.getTime() + 2000);
    expect((await driver.tick()).verified).toBe(sha);
    expect(calls()).toBe(1);
  });

  it('ignores a candidate none of whose parts is waiting for a verdict', async () => {
    await assembled();
    await db.execute(sql`UPDATE task_status SET status = 'cancelled'`);
    const { runner, calls } = counting();
    expect(await createVerificationDriver(options(runner)).tick()).toEqual({ verified: null, reaped: [] });
    expect(calls()).toBe(0);
  });

  it('reaper closes error and skipped verifications', async () => {
    const first = (manifest.criteria[0] as { id: string }).id;
    await assembled();
    await db.execute(sql`INSERT INTO resource_claims (tenant_id, project_id, claim_id, task_id, revision, resource_key, mode, attempt_id) VALUES (${TENANT}, ${PROJECT}, 'clm_1', 't1', 1, 'repo', 'exclusive', 'att_t1')`);
    const errored = counting(Object.fromEntries(manifest.criteria.map((c: { id: string }) => [c.id, 'error'])));
    const driver = createVerificationDriver(options(errored.runner));
    expect((await driver.tick()).reaped).toHaveLength(1);
    expect(await taskStatus('t1')).toBe('blocked');
    const blocked = await q(`SELECT payload, actor_kind FROM events WHERE type = 'task.blocked'`);
    expect(blocked[0]).toMatchObject({ actor_kind: 'scheduler', payload: { reason: 'verification_error' } });
    expect((await q(`SELECT status, reason FROM candidates`))[0]).toMatchObject({ status: 'invalidated', reason: 'verification_error' });
    expect((await q(`SELECT released_at FROM resource_claims`))[0]!['released_at']).not.toBeNull();
    // No repair spent, and the candidate is not verified again.
    expect((await q(`SELECT outcome FROM attempts WHERE attempt_id = 'att_t1'`))[0]).toMatchObject({ outcome: 'interrupted' });
    await driver.tick();
    expect(errored.calls()).toBe(1);

    // A skipped check is closed the same way, under its own reason.
    await resetDb(db);
    await db.execute(sql`TRUNCATE integration_leases, candidates CASCADE`);
    await addDone('t1', { 'src/a.txt': 'a\n' });
    await assembled();
    const skipped = counting({ [first]: 'skipped' });
    const second = await createVerificationDriver(options(skipped.runner)).tick();
    expect(second.reaped).toHaveLength(1);
    expect(await taskStatus('t1')).toBe('blocked');
    expect((await q(`SELECT reason FROM candidates`))[0]).toMatchObject({ reason: 'verification_skipped' });
  });

  it('a commit that cannot be exported closes the candidate instead of retrying forever', async () => {
    await assembled();
    const gone = options(counting().runner, { repoPath: join(root, 'not-a-repo') });
    mkdirSync(join(root, 'not-a-repo'), { recursive: true });
    const tick = await createVerificationDriver(gone).tick();
    expect(tick.verified).not.toBeNull();
    expect(await taskStatus('t1')).toBe('blocked');
    expect((await q(`SELECT reason FROM candidates`))[0]).toMatchObject({ reason: 'verification_export_failed' });
  });

  it('startVerificationDriver ticks on its interval and stops', async () => {
    const { runner } = counting();
    const driver = startVerificationDriver({ ...options(runner), intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 80));
    await driver.stop();
    expect(driver.ticks()).toBeGreaterThan(0);
  });
});
