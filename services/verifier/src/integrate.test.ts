import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
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
    // Inserted in reverse order on purpose: b depends on a, so a applies first and b's edit of the shared file wins.
    // The dependency order (t_z before t_b) differs from the id order, so a sort by id would get it wrong.
    await addDone('t_z', [file('src/shared.txt', 'from a\n'), file('src/new.txt', 'new\n', 'added'), { path: 'src/a.txt', status: 'deleted', kind: null }]);
    await addDone('t_b', [file('src/shared.txt', 'from b\n'), file('src/b.txt', 'b changed\n')], { dependsOn: ['t_z'] });
    const r = await assembleCandidate(run(), deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseSha).toBe(baseSha);
    expect(r.parts.map((p) => p.taskId)).toEqual(['t_z', 't_b']);
    expect(r.parts[0]!.paths).toEqual(['src/a.txt', 'src/new.txt', 'src/shared.txt']);
    expect(show(r.sha, 'src/shared.txt')).toBe('from b');
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
void readFileSync;
void n;
