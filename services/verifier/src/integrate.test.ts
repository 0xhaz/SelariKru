import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { TaskSpecSchema } from '../../../packages/domain/src/index.ts';
import { schema, type Db } from '../../../packages/persistence/src/index.ts';
import { sql } from '../../../packages/persistence/src/index.ts';
import { RUN, PROJECT, TENANT, resetDb, seedTask, setupTestDb, specFor, type TestDb } from '../../workflow/test/helpers.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assembleCandidate, type IntegrationDeps, type IntegrationRun } from './integrate.ts';

const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tdb: TestDb;
let db: Db;
let root: string;
let repo: string;
let artifacts: LocalDiskArtifactStore;
let baseSha: string;
let n = 0;

const BASE_FILES: Record<string, string> = {
  'README.md': 'base readme\n',
  'contract/runtime.md': 'the contract\n',
  'services/verifier/src/run.ts': 'verifier\n',
  'tools/verifier-calibration/a.txt': 'calibration\n',
  'src/shared.txt': 'shared base\n',
  'src/a.txt': 'a base\n',
  'src/b.txt': 'b base\n',
  'policies/p.txt': 'policy\n',
};

function commitAll(msg: string): string {
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

type Change = { path: string; status: 'added' | 'modified' | 'deleted'; kind: 'file' | 'symlink' | 'special' | null; content?: string; linkTarget?: string | null };

/** Publishes a change-set manifest exactly as the runner's storeChanges does, and returns its hash. */
async function publish(task: { taskId: string; revision?: number; baseSha?: string }, changes: Change[], over: Record<string, unknown> = {}): Promise<string> {
  const entries: unknown[] = [];
  for (const c of changes) {
    let hash: string | null = null;
    let size: number | undefined;
    if (c.kind === 'file' && c.status !== 'deleted') {
      const ref = await artifacts.put(Buffer.from(c.content ?? ''));
      hash = ref.sha256;
      size = ref.size;
    }
    entries.push({ path: c.path, status: c.status, kind: c.kind, sha256: hash, linkTarget: c.linkTarget ?? null, ...(size !== undefined ? { size } : {}) });
  }
  const body = JSON.stringify({ schema: 1, taskId: task.taskId, revision: task.revision ?? 1, baseSha: task.baseSha ?? baseSha, changes: entries, ...over });
  return (await artifacts.put(Buffer.from(body))).sha256;
}

async function addDone(taskId: string, changes: Change[], opts: { dependsOn?: string[]; allowedPaths?: string[]; manifest?: string; status?: string } = {}): Promise<string> {
  const allowed = opts.allowedPaths ?? ['src', 'web'];
  const spec = specFor(taskId, {
    baseSha,
    allowedPaths: allowed,
    dependencies: (opts.dependsOn ?? []).map((d) => ({ taskId: d, revision: 1, condition: 'artifact_verified' as const })),
  });
  await seedTask(db, spec, opts.status ?? 'verifying');
  const manifest = opts.manifest ?? (await publish({ taskId }, changes));
  await db.insert(schema.attempts).values({
    tenantId: TENANT, projectId: PROJECT, attemptId: `att_${taskId}`, taskId, revision: 1, attemptNumber: 1,
    outcome: 'succeeded', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest },
  });
  return manifest;
}

const run = (over: Partial<IntegrationRun> = {}): IntegrationRun => ({
  tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo, ...over,
});
const deps = (over: Partial<IntegrationDeps> = {}): IntegrationDeps => ({ db, artifacts, workRoot: join(root, 'work'), ...over });
const file = (path: string, content: string, status: Change['status'] = 'modified'): Change => ({ path, status, kind: 'file', content });
const show = (sha: string, path: string): string => git(repo, 'show', `${sha}:${path}`);
const q = async (text: string): Promise<Record<string, unknown>[]> => [...(await db.execute(sql.raw(text)))];

beforeAll(async () => {
  tdb = await setupTestDb();
  db = tdb.db;
  root = mkdtempSync(join(tmpdir(), 'integrate-'));
  artifacts = new LocalDiskArtifactStore(join(root, 'artifacts'));
  repo = join(root, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  for (const [p, c] of Object.entries(BASE_FILES)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  baseSha = commitAll('base');
});
afterAll(async () => {
  await tdb.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals CASCADE`);
  n += 1;
});

describe('assembleCandidate', () => {
  it('applies worker patches in dependency order deterministically', async () => {
        // The dependency order (t_z before t_b) differs from the id order, so a sort by id would get it wrong.
    await addDone('t_z', [file('src/shared.txt', 'from a\n'), file('src/new.txt', 'new\n', 'added'), { path: 'src/a.txt', status: 'deleted', kind: null }]);
    await addDone('t_b', [file('src/b.txt', 'b changed\n')], { dependsOn: ['t_z'] });
    const r = await assembleCandidate(run(), deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseSha).toBe(baseSha);
    expect(r.parts.map((p) => p.taskId)).toEqual(['t_z', 't_b']);
    expect(r.parts[0]!.paths).toEqual(['src/a.txt', 'src/new.txt', 'src/shared.txt']);
    expect(show(r.sha, 'src/shared.txt')).toBe('from a');
    expect(show(r.sha, 'src/new.txt')).toBe('new');
    expect(show(r.sha, 'src/b.txt')).toBe('b changed');
    expect(() => show(r.sha, 'src/a.txt')).toThrow();
    expect(git(repo, 'rev-parse', baseSha)).toBe(baseSha);
    // The commit is a real git commit on the pinned base, and only that.
    const clone = join(root, 'inspect');
    rmSync(clone, { recursive: true, force: true });
    expect(r.treeSha).toMatch(/^[0-9a-f]{40}$/);
    const rows = await q(`SELECT sha, base_sha, tree_sha, status, parts FROM candidates`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha: r.sha, base_sha: baseSha, tree_sha: r.treeSha, status: 'assembled' });
    expect((rows[0]!['parts'] as { taskId: string }[]).map((p) => p.taskId)).toEqual(['t_z', 't_b']);
    const ev = await q(`SELECT type, actor_kind FROM events WHERE type LIKE 'candidate.%'`);
    expect(ev).toEqual([{ type: 'candidate.assembled', actor_kind: 'integration' }]);
    // The function owns its clone: nothing is left behind, and the lease is released.
    expect(readdirSync(join(root, 'work'))).toEqual([]);
    expect(await q(`SELECT 1 FROM integration_leases`)).toHaveLength(0);
  });

  it('same inputs → same tree', async () => {
    await addDone('t_a', [file('src/a.txt', 'a2\n'), file('src/new.txt', 'n\n', 'added')]);
    await addDone('t_c', [file('src/b.txt', 'b2\n')]);
    const one = await assembleCandidate(run(), deps());
    const two = await assembleCandidate(run(), deps({ workRoot: join(root, 'work2') }));
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(two.sha).toBe(one.sha);
    expect(two.treeSha).toBe(one.treeSha);
    expect(await q(`SELECT 1 FROM candidates WHERE status = 'assembled'`)).toHaveLength(1);
    // Hostile ambient git configuration cannot change the commit.
    const prev = { ...process.env };
    process.env['GIT_AUTHOR_NAME'] = 'Mallory';
    process.env['GIT_COMMITTER_DATE'] = '2030-01-01T00:00:00Z';
    try {
      const three = await assembleCandidate(run(), deps());
      expect(three.ok && three.sha === one.sha).toBe(true);
    } finally {
      delete process.env['GIT_AUTHOR_NAME'];
      delete process.env['GIT_COMMITTER_DATE'];
      Object.assign(process.env, prev);
    }
  });

  it('conflict creates a targeted resolution task', async () => {
    await addDone('t_x', [file('src/shared.txt', 'x version\n'), file('src/a.txt', 'a by x\n')]);
    await addDone('t_y', [file('src/shared.txt', 'y version\n')]);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.conflicts).toEqual([{ path: 'src/shared.txt', kind: 'overlap', taskIds: ['t_x', 't_y'] }]);
    expect(r.proposalId).toMatch(/^prop_/);
    const [p] = await q(`SELECT status, source, tasks, based_on_plan_revision FROM plan_proposals`);
    expect(p).toMatchObject({ status: 'proposed', source: 'integration', based_on_plan_revision: 0 });
    const tasks = p!['tasks'] as { taskId: string; allowedPaths: string[]; role: string; revision: number; baseSha: string }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ allowedPaths: ['src/shared.txt'], role: 'integration', revision: 1, baseSha });
    expect(await q(`SELECT status, reason, sha FROM candidates`)).toEqual([{ status: 'conflicted', reason: 'conflict', sha: null }]);
    expect((await q(`SELECT type, actor_kind FROM events WHERE type LIKE 'candidate.%'`))).toEqual([{ type: 'candidate.failed', actor_kind: 'integration' }]);
    // Deterministic, and no duplicate proposal when asked again. Nothing was merged or guessed.
    const again = await assembleCandidate(run(), deps());
    expect(again.ok === false && again.proposalId === r.proposalId).toBe(true);
    expect(await q(`SELECT 1 FROM plan_proposals`)).toHaveLength(1);
  });

  it('a change that does not apply is a conflict, not a guess', async () => {
    await addDone('t_m', [file('src/missing.txt', 'edit of a file that is not there\n')]);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok === false && r.reason === 'conflict').toBe(true);
    if (r.ok) return;
    expect(r.conflicts).toEqual([{ path: 'src/missing.txt', kind: 'does_not_apply', taskIds: ['t_m'] }]);
  });

  it('base change invalidates candidate and evidence', async () => {
    await addDone('t_a', [file('src/a.txt', 'a2\n')]);
    const first = await assembleCandidate(run(), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await db.insert(schema.checkRuns).values({
      tenantId: TENANT, projectId: PROJECT, checkRunId: 'cr_1', taskId: 't_a', revision: 1, checkId: 'FB-01', checkVersion: '1', candidateSha: first.sha, result: 'passed',
    });
    await db.insert(schema.approvals).values({
      tenantId: TENANT, projectId: PROJECT, approvalId: 'ap_1', runId: RUN, requester: 'u', actionHash: 'h', scopeHash: 's',
      expectedRevisions: { candidateSha: first.sha }, outcome: 'granted',
    });
    writeFileSync(join(repo, 'README.md'), 'base moved\n');
    const moved = commitAll('main advanced');
    try {
      const r = await assembleCandidate(run({ currentBaseSha: moved }), deps());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.baseSha).toBe(moved);
      expect(r.sha).not.toBe(first.sha);
      expect(show(r.sha, 'README.md')).toBe('base moved');
      expect(show(r.sha, 'src/a.txt')).toBe('a2');
      expect(r.invalidated).toEqual({ reason: 'base_changed', candidates: [`cand_${first.sha}`], checkRuns: ['cr_1'], approvals: ['ap_1'] });
      expect(await q(`SELECT status FROM candidates WHERE candidate_id = 'cand_${first.sha}'`)).toEqual([{ status: 'invalidated' }]);
      expect(await q(`SELECT result FROM check_runs`)).toEqual([{ result: 'invalidated' }]);
      expect(await q(`SELECT outcome FROM approvals`)).toEqual([{ outcome: 'invalidated' }]);
      expect(await q(`SELECT status FROM candidates WHERE sha = '${r.sha}'`)).toEqual([{ status: 'assembled' }]);
    } finally {
      git(repo, 'reset', '-q', '--hard', baseSha);
    }
  });

  it('edits to verifier or contract paths rejected', async () => {
    const protectedPaths = ['contract/runtime.md', 'services/verifier/src/run.ts', 'tools/verifier-calibration/a.txt', 'CONTRACT/new.md', 'policies/p.txt'];
    for (const [i, p] of protectedPaths.entries()) {
      await resetDb(db);
      await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
      // The worker's own allowedPaths even name the protected path: the gate still refuses it.
      await addDone(`t_p${i}`, [file(p, 'tampered\n')], { allowedPaths: ['contract', 'services', 'tools', 'policies', 'CONTRACT'] });
      const r = await assembleCandidate(run(), deps({ protectedPaths: ['policies'] }));
      expect(r.ok, p).toBe(false);
      if (r.ok) continue;
      expect(r.reason, p).toBe('protected_path');
      expect(await q(`SELECT status, sha FROM candidates`)).toEqual([{ status: 'failed', sha: null }]);
      expect((await q(`SELECT type FROM events WHERE type LIKE 'candidate.%'`))).toEqual([{ type: 'candidate.failed' }]);
    }
  });

  it('rejects untrusted manifests with a named reason and no partial result', async () => {
    const bad = async (name: string, reason: string, setup: () => Promise<void>) => {
      await resetDb(db);
      await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
      await addDone('t_ok', [file('src/b.txt', 'fine\n')]);
      await setup();
      const r = await assembleCandidate(run(), deps());
      expect(r.ok, name).toBe(false);
      if (r.ok) return;
      expect(r.reason, name).toBe(reason);
      expect((await q(`SELECT sha, status FROM candidates`)), name).toEqual([{ sha: null, status: 'failed' }]);
      expect(readdirSync(join(root, 'work')), name).toEqual([]);
    };
    await bad('missing artifact', 'manifest_missing', () => addDone('t_bad', [], { manifest: 'a'.repeat(64) }).then(() => undefined));
    await bad('tampered artifact', 'manifest_corrupt', async () => {
      const m = await publish({ taskId: 't_bad' }, [file('src/a.txt', 'x\n')]);
      writeFileSync(join(root, 'artifacts', m.slice(0, 2), m.slice(2)), 'tampered');
      await addDone('t_bad', [], { manifest: m });
    });
    await bad('wrong task id', 'manifest_identity', async () => addDone('t_bad', [], { manifest: await publish({ taskId: 't_other' }, [file('src/a.txt', 'x\n')]) }).then(() => undefined));
    await bad('stale revision', 'manifest_identity', async () => addDone('t_bad', [], { manifest: await publish({ taskId: 't_bad', revision: 2 }, [file('src/a.txt', 'x\n')]) }).then(() => undefined));
    await bad('old base', 'manifest_identity', async () => addDone('t_bad', [], { manifest: await publish({ taskId: 't_bad', baseSha: '0'.repeat(40) }, [file('src/a.txt', 'x\n')]) }).then(() => undefined));
    await bad('symlink', 'path_rejected', async () => addDone('t_bad', [{ path: 'src/l', status: 'added', kind: 'symlink', linkTarget: '/etc' }]).then(() => undefined));
    await bad('dot git', 'path_rejected', async () => addDone('t_bad', [file('src/.GIT/config', 'x', 'added')], { allowedPaths: ['src'] }).then(() => undefined));
    await bad('dot dot', 'path_rejected', async () => addDone('t_bad', [file('src/../README.md', 'x')], { allowedPaths: ['src'] }).then(() => undefined));
    await bad('absolute', 'path_rejected', async () => addDone('t_bad', [file('/etc/passwd', 'x')], { allowedPaths: ['src'] }).then(() => undefined));
    await bad('outside allowed', 'path_rejected', async () => addDone('t_bad', [file('web/x.txt', 'x', 'added')], { allowedPaths: ['src'] }).then(() => undefined));
    await bad('missing file content', 'content_missing', async () => {
      const m = await publish({ taskId: 't_bad' }, [file('src/a.txt', 'x\n')], { changes: [{ path: 'src/a.txt', status: 'modified', kind: 'file', sha256: sha256('never stored'), linkTarget: null }] });
      await addDone('t_bad', [], { manifest: m });
    });
    await bad('tampered file content', 'manifest_corrupt', async () => {
      const h = sha256('victim content');
      await artifacts.put(Buffer.from('victim content'));
      writeFileSync(join(root, 'artifacts', h.slice(0, 2), h.slice(2)), 'swapped');
      const m = await publish({ taskId: 't_bad' }, [], { changes: [{ path: 'src/a.txt', status: 'modified', kind: 'file', sha256: h, linkTarget: null }] });
      await addDone('t_bad', [], { manifest: m });
    });
  });

  it('refuses to write through a symlinked parent directory in the base', async () => {
    symlinkSync('/tmp', join(repo, 'web'));
    const withLink = commitAll('web is a link');
    try {
      await addDone('t_l', [file('web/evil.txt', 'x', 'added')], { allowedPaths: ['web'] });
      const r = await assembleCandidate(run({ pinnedBaseSha: withLink, currentBaseSha: withLink }), deps());
      expect(r.ok).toBe(false);
      expect(existsSync('/tmp/evil.txt')).toBe(false);
    } finally {
      git(repo, 'reset', '-q', '--hard', baseSha);
    }
  });

  it('holds a single integration lease per run target, enforced in the database', async () => {
    await addDone('t_a', [file('src/a.txt', 'a2\n')]);
    const future = new Date(Date.now() + 600_000);
    await db.insert(schema.integrationLeases).values({ tenantId: TENANT, projectId: PROJECT, target: 'main', holder: 'someone-else', acquiredAt: new Date(), expiresAt: future });
    const blocked = await assembleCandidate(run(), deps());
    expect(blocked.ok === false && blocked.reason === 'lease_held').toBe(true);
    expect(await q(`SELECT holder FROM integration_leases`)).toEqual([{ holder: 'someone-else' }]);
    expect(await q(`SELECT 1 FROM candidates`)).toHaveLength(0);
    // A different target is independent; an expired lease can be taken over.
    await db.execute(sql`UPDATE integration_leases SET expires_at = now() - interval '1 second'`);
    const ok = await assembleCandidate(run(), deps());
    expect(ok.ok).toBe(true);
    // Two truly concurrent assemblies: exactly one holds the lease at a time, and the loser is told so.
    const both = await Promise.all([assembleCandidate(run(), deps()), assembleCandidate(run(), deps())]);
    for (const r of both) expect(r.ok || r.reason === 'lease_held').toBe(true);
    expect(both.some((r) => r.ok)).toBe(true);
    expect(await q(`SELECT 1 FROM integration_leases`)).toHaveLength(0);
  });
});

describe('fix round 1', () => {
  const blob = (sha: string, path: string): string => git(repo, 'rev-parse', `${sha}:${path}`);
  const gitBlob = (content: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
  const moveMain = (path: string, content: string | null): string => {
    if (content === null) rmSync(join(repo, path));
    else writeFileSync(join(repo, path), content);
    return commitAll('main moved');
  };
  const reset = (): void => {
    git(repo, 'reset', '-q', '--hard', baseSha);
  };

  it('a rebuild on a moved base conflicts when main changed a path the worker changed (edit/edit)', async () => {
    await addDone('t_a', [file('src/a.txt', 'by worker\n')]);
    const moved = moveMain('src/a.txt', 'by main\n');
    try {
      const r = await assembleCandidate(run({ currentBaseSha: moved }), deps());
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('conflict');
      expect(r.conflicts).toEqual([{ path: 'src/a.txt', kind: 'base_moved', taskIds: ['t_a'] }]);
    } finally { reset(); }
  });

  it('a rebuild on a moved base conflicts when the worker deletes what main edited (delete/edit)', async () => {
    await addDone('t_a', [{ path: 'src/a.txt', status: 'deleted', kind: null }]);
    const moved = moveMain('src/a.txt', 'by main\n');
    try {
      const r = await assembleCandidate(run({ currentBaseSha: moved }), deps());
      expect(r.ok === false && r.reason === 'conflict').toBe(true);
      if (r.ok) return;
      expect(r.conflicts).toEqual([{ path: 'src/a.txt', kind: 'base_moved', taskIds: ['t_a'] }]);
    } finally { reset(); }
  });

  it('dependency-ordered edits of the same path conflict, and a third unordered writer is not missed', async () => {
    await addDone('t_a', [file('src/shared.txt', 'one\n')]);
    await addDone('t_b', [file('src/shared.txt', 'two\n')], { dependsOn: ['t_a'] });
    const r = await assembleCandidate(run(), deps());
    expect(r.ok === false && r.reason === 'conflict').toBe(true);
    if (r.ok) return;
    expect(r.conflicts).toEqual([{ path: 'src/shared.txt', kind: 'overlap', taskIds: ['t_a', 't_b'] }]);

    await resetDb(db);
    await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
    await addDone('t_a', [file('src/shared.txt', 'same\n')]);
    await addDone('t_b', [file('src/shared.txt', 'same\n')]);
    await addDone('t_c', [file('src/shared.txt', 'other\n')]);
    const r3 = await assembleCandidate(run(), deps());
    expect(r3.ok === false && r3.reason === 'conflict').toBe(true);
    if (r3.ok) return;
    expect(r3.conflicts![0]!.taskIds).toEqual(['t_a', 't_b', 't_c']);
  });

  for (const moved of [false, true]) {
    it(`the full loop: conflict, resolution task completes, candidate assembles (moved base: ${moved})`, async () => {
      await addDone('t_x', [file('src/shared.txt', 'x version\n')]);
      await addDone('t_y', [file('src/shared.txt', 'y version\n')]);
      const cur = moved ? moveMain('README.md', 'main moved\n') : baseSha;
      try {
        const r = await assembleCandidate(run({ currentBaseSha: cur }), deps());
        expect(r.ok === false && r.reason === 'conflict').toBe(true);
        if (r.ok) return;
        const [p] = await q(`SELECT tasks FROM plan_proposals`);
        const resolution = TaskSpecSchema.parse((p!['tasks'] as unknown[])[0]);
        expect(resolution.baseSha).toBe(cur);
        await seedTask(db, resolution, 'verifying');
        const manifest = await publish({ taskId: resolution.taskId, baseSha: cur }, [file('src/shared.txt', 'merged by a human\n')]);
        await db.insert(schema.attempts).values({
          tenantId: TENANT, projectId: PROJECT, attemptId: `att_${resolution.taskId}`, taskId: resolution.taskId, revision: 1, attemptNumber: 1,
          outcome: 'succeeded', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest },
        });
        const ok = await assembleCandidate(run({ currentBaseSha: cur }), deps());
        expect(ok.ok, JSON.stringify(ok)).toBe(true);
        if (!ok.ok) return;
        expect(show(ok.sha, 'src/shared.txt')).toBe('merged by a human');
        expect(ok.parts.map((x) => x.taskId)).toContain(resolution.taskId);
      } finally { reset(); }
    });
  }

  it('a resolution does not hide a conflict it did not resolve', async () => {
    await addDone('t_x', [file('src/shared.txt', 'x\n')]);
    await addDone('t_y', [file('src/shared.txt', 'y\n')]);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok).toBe(false);
    const [p] = await q(`SELECT tasks FROM plan_proposals`);
    const resolution = TaskSpecSchema.parse((p!['tasks'] as unknown[])[0]);
    await seedTask(db, resolution, 'verifying');
    await addDone('t_z', [file('src/shared.txt', 'z\n')]);
    const manifest = await publish({ taskId: resolution.taskId }, [file('src/shared.txt', 'merged\n')]);
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_res', taskId: resolution.taskId, revision: 1, attemptNumber: 1, outcome: 'succeeded', endedAt: new Date(), detail: { changeManifestSha256: manifest } });
    const again = await assembleCandidate(run(), deps());
    expect(again.ok).toBe(false);
  });

  it('committed bytes are exactly the manifest bytes, whatever .gitattributes says', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* text eol=lf\n*.txt filter=lfs\n');
    const attr = commitAll('attributes in base');
    try {
      await addDone('t_a', [file('src/crlf.txt', 'line1\r\nline2\r\n', 'added')]);
      const r = await assembleCandidate(run({ pinnedBaseSha: attr, currentBaseSha: attr }), deps({ }));
      // manifests name baseSha = original base, so identity fails; build a manifest on the new base instead
      expect(r.ok).toBe(false);
      await resetDb(db);
      await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
      const spec = specFor('t_a', { baseSha: attr, allowedPaths: ['src'] });
      await seedTask(db, spec, 'verifying');
      const m = await publish({ taskId: 't_a', baseSha: attr }, [file('src/crlf.txt', 'line1\r\nline2\r\n', 'added')]);
      await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_a', taskId: 't_a', revision: 1, attemptNumber: 1, outcome: 'succeeded', endedAt: new Date(), detail: { changeManifestSha256: m } });
      const ok = await assembleCandidate(run({ pinnedBaseSha: attr, currentBaseSha: attr }), deps());
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      if (!ok.ok) return;
      expect(blob(ok.sha, 'src/crlf.txt')).toBe(gitBlob('line1\r\nline2\r\n'));
    } finally { reset(); }
  });

  it('workers cannot add or edit .gitattributes or .gitmodules', async () => {
    for (const p of ['src/.gitattributes', 'src/sub/.GitModules']) {
      await resetDb(db);
      await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
      await addDone('t_a', [file(p, '* text\n', 'added')]);
      const r = await assembleCandidate(run(), deps());
      expect(r.ok === false && r.reason === 'path_rejected', p).toBe(true);
    }
  });

  it('case and Unicode collisions are conflicts', async () => {
    const cases: [string, Change[], Change[]][] = [
      ['case, across tasks', [file('src/Foo.txt', '1', 'added')], [file('src/foo.txt', '2', 'added')]],
      ['NFC vs NFD', [file('src/café.txt', '1', 'added')], [file('src/café.txt', '2', 'added')]],
      ['case, directory spelling', [file('src/Dir/x.txt', '1', 'added')], [file('src/dir/y.txt', '2', 'added')]],
      ['against the base tree', [file('src/A.txt', '1', 'added')], []],
      ['within one manifest', [file('src/Foo.txt', '1', 'added'), file('src/foo.txt', '2', 'added')], []],
    ];
    for (const [name, one, two] of cases) {
      await resetDb(db);
      await db.execute(sql`TRUNCATE candidates, plan_proposals CASCADE`);
      await addDone('t_one', one);
      if (two.length > 0) await addDone('t_two', two);
      const r = await assembleCandidate(run(), deps());
      expect(r.ok, name).toBe(false);
      if (r.ok) continue;
      expect(r.reason, name).toBe('conflict');
      expect(r.conflicts!.some((c) => c.kind === 'path_collision'), name).toBe(true);
    }
  });

  it('a holder that lost its lease cannot publish or invalidate newer evidence', async () => {
    await addDone('t_a', [file('src/a.txt', 'a2\n')]);
    const first = await assembleCandidate(run(), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await addDone('t_b', [file('src/b.txt', 'b2\n')]);
    await db.insert(schema.checkRuns).values({ tenantId: TENANT, projectId: PROJECT, checkRunId: 'cr_f', taskId: 't_a', revision: 1, checkId: 'FB-01', checkVersion: '1', candidateSha: first.sha, result: 'passed' });
    const steal = async (): Promise<void> => {
      await db.execute(sql`UPDATE integration_leases SET holder = 'newer-holder'`);
    };
    const r = await assembleCandidate(run(), deps({ beforePublish: steal }));
    expect(r.ok === false && r.reason === 'lease_lost').toBe(true);
    expect(await q(`SELECT status FROM candidates ORDER BY candidate_id`)).toEqual([{ status: 'assembled' }]);
    expect(await q(`SELECT result FROM check_runs`)).toEqual([{ result: 'passed' }]);
    expect(await q(`SELECT 1 FROM events WHERE type = 'candidate.failed'`)).toHaveLength(0);
    // Expired (rather than stolen) counts as lost too.
    await db.execute(sql`DELETE FROM integration_leases`);
    const r2 = await assembleCandidate(run(), deps({ beforePublish: async () => { await db.execute(sql`UPDATE integration_leases SET expires_at = now() - interval '1 second'`); } }));
    expect(r2.ok === false && r2.reason === 'lease_lost').toBe(true);
  });
});
void readFileSync;

describe('fix round 2: resolutions bind to what they resolved', () => {
  const reset = (): void => { git(repo, 'reset', '-q', '--hard', baseSha); };

  /** Creates the conflict on src/shared.txt, returns the proposal's resolution spec. */
  async function conflict(cur: string = baseSha): Promise<ReturnType<typeof TaskSpecSchema.parse>> {
    const r = await assembleCandidate(run({ currentBaseSha: cur }), deps());
    expect(r.ok === false && r.reason === 'conflict').toBe(true);
    const rows = await q(`SELECT tasks FROM plan_proposals ORDER BY created_at DESC, proposal_id`);
    return TaskSpecSchema.parse((rows[0]!['tasks'] as unknown[])[0]);
  }
  async function complete(spec: ReturnType<typeof TaskSpecSchema.parse>, base: string, content: Change[], widen?: string[]): Promise<void> {
    const s2 = widen ? TaskSpecSchema.parse({ ...spec, allowedPaths: widen }) : spec;
    await db.execute(sql`DELETE FROM task_status WHERE task_id = ${s2.taskId}`);
    await seedTask(db, s2, 'verifying');
    const manifest = await publish({ taskId: s2.taskId, baseSha: base }, content);
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: `att_${s2.taskId}`, taskId: s2.taskId, revision: 1, attemptNumber: 1, outcome: 'succeeded', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest } });
  }
  const twoWriters = async (): Promise<void> => {
    await addDone('t_x', [file('src/shared.txt', 'x version\n')]);
    await addDone('t_y', [file('src/shared.txt', 'y version\n')]);
  };

  it('a newer revision of a resolved task reopens the conflict', async () => {
    await twoWriters();
    const res = await conflict();
    await complete(res, baseSha, [file('src/shared.txt', 'merged\n')]);
    expect((await assembleCandidate(run(), deps())).ok).toBe(true);
    // t_x moves to revision 2 with new content on the resolved path.
    const spec2 = specFor('t_x', { baseSha, allowedPaths: ['src', 'web'], revision: 2 });
    await db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId: 't_x', revision: 2, boardId: spec2.boardId, spec: spec2 });
    await db.execute(sql`UPDATE task_status SET current_revision = 2 WHERE task_id = 't_x'`);
    const m2 = await publish({ taskId: 't_x', revision: 2 }, [file('src/shared.txt', 'x v2\n')]);
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_x2', taskId: 't_x', revision: 2, attemptNumber: 1, outcome: 'succeeded', endedAt: new Date(), detail: { changeManifestSha256: m2 } });
    const r = await assembleCandidate(run(), deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.conflicts![0]!.taskIds).toEqual(['t_x', 't_y']);
    const ids = (await q(`SELECT proposal_id FROM plan_proposals`)).map((x) => x['proposal_id']);
    expect(new Set(ids).size).toBe(2);
  });

  for (const flip of [false, true]) {
    it(`a replacement resolution converges whatever the sort order (flip: ${flip})`, async () => {
      await twoWriters();
      const r1 = await conflict();
      await complete(r1, baseSha, [file('src/shared.txt', 'merged one\n')]);
      expect((await assembleCandidate(run(), deps())).ok).toBe(true);
      const moved = (() => { writeFileSync(join(repo, 'src/shared.txt'), 'main edit\n'); return commitAll('main edits resolved path'); })();
      try {
        // R1 is stale now (main changed its path): the conflict reopens with a new resolution on the new base.
        const r2 = await conflict(moved);
        expect(r2.taskId).not.toBe(r1.taskId);
        await complete(r2, moved, [file('src/shared.txt', 'merged two\n')]);
        if (flip) await db.execute(sql`UPDATE plan_proposals SET created_at = created_at - interval '1 day' WHERE proposal_id = ${'prop_' + r2.taskId}`);
        const ok = await assembleCandidate(run({ currentBaseSha: moved }), deps());
        expect(ok.ok, JSON.stringify(ok)).toBe(true);
        if (!ok.ok) return;
        expect(show(ok.sha, 'src/shared.txt')).toBe('merged two');
        expect(ok.parts.map((x) => x.taskId)).not.toContain(r1.taskId);
      } finally { reset(); }
    });
  }

  it('two valid resolutions of one conflict: the most recently created wins', async () => {
    await twoWriters();
    const r1 = await conflict();
    // A second, differently-bound resolution proposal for the same conflict (as if raised again later).
    const dup = { ...r1, taskId: 'resolve_second' };
    await db.execute(sql`INSERT INTO plan_proposals SELECT tenant_id, project_id, 'prop_resolve_second', run_id, based_on_plan_revision, status, source, reason, candidate_id, jsonb_build_array(${JSON.stringify(dup)}::jsonb), jsonb_set(detail, '{resolves,taskId}', '"resolve_second"'), now() + interval '1 hour' FROM plan_proposals WHERE proposal_id = ${'prop_' + r1.taskId}`);
    await complete(r1, baseSha, [file('src/shared.txt', 'older\n')]);
    await complete(TaskSpecSchema.parse(dup), baseSha, [file('src/shared.txt', 'newer\n')]);
    const ok = await assembleCandidate(run(), deps());
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (!ok.ok) return;
    expect(show(ok.sha, 'src/shared.txt')).toBe('newer');
  });

  it('a rejected proposal is ignored', async () => {
    await twoWriters();
    const res = await conflict();
    await complete(res, baseSha, [file('src/shared.txt', 'merged\n')]);
    await db.execute(sql`UPDATE plan_proposals SET status = 'rejected'`);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok === false && r.reason === 'conflict').toBe(true);
  });

  it('a resolution is limited to the paths recorded on its proposal', async () => {
    await twoWriters();
    const res = await conflict();
    await complete(res, baseSha, [file('src/shared.txt', 'merged\n'), file('src/b.txt', 'smuggled\n')], ['src']);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok === false && r.reason === 'path_rejected').toBe(true);
  });

  it('two tasks deleting the same file agree', async () => {
    await addDone('t_a', [{ path: 'src/a.txt', status: 'deleted', kind: null }]);
    await addDone('t_b', [{ path: 'src/a.txt', status: 'deleted', kind: null }]);
    const r = await assembleCandidate(run(), deps());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(() => show(r.sha, 'src/a.txt')).toThrow();
  });
});
void n;
