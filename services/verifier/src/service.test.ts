import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync as chmod } from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { checkEventAuthority, type EventEnvelope } from '../../../packages/domain/src/index.ts';
import { schema, sql, type Db } from '../../../packages/persistence/src/index.ts';
import { PROJECT, RUN, TENANT, resetDb, seedTask, setupTestDb, specFor, type TestDb } from '../../workflow/test/helpers.ts';
import { verifierHashes } from './hashing.ts';
import { assembleCandidate } from './integrate.ts';
import { loadRunEvidence } from '../../workflow/src/evidence.ts';
import { RecordStoreUnavailableError } from '../../workflow/src/verification-record.ts';
import { CandidateNotVerifiable, candidateContentHash, currentTrusted, dockerRunner, loadValidRecord, verifyCandidate, type RunnerInput, type RunnerOutput, type VerificationDeps } from './service.ts';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const manifestBytes = readFileSync(join(pkgRoot, 'suites/feedback-board/manifest.json'));
const manifest = JSON.parse(manifestBytes.toString());
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
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
const status = async (taskId: string) => String((await q(`SELECT status FROM task_status WHERE task_id = '${taskId}'`))[0]!['status']);

async function addDone(taskId: string, files: Record<string, string>, over: Parameters<typeof specFor>[1] = {}, taskStatus = 'verifying'): Promise<void> {
  await seedTask(db, specFor(taskId, { baseSha, allowedPaths: ['src'], ...over }), taskStatus);
  const entries: unknown[] = [];
  for (const [path, content] of Object.entries(files)) {
    const ref = await artifacts.put(Buffer.from(content));
    entries.push({ path, status: 'added', kind: 'file', sha256: ref.sha256, linkTarget: null, size: ref.size });
  }
  const body = JSON.stringify({ schema: 1, taskId, revision: 1, baseSha, changes: entries });
  const manifestSha = (await artifacts.put(Buffer.from(body))).sha256;
  await db.insert(schema.attempts).values({
    tenantId: TENANT, projectId: PROJECT, attemptId: `att_${taskId}`, taskId, revision: 1, attemptNumber: 1,
    outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifestSha },
  });
}

async function assemble(): Promise<{ sha: string; treeSha: string }> {
  const r = await assembleCandidate(
    { tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo },
    { db, artifacts, workRoot: join(root, 'work') });
  if (!r.ok) throw new Error(`assembly failed: ${r.reason}`);
  return r;
}

/** Builds a runner result exactly as the trusted runner would write it. */
function resultFor(input: RunnerInput, statuses: Record<string, 'passed' | 'failed' | 'skipped' | 'error'> = {}, over: Record<string, unknown> = {}): unknown {
  const hashes = verifierHashes(pkgRoot, repoRoot);
  return {
    protocolVersion: '0.1',
    verifier: { suiteId: manifest.suiteId, suiteVersion: manifest.version, ...hashes, image: manifest.tools.playwrightImage, tools: { node: 'v24.0.0', vitest: '5.1.0', playwright: '1.65.0' } },
    candidate: { treeSha256: candidateContentHash(input.candidateDir) },
    startedAtUtc: '2026-11-09T01:00:00.000Z', endedAtUtc: '2026-11-09T01:01:00.000Z',
    setup: {},
    quality: {
      allRequiredChecksPassed: Object.values(statuses).every((x) => x === 'passed'),
      criteria: manifest.criteria.map((c: { id: string; tests: { runner: string; title: string }[] }) => {
        const st = statuses[c.id] ?? 'passed';
        return {
          id: c.id, status: st, evidenceReferences: [], failures: st === 'passed' ? [] : [{ test: c.tests[0]!.title, status: st, message: 'AssertionError: expected 400' }],
          tests: c.tests.map((t) => ({ runner: t.runner, title: t.title, status: st })),
        };
      }),
    },
    ...over,
  };
}
const ok = (input: RunnerInput, statuses?: Parameters<typeof resultFor>[1], over?: Record<string, unknown>): RunnerOutput =>
  ({ exitCode: Object.values(statuses ?? {}).some((s) => s !== 'passed') ? 1 : 0, result: resultFor(input, statuses, over), log: 'ran' });

const deps = (runner: VerificationDeps['runner'], over: Partial<VerificationDeps> = {}): VerificationDeps =>
  ({ db, artifacts, runner, verifier: VERIFIER, host: 'local-docker', workRoot: join(root, 'work'), ...over });
const ref = (c: { sha: string }, taskId = 't1') => ({ tenantId: TENANT, projectId: PROJECT, runId: RUN, sha: c.sha, taskId, repoPath: repo });

beforeAll(async () => {
  tdb = await setupTestDb();
  db = tdb.db;
  root = mkdtempSync(join(tmpdir(), 'verify-svc-'));
  artifacts = new LocalDiskArtifactStore(join(root, 'artifacts'));
  repo = join(root, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'src/base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD');
});
afterAll(async () => {
  await tdb.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals CASCADE`);
});

describe('verifyCandidate', () => {
  it('record bound to exact SHA and manifest hash', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { resourceClaims: [{ key: 'k', mode: 'exclusive' }] });
    const cand = await assemble();
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_1', taskId: 't1', revision: 1, resourceKey: 'k', mode: 'exclusive', attemptId: 'att_t1' });
    let seenHash = '';
    let files: string[] = [];
    const record = await verifyCandidate(ref(cand), deps(async (input) => {
      seenHash = candidateContentHash(input.candidateDir);
      files = readdirSync(join(input.candidateDir, 'src')).sort();
      return ok(input);
    }));
    // The runner saw exactly the candidate commit's tree.
    expect(files).toEqual(['a.txt', 'base.txt']);
    expect(record).toMatchObject({
      candidateSha: cand.sha, candidateTreeSha: cand.treeSha, baseSha, taskId: 't1', runId: RUN, result: 'passed', host: 'local-docker',
      checkManifestSha256: sha256(manifestBytes), environmentImageDigest: manifest.tools.playwrightImage, verifier: VERIFIER,
    });
    expect(record.verifierSha256).toBe(verifierHashes(pkgRoot, repoRoot).verifierSha256);
    expect(record.results.map((r) => r.checkId)).toEqual(manifest.criteria.map((c: { id: string }) => c.id));
    expect(record.fixtures[0]).toMatchObject({ path: 'fixtures/feedback-fixtures.json', sha256: sha256(readFileSync(join(pkgRoot, 'suites/feedback-board/fixtures/feedback-fixtures.json'))) });
    expect(record.candidateContentSha256).toBe(seenHash);
    // Stored, bound and loadable by SHA; the task passed through the workflow transition; the parent run is ready for review.
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: cand.sha })).toEqual(record);
    // The verifier's time goes in the ledger, as measured time on its host.
    expect(await db.execute(sql`SELECT role, metric, provenance, source, host, basis FROM usage_entries WHERE role = 'verification'`)).toEqual([{ role: 'verification', metric: 'worker_seconds', provenance: 'observed', source: 'verifier', host: 'local', basis: 'measured' }]);
    expect(await status('t1')).toBe('verified');
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'ready_for_review' });
    expect(await q(`SELECT 1 FROM check_runs WHERE candidate_sha = '${cand.sha}' AND result = 'passed'`)).toHaveLength(8);
    expect(await q(`SELECT 1 FROM resource_claims WHERE released_at IS NULL`)).toHaveLength(0);
    expect(await q(`SELECT actor_kind, actor_id FROM events WHERE type = 'verification.passed'`)).toEqual([{ actor_kind: 'verifier', actor_id: 'verifier-local-1' }]);
    // The record's artifacts live in the store.
    for (const id of record.artifactIds) expect(await q(`SELECT 1 FROM artifacts WHERE artifact_id = '${id}'`)).toHaveLength(1);
  });

  it('a result for another manifest or another tree is an infrastructure error, not a verdict', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    const wrongManifest = await verifyCandidate(ref(cand), deps(async (i) => ok(i, {}, { verifier: { ...(resultFor(i) as any).verifier, manifestSha256: 'f'.repeat(64) } })));
    expect(wrongManifest.result).toBe('error');
    const wrongTree = await verifyCandidate(ref(cand), deps(async (i) => ok(i, {}, { candidate: { treeSha256: 'e'.repeat(64) } })));
    expect(wrongTree.result).toBe('error');
    expect(await status('t1')).toBe('verifying');
  });

  it('candidate change invalidates record', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const first = await assemble();
    const record = await verifyCandidate(ref(first), deps(async (i) => ok(i)));
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: first.sha })).toEqual(record);
    // A new part changes the candidate: the old record is no longer evidence for anything.
    await addDone('t2', { 'src/b.txt': 'b\n' });
    const second = await assemble();
    expect(second.sha).not.toBe(first.sha);
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: first.sha })).toBeNull();
    expect(await q(`SELECT result FROM check_runs WHERE candidate_sha = '${first.sha}' AND result <> 'invalidated'`)).toHaveLength(0);
    await expect(verifyCandidate(ref(first), deps(async (i) => ok(i)))).rejects.toBeInstanceOf(CandidateNotVerifiable);
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: second.sha })).toBeNull();
  });

  it('a candidate invalidated while the suite runs gets a record that is born invalid and changes no task', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const first = await assemble();
    const record = await verifyCandidate(ref(first), deps(async (i) => {
      await addDone('t2', { 'src/b.txt': 'b\n' });
      await assemble();
      return ok(i);
    }));
    expect(record.taskOutcomes.every((o) => !o.applied)).toBe(true);
    expect(await status('t1')).toBe('verifying');
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: first.sha })).toBeNull();
  });

  it('skipped stays skipped', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    const record = await verifyCandidate(ref(cand), deps(async (i) => ok(i, { 'FB-03': 'skipped' })));
    expect(record.result).toBe('skipped');
    expect(record.results.find((r) => r.checkId === 'FB-03')!.status).toBe('skipped');
    expect(record.results.filter((r) => r.status === 'passed')).toHaveLength(7);
    expect(await q(`SELECT result FROM check_runs WHERE check_id = 'FB-03'`)).toEqual([{ result: 'skipped' }]);
    expect(await status('t1')).toBe('verifying');
    expect(await q(`SELECT 1 FROM events WHERE type LIKE 'verification.%'`)).toHaveLength(0);
  });

  it('flaky retry stays visible', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    let calls = 0;
    const record = await verifyCandidate(ref(cand), deps(async (i) => ok(i, ++calls === 1 ? { 'FB-02': 'failed' } : {}), { flakyRetries: 1 }));
    expect(calls).toBe(2);
    expect(record.runs).toHaveLength(2);
    expect(record.runs[0]!.results.find((r) => r.checkId === 'FB-02')!.status).toBe('failed');
    expect(record.runs[1]!.results.find((r) => r.checkId === 'FB-02')!.status).toBe('passed');
    expect(record.flaky).toEqual(['FB-02']);
    // Both results are rows; neither overwrote the other.
    expect((await q(`SELECT result FROM check_runs WHERE check_id = 'FB-02' ORDER BY created_at, check_run_id`)).map((r) => r['result']).sort()).toEqual(['failed', 'passed']);
  });

  it('a failure records a failed check and schedules a bounded repair; an infrastructure error is reported as error', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { maxAttempts: 2 });
    const cand = await assemble();
    const failed = await verifyCandidate(ref(cand), deps(async (i) => ok(i, { 'FB-05': 'failed' })));
    expect(failed.result).toBe('failed');
    expect(failed.taskOutcomes[0]).toMatchObject({ applied: true, taskStatus: 'ready' });
    expect(await q(`SELECT actor_kind FROM events WHERE type = 'verification.failed'`)).toEqual([{ actor_kind: 'verifier' }]);
    expect(await status('t1')).toBe('ready');

    await resetDb(db);
    await db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals CASCADE`);
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand2 = await assemble();
    const crashed = await verifyCandidate(ref(cand2), deps(async () => ({ exitCode: 2, result: null, log: 'docker: Cannot connect to the Docker daemon' })));
    expect(crashed.result).toBe('error');
    expect(crashed.runs[0]!.infrastructureError).toMatch(/no result/i);
    const thrown = await verifyCandidate(ref(cand2), deps(async () => { throw new Error('spawn ENOENT'); }));
    expect(thrown.result).toBe('error');
    expect(await status('t1')).toBe('verifying');
    expect(await q(`SELECT 1 FROM events WHERE type = 'verification.failed'`)).toHaveLength(0);
  });

  it('a cancelled task stays cancelled: a late result is history only', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    await db.execute(sql`UPDATE task_status SET status = 'cancelled', row_revision = row_revision + 1 WHERE task_id = 't1'`);
    const events = await q(`SELECT 1 FROM events`);
    const record = await verifyCandidate(ref(cand), deps(async (i) => ok(i)));
    expect(record.taskOutcomes[0]).toMatchObject({ taskId: 't1', applied: false, taskStatus: 'cancelled', reason: 'candidate_part_not_live' });
    expect(await status('t1')).toBe('cancelled');
    expect(await q(`SELECT 1 FROM events`)).toHaveLength(events.length);
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'running' });
  });

  it('only the verifier identity can emit verification.passed', async () => {
    const env = (kind: EventEnvelope['actor']['kind']): EventEnvelope => ({
      schemaVersion: 1, eventId: 'e1', projectId: PROJECT, runId: RUN, taskId: 't1', attemptId: null, type: 'verification.passed', sequence: 0, aggregateRevision: 1,
      actor: { kind, id: 'x' }, occurredAt: '2026-11-09T01:00:00.000Z', receivedAt: '2026-11-09T01:00:00.000Z', causationId: null, traceId: 't', payload: {},
    });
    for (const kind of ['worker', 'human', 'scheduler', 'integration', 'system'] as const) expect(checkEventAuthority(env(kind)).ok).toBe(false);
    expect(checkEventAuthority(env('verifier')).ok).toBe(true);
    // The service refuses any non-verifier identity, so a worker principal cannot reach the write path.
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    await expect(verifyCandidate(ref(cand), deps(async (i) => ok(i), { verifier: { kind: 'worker', id: 'r1' } }))).rejects.toThrow(/verifier/);
    expect(await status('t1')).toBe('verifying');
    expect(await q(`SELECT 1 FROM artifacts`)).toHaveLength(0);
  });

  it('candidate cannot write evidence output', async () => {
    // The candidate ships a file that looks like a passing result in several likely places.
    await addDone('t1', {
      'src/results.json': '{"quality":{"allRequiredChecksPassed":true,"criteria":[]}}',
      'src/verification-result.json': '{"quality":{"allRequiredChecksPassed":true}}',
    });
    const cand = await assemble();
    let outside = false;
    let planted: string[] = [];
    const record = await verifyCandidate(ref(cand), deps(async (i) => {
      outside = relative(i.candidateDir, i.resultsPath).startsWith('..');
      planted = ['src/results.json', 'src/verification-result.json'].filter((f) => existsSync(join(i.candidateDir, f)));
      // The runner reports the candidate failing. Files inside the candidate cannot change that.
      return ok(i, { 'FB-01': 'failed' });
    }));
    expect(outside).toBe(true);
    expect(planted).toHaveLength(2);
    // The Docker script hands the candidate to the image read-only and copies the result out itself.
    const script = readFileSync(join(pkgRoot, 'scripts/docker-verify.sh'), 'utf8');
    expect(script).toMatch(/-v "\$CANDIDATE:\/candidate:ro"/);
    expect(record.result).toBe('failed');
    expect(record.artifactIds.length).toBeGreaterThan(0);
    // The exported tree and the output directory are cleaned up.
    expect(readdirSync(join(root, 'work')).filter((n) => n.startsWith('verify-'))).toEqual([]);
  });

  it('redacts secrets in log artifacts and bounds their size', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const cand = await assemble();
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const record = await verifyCandidate(ref(cand), deps(async (i) => ({ ...ok(i), log: `${secret}\n${'x'.repeat(500_000)}` }), { logLimitBytes: 4096 }));
    const logId = record.runs[0]!.logArtifactId!;
    const row = (await q(`SELECT sha256 FROM artifacts WHERE artifact_id = '${logId}'`))[0]!;
    const text = Buffer.from((await artifacts.get(String(row['sha256'])))!).toString();
    expect(text).not.toContain(secret);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096 + 200);
  });
});

const loadKey = (c: { sha: string }) => ({ tenantId: TENANT, projectId: PROJECT, sha: c.sha });
const bar = (trusted = currentTrusted()) => ({ trusted, artifacts });

describe('per-criterion evidence over a real verification', () => {
  it('two parts, a shared requirement and a failed-then-passed retry read as verified, flaky, on the real record', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { requirementIds: ['FB-01', 'FB-02'] });
    await addDone('t2', { 'src/b.txt': 'b\n' }, { requirementIds: ['FB-02', 'FB-03'] });
    const cand = await assemble();
    let calls = 0;
    await verifyCandidate(ref(cand), deps(async (i) => ok(i, ++calls === 1 ? { 'FB-02': 'failed' } : {}), { flakyRetries: 1 }));
    expect(calls).toBe(2);
    const tasks = async (t1 = 'verified') => [
      { taskId: 't1', revision: 1, status: t1, requirementIds: ['FB-01', 'FB-02'] },
      { taskId: 't2', revision: 1, status: await status('t2'), requirementIds: ['FB-02', 'FB-03'] },
    ];
    expect(await status('t1')).toBe('verified');
    const scope = { tenantId: TENANT, projectId: PROJECT, runId: RUN };
    const result = (await loadRunEvidence(db, scope, await tasks(), bar()))!;
    expect(result.criteria).toEqual({ verified: 3, total: 3 });
    expect(result.evidence.candidate).toMatchObject({ sha: cand.sha, recordValid: true, flaky: ['FB-02'] });
    const shared = result.evidence.criteria.find((c) => c.criterionId === 'FB-02')!;
    expect(shared).toMatchObject({ state: 'passed', verified: true, taskIds: ['t1', 't2'], candidateSha: cand.sha });
    // The retry's result is the one shown, not the failure before it.
    expect(shared.check?.verificationAttempt).toBe(2);
    expect(shared.check?.recordId).toBe(result.evidence.candidate!.recordId);

    // Another verifier build, or a part not finished, and the same rows count for nothing.
    expect((await loadRunEvidence(db, scope, await tasks(), bar({ ...currentTrusted(), verifierSha256: 'f'.repeat(64) })))!.criteria.verified).toBe(0);
    expect((await loadRunEvidence(db, scope, await tasks('running'), bar()))!.criteria.verified).toBe(1); // FB-03 alone is carried only by t2
  });

  it('one bar: a wiped or corrupt record reads as not valid on both the evidence and the pull-request routes', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { requirementIds: ['FB-01'] });
    const cand = await assemble();
    await verifyCandidate(ref(cand), deps(async (i) => ok(i)));
    const scope = { tenantId: TENANT, projectId: PROJECT, runId: RUN };
    const tasks = [{ taskId: 't1', revision: 1, status: 'verified', requirementIds: ['FB-01'] }];
    expect((await loadRunEvidence(db, scope, tasks, bar()))!.evidence.candidate).toMatchObject({ recordValid: true });
    for (const store of [
      { put: artifacts.put.bind(artifacts), has: async () => false, get: async () => null },
      { put: artifacts.put.bind(artifacts), has: async () => true, get: async (): Promise<Uint8Array | null> => { throw new ArtifactIntegrityError('a'.repeat(64)); } },
      { put: artifacts.put.bind(artifacts), has: async () => true, get: async () => Buffer.from('not a record') },
    ]) {
      expect(await loadValidRecord(db, store, loadKey(cand))).toBeNull();
      const report = (await loadRunEvidence(db, scope, tasks, { trusted: currentTrusted(), artifacts: store }))!;
      expect(report.evidence.candidate).toMatchObject({ recordValid: false });
      expect(report.criteria.verified).toBe(0);
    }
    // A read that fails is not a verdict: the record is not called invalid, and acting on it is refused. The report still counts no pass, and survives.
    const sick = { put: artifacts.put.bind(artifacts), has: async () => true, get: async (): Promise<Uint8Array | null> => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    await expect(loadValidRecord(db, sick, loadKey(cand))).rejects.toBeInstanceOf(RecordStoreUnavailableError);
    expect((await loadRunEvidence(db, scope, tasks, { trusted: currentTrusted(), artifacts: sick }))!.criteria.verified).toBe(0);
    // No store at all is the same answer, not a pass.
    expect((await loadRunEvidence(db, scope, tasks, null))!.criteria.verified).toBe(0);
  });
});

describe('verdicts are bound to the attempt they judged', () => {
  it('repair then re-verify: the failed candidate is consumed and cannot verify the repair attempt', async () => {
    await addDone('t1', { 'src/a.txt': 'a1\n' }, { maxAttempts: 2 });
    const a = await assemble();
    const failed = await verifyCandidate(ref(a), deps(async (i) => ok(i, { 'FB-02': 'failed' })));
    expect(failed.taskOutcomes[0]).toMatchObject({ applied: true, taskStatus: 'ready' });
    // The candidate that failed is consumed.
    expect((await q(`SELECT status FROM candidates WHERE sha = '${a.sha}'`))[0]).toMatchObject({ status: 'rejected' });
    await expect(verifyCandidate(ref(a), deps(async (i) => ok(i)))).rejects.toBeInstanceOf(CandidateNotVerifiable);
    // Attempt 2 publishes a different change and the task is verifying again.
    await db.execute(sql`UPDATE task_status SET status = 'verifying', row_revision = row_revision + 1 WHERE task_id = 't1'`);
    const body = JSON.stringify({ schema: 1, taskId: 't1', revision: 1, baseSha, changes: [{ path: 'src/a.txt', status: 'added', kind: 'file', sha256: (await artifacts.put(Buffer.from('a2\n'))).sha256, linkTarget: null, size: 3 }] });
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_t1_2', taskId: 't1', revision: 1, attemptNumber: 2, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: (await artifacts.put(Buffer.from(body))).sha256 } });
    // Even if the old candidate were still assembled, its verdict must not land on attempt 2.
    await db.execute(sql`UPDATE candidates SET status = 'assembled' WHERE sha = '${sql.raw(a.sha)}'`);
    const stale = await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    expect(stale.taskOutcomes[0]).toMatchObject({ applied: false, taskStatus: 'verifying', reason: 'stale_candidate' });
    expect(await status('t1')).toBe('verifying');
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'running' });
    expect((await loadValidRecord(db, artifacts, loadKey(a)))?.result).toBe('failed'); // the applied verdict stays the only evidence for A
    // The new candidate for attempt 2 verifies normally.
    await db.execute(sql`UPDATE candidates SET status = 'invalidated' WHERE sha = '${sql.raw(a.sha)}'`);
    const b = await assemble();
    expect(b.sha).not.toBe(a.sha);
    const passed = await verifyCandidate(ref(b), deps(async (i) => ok(i)));
    expect(passed.taskOutcomes[0]).toMatchObject({ applied: true, taskStatus: 'verified' });
  });

  it('a part cancelled mid-suite releases no part of the candidate and keeps the run out of ready_for_review', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    await addDone('t2', { 'src/b.txt': 'b\n' });
    const c = await assemble();
    const rec = await verifyCandidate(ref(c), deps(async (i) => {
      await db.execute(sql`UPDATE task_status SET status = 'cancelled', row_revision = row_revision + 1 WHERE task_id = 't2'`);
      return ok(i);
    }));
    expect(rec.taskOutcomes.find((o) => o.taskId === 't2')).toMatchObject({ applied: false, reason: 'candidate_part_not_live' });
    // The tree still contains t2's cancelled work, so t1 cannot be released on it.
    expect(rec.taskOutcomes.find((o) => o.taskId === 't1')).toMatchObject({ applied: false, reason: 'candidate_part_not_live' });
    expect(await status('t1')).toBe('verifying');
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'running' });
  });
});

describe('readiness stays tied to live evidence', () => {
  it('invalidating the candidate reverts the run and reopens the verified parts for re-verification', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const a = await assemble();
    await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'ready_for_review' });
    await addDone('t2', { 'src/b.txt': 'b\n' });
    const b = await assemble();
    expect(await loadValidRecord(db, artifacts, loadKey(a))).toBeNull();
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'running' });
    expect(await status('t1')).toBe('verifying');
    const rec = await verifyCandidate(ref(b), deps(async (i) => ok(i)));
    expect(rec.taskOutcomes.map((o) => [o.taskId, o.applied])).toEqual([['t1', true], ['t2', true]]);
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'ready_for_review' });
  });
});

describe('authoritative records', () => {
  it('only the applied record is evidence: error and late records never shadow or contradict it', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const c = await assemble();
    const crashed = await verifyCandidate(ref(c), deps(async () => ({ exitCode: 2, result: null, log: 'boom' })));
    expect(crashed.result).toBe('error');
    expect(await loadValidRecord(db, artifacts, loadKey(c))).toBeNull();
    const passed = await verifyCandidate(ref(c), deps(async (i) => ok(i)));
    expect(await loadValidRecord(db, artifacts, loadKey(c))).toEqual(passed);
    // A later error or failed run on the same SHA is history: the task stays verified and the loader still returns the applied record.
    await verifyCandidate(ref(c), deps(async () => ({ exitCode: 2, result: null, log: 'boom again' })));
    const late = await verifyCandidate(ref(c), deps(async (i) => ok(i, { 'FB-01': 'failed' })));
    expect(late.taskOutcomes[0]).toMatchObject({ applied: false, reason: 'not_verifying' });
    expect(await status('t1')).toBe('verified');
    expect(await loadValidRecord(db, artifacts, loadKey(c))).toEqual(passed);
  });

  it('a second verification of the same candidate cannot run while one holds the lease', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const c = await assemble();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const slow = verifyCandidate(ref(c), deps(async (i) => { entered(); await gate; return ok(i); }));
    await started;
    await expect(verifyCandidate(ref(c), deps(async (i) => ok(i, { 'FB-01': 'failed' })))).rejects.toMatchObject({ reason: 'lease_held' });
    release();
    expect((await slow).result).toBe('passed');
    expect(await status('t1')).toBe('verified');
    // The lease is released afterwards.
    expect((await q(`SELECT detail FROM candidates WHERE sha = '${c.sha}'`))[0]!['detail']).not.toHaveProperty('verification');
  });

  it('the loader checks candidate SHA, manifest hash and verifier hash against current trusted values', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const c = await assemble();
    const rec = await verifyCandidate(ref(c), deps(async (i) => ok(i)));
    const trusted = { checkManifestSha256: rec.checkManifestSha256, verifierSha256: rec.verifierSha256 };
    expect(await loadValidRecord(db, artifacts, loadKey(c), { trusted })).toEqual(rec);
    // The suite changed since the record was made: it is no longer evidence.
    expect(await loadValidRecord(db, artifacts, loadKey(c), { trusted: { ...trusted, checkManifestSha256: 'f'.repeat(64) } })).toBeNull();
    expect(await loadValidRecord(db, artifacts, loadKey(c), { trusted: { ...trusted, verifierSha256: 'f'.repeat(64) } })).toBeNull();
    // A stored record whose candidate does not match the requested SHA is refused.
    const other = '1'.repeat(40);
    await db.execute(sql`UPDATE artifacts SET source_revision = ${other} WHERE type = 'verification_record'`);
    await db.execute(sql`UPDATE candidates SET sha = ${other}, candidate_id = 'cand_other' WHERE sha = ${c.sha}`);
    expect(await loadValidRecord(db, artifacts, { ...loadKey(c), sha: other })).toBeNull();
  });
});

describe('runner results are strict', () => {
  it('malformed entries are an infrastructure error, never silently filtered', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const c = await assemble();
    const bad = await verifyCandidate(ref(c), deps(async (i) => {
      const r = resultFor(i) as any;
      r.quality.criteria[0].tests.push({ runner: 'vitest', title: 'x', status: 'weird' });
      return { exitCode: 0, result: r, log: '' };
    }));
    expect(bad.result).toBe('error');
    expect(bad.runs[0]!.infrastructureError).toMatch(/malformed/i);
    const missing = await verifyCandidate(ref(c), deps(async (i) => {
      const r = resultFor(i) as any;
      delete r.quality.criteria[1].failures;
      return { exitCode: 0, result: r, log: '' };
    }));
    expect(missing.result).toBe('error');
    expect(await status('t1')).toBe('verifying');
  });

  it('passed requires exit code 0', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const c = await assemble();
    const rec = await verifyCandidate(ref(c), deps(async (i) => ({ exitCode: 1, result: resultFor(i), log: '' })));
    expect(rec.result).toBe('error');
    expect(rec.runs[0]!.infrastructureError).toMatch(/exit/i);
    expect(await status('t1')).toBe('verifying');
  });
});

describe('dockerRunner', () => {
  it('kills the named container on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docker-stub-'));
    const calls = join(dir, 'calls.txt');
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`);
    chmod(stub, 0o755);
    const script = join(dir, 'verify.sh');
    writeFileSync(script, `#!/bin/sh\necho "$VERIFY_CONTAINER_NAME" > ${join(dir, 'name.txt')}\nexec sleep 30\n`);
    chmod(script, 0o755);
    const out = await dockerRunner({ script, timeoutMs: 1500, dockerCommand: stub })({ candidateDir: dir, resultsPath: join(dir, 'r.json') });
    const name = readFileSync(join(dir, 'name.txt'), 'utf8').trim();
    expect(name).toMatch(/^selarikru-verify-/);
    for (let i = 0; i < 50 && !existsSync(calls); i += 1) await new Promise((r) => setTimeout(r, 50)); // the kill is issued asynchronously
    expect(readFileSync(calls, 'utf8')).toContain(`kill ${name}`);
    expect(out.log).toMatch(/timed out/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reopening on invalidation is a recorded, legal transition', () => {
  const verifyAndReopen = async (claims: { key: string; mode: 'shared' | 'exclusive' }[] = []) => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { resourceClaims: claims, maxAttempts: 2 });
    const a = await assemble();
    await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    expect(await status('t1')).toBe('verified');
    await addDone('t2', { 'src/b.txt': 'b\n' });
    return { a, b: await assemble() };
  };

  it('writes task-scoped and run-scoped events by the integration actor, and reopens the attempt', async () => {
    await verifyAndReopen();
    expect(await status('t1')).toBe('verifying');
    expect(await q(`SELECT task_id, actor_kind, payload FROM events WHERE type = 'task.reopened'`)).toMatchObject([{ task_id: 't1', actor_kind: 'integration' }]);
    expect(await q(`SELECT task_id, actor_kind FROM events WHERE type = 'run.reverted'`)).toEqual([{ task_id: RUN, actor_kind: 'integration' }]);
    expect((await q(`SELECT lifecycle FROM runs`))[0]).toMatchObject({ lifecycle: 'running' });
    expect((await q(`SELECT outcome FROM attempts WHERE attempt_id = 'att_t1'`))[0]).toMatchObject({ outcome: 'running' });
  });

  it('re-acquires the exclusive claims the passing verdict released', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { resourceClaims: [{ key: 'k', mode: 'exclusive' }] });
    const a = await assemble();
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_1', taskId: 't1', revision: 1, resourceKey: 'k', mode: 'exclusive', attemptId: 'att_t1' });
    await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    expect(await q(`SELECT 1 FROM resource_claims WHERE released_at IS NULL`)).toHaveLength(0);
    await addDone('t2', { 'src/b.txt': 'b\n' });
    await assemble();
    expect(await status('t1')).toBe('verifying');
    expect(await q(`SELECT task_id, resource_key, mode FROM resource_claims WHERE released_at IS NULL`)).toEqual([{ task_id: 't1', resource_key: 'k', mode: 'exclusive' }]);
  });

  it('blocks the task with a clear reason when a conflicting live claim exists', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' }, { resourceClaims: [{ key: 'k', mode: 'exclusive' }] });
    const a = await assemble();
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_1', taskId: 't1', revision: 1, resourceKey: 'k', mode: 'exclusive', attemptId: 'att_t1' });
    await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    // Another task took the resource while t1 was verified.
    await seedTask(db, specFor('t3', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }), 'running');
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_3', taskId: 't3', revision: 1, resourceKey: 'k', mode: 'exclusive' });
    await addDone('t2', { 'src/b.txt': 'b\n' });
    await assemble();
    expect(await status('t1')).toBe('blocked');
    expect(await q(`SELECT payload FROM events WHERE type = 'task.reopened' AND task_id = 't1'`)).toMatchObject([{ payload: { blocked: 'resource_conflict:k' } }]);
    expect(await q(`SELECT 1 FROM events WHERE type = 'task.blocked' AND task_id = 't1'`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM resource_claims WHERE task_id = 't1' AND released_at IS NULL`)).toHaveLength(0);
    expect((await q(`SELECT outcome FROM attempts WHERE attempt_id = 'att_t1'`))[0]).toMatchObject({ outcome: 'interrupted' });
  });

  it('a failed re-verification fails the reopened attempt record', async () => {
    const { b } = await verifyAndReopen();
    const rec = await verifyCandidate(ref(b), deps(async (i) => ok(i, { 'FB-03': 'failed' })));
    expect(rec.taskOutcomes.find((o) => o.taskId === 't1')).toMatchObject({ applied: true, taskStatus: 'ready' });
    expect((await q(`SELECT outcome FROM attempts WHERE attempt_id = 'att_t1'`))[0]).toMatchObject({ outcome: 'failed' });
  });

  it('is recorded even when the rebuilt assembly then fails', async () => {
    await addDone('t1', { 'src/a.txt': 'a\n' });
    const a = await assemble();
    await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    // main moves and changes the very path t1 added: the rebuild conflicts, but the old evidence is already gone.
    writeFileSync(join(repo, 'src/a.txt'), 'main changed it\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'move main');
    const moved = git(repo, 'rev-parse', 'HEAD');
    try {
      const r = await assembleCandidate({ tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: moved, repoPath: repo }, { db, artifacts, workRoot: join(root, 'work') });
      expect(r.ok).toBe(false);
      expect(await status('t1')).toBe('verifying');
      expect(await q(`SELECT 1 FROM events WHERE type = 'task.reopened' AND task_id = 't1'`)).toHaveLength(1);
      expect(await q(`SELECT 1 FROM events WHERE type = 'run.reverted'`)).toHaveLength(1);
    } finally {
      git(repo, 'reset', '-q', '--hard', baseSha);
    }
  });
});

describe('an identical repair rebinds the candidate', () => {
  it('fail, repair with identical bytes, reassemble, verify: the verdict applies', async () => {
    await addDone('t1', { 'src/a.txt': 'same\n' }, { maxAttempts: 2, resourceClaims: [{ key: 'k', mode: 'exclusive' }] });
    const a = await assemble();
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_1', taskId: 't1', revision: 1, resourceKey: 'k', mode: 'exclusive', attemptId: 'att_t1' });
    await verifyCandidate(ref(a), deps(async (i) => ok(i, { 'FB-02': 'failed' })));
    expect(await status('t1')).toBe('ready');
    // Attempt 2 publishes byte-identical changes.
    const manifest = String(((await q(`SELECT detail FROM attempts WHERE attempt_id = 'att_t1'`))[0]!['detail'] as Record<string, unknown>)['changeManifestSha256']);
    await db.execute(sql`UPDATE task_status SET status = 'verifying', row_revision = row_revision + 1 WHERE task_id = 't1'`);
    await db.insert(schema.resourceClaims).values({ tenantId: TENANT, projectId: PROJECT, claimId: 'clm_2', taskId: 't1', revision: 1, resourceKey: 'k', mode: 'exclusive', attemptId: 'att_t1' });
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_t1_2', taskId: 't1', revision: 1, attemptNumber: 2, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest } });
    const again = await assemble();
    expect(again.sha).toBe(a.sha);
    const row = (await q(`SELECT status, parts, detail FROM candidates WHERE sha = '${a.sha}'`))[0]!;
    expect(row['status']).toBe('assembled');
    expect((row['parts'] as { attemptId: string }[])[0]!.attemptId).toBe('att_t1_2');
    // The earlier verdict stays as history and is no longer evidence for the rebuilt candidate.
    expect((row['detail'] as { history: { status: string; parts: { attemptId: string }[] }[] }).history).toMatchObject([{ status: 'rejected', parts: [{ attemptId: 'att_t1' }] }]);
    expect(await loadValidRecord(db, artifacts, loadKey(a))).toBeNull();
    const rec = await verifyCandidate(ref(a), deps(async (i) => ok(i)));
    expect(rec.taskOutcomes[0]).toMatchObject({ applied: true, taskStatus: 'verified' });
    expect(await q(`SELECT 1 FROM resource_claims WHERE released_at IS NULL`)).toHaveLength(0);
    expect(await loadValidRecord(db, artifacts, loadKey(a))).toEqual(rec);
  });
});
