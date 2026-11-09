import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { schema, sql, type Db } from '../../../packages/persistence/src/index.ts';
import { PROJECT, RUN, TENANT, resetDb, seedTask, setupTestDb, specFor, type TestDb } from '../../workflow/test/helpers.ts';
import { createAssemblyDriver } from './assembly-driver.ts';
import { assembleCandidate } from './integrate.ts';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tdb: TestDb;
let db: Db;
let root: string;
let repo: string;
let artifacts: LocalDiskArtifactStore;
let baseSha: string;

const q = async (text: string) => [...(await db.execute(sql.raw(text)))];

async function publish(taskId: string, files: Record<string, string>, base: string, revision = 1): Promise<string> {
  const entries: unknown[] = [];
  for (const [path, content] of Object.entries(files)) {
    const ref = await artifacts.put(Buffer.from(content));
    entries.push({ path, status: 'added', kind: 'file', sha256: ref.sha256, linkTarget: null, size: ref.size });
  }
  return (await artifacts.put(Buffer.from(JSON.stringify({ schema: 1, taskId, revision, baseSha: base, changes: entries })))).sha256;
}

/** A task with a finished attempt: status `verifying`, a published change set. */
async function finished(taskId: string, files: Record<string, string>, over: Parameters<typeof specFor>[1] = {}, attempt = 1): Promise<void> {
  await seedTask(db, specFor(taskId, { baseSha, allowedPaths: ['src'], ...over }), 'verifying');
  const manifest = await publish(taskId, files, baseSha);
  await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: `att_${taskId}_${attempt}`, taskId, revision: 1, attemptNumber: attempt, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest } });
}
const options = (over = {}) => ({ db, artifacts, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'work'), ...over });
const statusOf = async (id: string) => String((await q(`SELECT status FROM task_status WHERE task_id = '${id}'`))[0]!['status']);
const events = async (type: string) => (await q(`SELECT 1 FROM events WHERE type = '${type}'`)).length;

beforeAll(async () => {
  tdb = await setupTestDb();
  db = tdb.db;
  root = mkdtempSync(join(tmpdir(), 'assembly-driver-'));
  artifacts = new LocalDiskArtifactStore(join(root, 'artifacts'));
  repo = join(root, 'source');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'src/base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD');
});
afterAll(async () => { await tdb.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals CASCADE`);
});

describe('assembly driver', () => {
  it('verified workers produce one assembled candidate', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    await finished('t2', { 'src/b.txt': 'b\n' });
    const driver = createAssemblyDriver(options());
    const tick = await driver.tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    const rows = await q(`SELECT sha, parts, status FROM candidates`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'assembled', sha: tick.assembled[0] });
    expect((rows[0]!['parts'] as { taskId: string; attemptId: string }[]).map((p) => p.taskId)).toEqual(['t1', 't2']);
    // Level-triggered: nothing further is written while the same parts are live, and a restarted driver agrees.
    expect(await createAssemblyDriver(options()).tick()).toEqual({ assembled: [], failed: [] });
    expect(await q(`SELECT 1 FROM candidates`)).toHaveLength(1);
    expect(await events('candidate.assembled')).toBe(1);
  });

  it('two concurrent passes assemble once', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    await Promise.all([createAssemblyDriver(options()).tick(), createAssemblyDriver(options()).tick()]);
    expect(await events('candidate.assembled')).toBe(1);
    expect(await q(`SELECT 1 FROM candidates`)).toHaveLength(1);
  });

  it('waits for an unfinished sibling that belongs in the candidate', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    await seedTask(db, specFor('t2', { baseSha, allowedPaths: ['src'] }), 'ready');
    expect((await createAssemblyDriver(options()).tick()).assembled).toEqual([]);
    expect(await q(`SELECT 1 FROM candidates`)).toHaveLength(0);
    await db.execute(sql`UPDATE task_status SET status = 'cancelled' WHERE task_id = 't2'`);
    expect((await createAssemblyDriver(options()).tick()).assembled).toHaveLength(1);
  });

  it('partial candidate assembled for artifact_verified edge', async () => {
    await finished('contract', { 'src/contract.txt': 'c\n' });
    // The dependent cannot start until `contract` is verified, so it can never be in the candidate that verifies it.
    await seedTask(db, specFor('dependent', { baseSha, allowedPaths: ['src'], dependencies: [{ taskId: 'contract', revision: 1, condition: 'artifact_verified' }] }), 'planned');
    const tick = await createAssemblyDriver(options()).tick();
    expect(tick.assembled).toHaveLength(1);
    const parts = (await q(`SELECT parts FROM candidates WHERE status = 'assembled'`))[0]!['parts'] as { taskId: string }[];
    expect(parts.map((p) => p.taskId)).toEqual(['contract']);
    expect(await statusOf('dependent')).toBe('planned');
  });

  it('a candidate retired for a part that is no longer live has its other parts picked up', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    await finished('t2', { 'src/b.txt': 'b\n' });
    await createAssemblyDriver(options()).tick();
    await db.execute(sql`UPDATE candidates SET status = 'invalidated', reason = 'candidate_part_not_live'`);
    await db.execute(sql`UPDATE task_status SET status = 'cancelled' WHERE task_id = 't2'`);
    const tick = await createAssemblyDriver(options()).tick();
    expect(tick.assembled).toHaveLength(1);
    const parts = (await q(`SELECT parts FROM candidates WHERE status = 'assembled'`))[0]!['parts'] as { taskId: string }[];
    expect(parts.map((p) => p.taskId)).toEqual(['t1']);
  });

  it('a new attempt of a part replaces the live candidate', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    await createAssemblyDriver(options()).tick();
    await db.execute(sql`UPDATE attempts SET outcome = 'interrupted' WHERE task_id = 't1'`);
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_t1_2', taskId: 't1', revision: 1, attemptNumber: 2, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: await publish('t1', { 'src/a.txt': 'a2\n' }, baseSha) } });
    const tick = await createAssemblyDriver(options()).tick();
    expect(tick.assembled).toHaveLength(1);
    const parts = (await q(`SELECT parts FROM candidates WHERE status = 'assembled'`))[0]!['parts'] as { attemptId: string }[];
    expect(parts.map((p) => p.attemptId)).toEqual(['att_t1_2']);
  });

  it('a failed or conflicted assembly is left alone until its inputs change, and one failure does not stop another run', async () => {
    await finished('t1', { 'src/same.txt': 'one\n' });
    await finished('t2', { 'src/same.txt': 'two\n' });
    const driver = createAssemblyDriver(options());
    const first = await driver.tick();
    expect(first.failed).toEqual([{ runId: RUN, reason: 'conflict' }]);
    expect(await events('candidate.failed')).toBe(1);
    // The same inputs on later polls: no new row, no new event.
    for (let i = 0; i < 3; i += 1) expect(await driver.tick()).toEqual({ assembled: [], failed: [] });
    expect(await events('candidate.failed')).toBe(1);

    // A new attempt of a part changes the inputs: the run is judged again.
    await db.execute(sql`UPDATE attempts SET outcome = 'interrupted' WHERE task_id = 't2'`);
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_t2_2', taskId: 't2', revision: 1, attemptNumber: 2, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: await publish('t2', { 'src/other.txt': 'two\n' }, baseSha) } });
    const second = await driver.tick();
    expect(second.assembled).toHaveLength(1);

    // Another run's failure does not stop this tick's work.
    await db.execute(sql`TRUNCATE candidates CASCADE`);
    await resetDb(db);
    await db.insert(schema.runs).values({ tenantId: TENANT, projectId: PROJECT, runId: 'run_other', lifecycle: 'running', budget: { limitUsd: 10 } });
    await finished('bad', { 'src/x.txt': 'x\n' }, { runId: 'run_other' });
    await finished('good', { 'src/g.txt': 'g\n' });
    await db.execute(sql`UPDATE task_revisions SET spec = jsonb_set(spec, '{title}', 'null'::jsonb) WHERE task_id = 'bad'`);
    const failure = await createAssemblyDriver(options()).tick().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([expect.stringContaining('run run_other:')]);
    expect((await q(`SELECT 1 FROM candidates WHERE status = 'assembled' AND run_id = '${RUN}'`))).toHaveLength(1);
  });

  it('a new tip re-judges a failed assembly', async () => {
    await finished('t1', { 'src/same.txt': 'one\n' });
    await finished('t2', { 'src/same.txt': 'two\n' });
    const driver = createAssemblyDriver(options());
    await driver.tick();
    writeFileSync(join(repo, 'src/more.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tip moved');
    const moved = git(repo, 'rev-parse', 'HEAD');
    try {
      expect(await events('candidate.failed')).toBe(1);
      await driver.tick();
      expect(await events('candidate.failed')).toBe(2);
    } finally {
      git(repo, 'reset', '-q', '--hard', baseSha);
    }
    expect(moved).not.toBe(baseSha);
  });

  it('a candidate_verified dependent is held by the part it waits on, so the plan cannot deadlock', async () => {
    await finished('first', { 'src/first.txt': 'f\n' });
    await seedTask(db, specFor('later', { baseSha, allowedPaths: ['src'], dependencies: [{ taskId: 'first', revision: 1, condition: 'candidate_verified' }] }), 'planned');
    await seedTask(db, specFor('after_later', { baseSha, allowedPaths: ['src'], dependencies: [{ taskId: 'later', revision: 1, condition: 'artifact_verified' }] }), 'planned');
    expect((await createAssemblyDriver(options()).tick()).assembled).toHaveLength(1);
    const parts = (await q(`SELECT parts FROM candidates WHERE status = 'assembled'`))[0]!['parts'] as { taskId: string }[];
    expect(parts.map((p) => p.taskId)).toEqual(['first']);
  });

  describe('infrastructure failures', () => {
    let clock: Date;
    const later = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };
    const retrying = () => q(`SELECT reason, detail FROM candidates WHERE status = 'retrying'`);
    const countEvents = (type: string) => events(type);
    beforeEach(() => { clock = new Date('2026-11-09T03:00:00Z'); });
    const driver = (over = {}) => createAssemblyDriver(options({ now: () => clock, maxInfrastructureRetries: 2, infrastructureBackoffSeconds: 60, ...over }));
    const artifactRoot = () => join(root, 'artifacts');

    it('a restored artifact directory recovers on a later tick, with no failure row and no event in between', async () => {
      await finished('t1', { 'src/a.txt': 'a\n' });
      const moved = `${artifactRoot()}-moved`;
      renameSync(artifactRoot(), moved);
      try {
        const d = driver();
        const first = await d.tick();
        expect(first).toEqual({ assembled: [], failed: [], retrying: [{ runId: RUN, reason: 'manifest_missing' }] });
        expect(await q(`SELECT 1 FROM candidates WHERE status IN ('failed', 'conflicted')`)).toHaveLength(0);
        expect(await countEvents('candidate.failed')).toBe(0);
        // Waits out the delay: no work, nothing written.
        expect(await d.tick()).toEqual({ assembled: [], failed: [] });
        expect(await countEvents('candidate.failed')).toBe(0);
      } finally {
        renameSync(moved, artifactRoot());
      }
      later(61);
      const recovered = await driver().tick();
      expect(recovered.assembled).toHaveLength(1);
      expect(await retrying()).toHaveLength(0);
      expect(await statusOf('t1')).toBe('verifying');
    });

    it('reports each scheduled retry once, with run ID, reason and count, and not on a waiting poll', async () => {
      await finished('t1', { 'src/a.txt': 'a\n' });
      const seen: unknown[] = [];
      const moved = `${artifactRoot()}-moved`;
      renameSync(artifactRoot(), moved);
      try {
        const d = driver({ onRetry: (r: unknown) => seen.push(r) });
        await d.tick();
        await d.tick(); // still waiting out the delay
        expect(seen).toEqual([{ runId: RUN, reason: 'manifest_missing', count: 1, maxRetries: 2 }]);
        later(61);
        await d.tick();
        expect(seen).toHaveLength(2);
        expect(seen[1]).toMatchObject({ count: 2 });
      } finally {
        renameSync(moved, artifactRoot());
      }
    });

    it('when the retries run out the parts reach blocked with one event, and the owner sees the reason', async () => {
      await finished('t1', { 'src/a.txt': 'a\n' });
      const moved = `${artifactRoot()}-moved`;
      renameSync(artifactRoot(), moved);
      try {
        const d = driver();
        expect((await d.tick()).retrying).toBeDefined(); // try 1
        later(61);
        expect((await d.tick()).retrying).toBeDefined(); // retry 1
        later(121);
        const last = await d.tick(); // retry 2, the last one
        expect(last.failed).toEqual([{ runId: RUN, reason: 'assembly_infrastructure:manifest_missing' }]);
        expect(await statusOf('t1')).toBe('blocked');
        expect(await countEvents('candidate.failed')).toBe(0);
        const blocked = await q(`SELECT payload FROM events WHERE type = 'task.blocked' AND task_id = 't1'`);
        expect(blocked).toEqual([{ payload: { reason: 'assembly_infrastructure:manifest_missing' } }]);
        expect(await retrying()).toHaveLength(0);
        // No worker is redone, and a later poll leaves it alone.
        expect(await q(`SELECT outcome FROM attempts WHERE task_id = 't1'`)).toEqual([{ outcome: 'interrupted' }]);
        later(3600);
        expect(await d.tick()).toEqual({ assembled: [], failed: [] });
      } finally {
        renameSync(moved, artifactRoot());
      }
    });

    it('a tip that cannot be read is an infrastructure failure too, with the retry count kept per set of parts', async () => {
      await finished('t1', { 'src/a.txt': 'a\n' });
      git(repo, 'branch', '-m', 'main', 'renamed');
      try {
        expect(await driver().tick()).toEqual({ assembled: [], failed: [], retrying: [{ runId: RUN, reason: 'base_unavailable' }] });
        const count = () => (retrying().then((r) => (r[0]!['detail'] as { retry: { count: number } }).retry.count));
        expect(await count()).toBe(1);
      } finally {
        git(repo, 'branch', '-m', 'renamed', 'main');
      }
      later(61);
      expect((await driver().tick()).assembled).toHaveLength(1);
    });

    it('a deterministic reason is still a verdict on these inputs and is not retried', async () => {
      await finished('t1', { 'src/same.txt': 'one\n' });
      await finished('t2', { 'src/same.txt': 'two\n' });
      const d = driver();
      expect((await d.tick()).failed).toEqual([{ runId: RUN, reason: 'conflict' }]);
      later(3600);
      expect(await d.tick()).toEqual({ assembled: [], failed: [] });
      expect(await countEvents('candidate.failed')).toBe(1);
      expect(await retrying()).toHaveLength(0);
    });
  });

  it('assemble is fenced by stillDue: a failed recheck writes nothing', async () => {
    await finished('t1', { 'src/a.txt': 'a\n' });
    const r = await assembleCandidate({ tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo }, { db, artifacts, workRoot: join(root, 'work'), stillDue: async () => false });
    expect(r).toMatchObject({ ok: false, reason: 'not_due' });
    expect(await q(`SELECT 1 FROM candidates`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM integration_leases`)).toHaveLength(0);
  });
});
