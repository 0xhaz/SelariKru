/**
 * Architecture section 6 rule 8: if main advances, rebuild the candidate and rerun affected gates. Real assembly and verification drivers against real git commits on the source repository's main.
 * An open pull request does not stop it: the old one is left for a person to close, and the screens say it is out of date.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRun } from '@selarikru/integrations-github';
import { failingOn, passing, post, PROJECT, sql, TENANT, World, type RunnerInput } from './world.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createGhCliPort } from '@selarikru/integrations-github';
import { loadValidRecord } from '../../services/verifier/src/service.ts';
import { toViewSnapshot } from '../../packages/data-source-live/src/snapshot.ts';
import { buildDecisions } from '../../apps/control-web/src/features/decisions/model.ts';
import { buildEvidence } from '../../apps/control-web/src/features/evidence/model.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const valid = (sha: string) => loadValidRecord(w.t.db, w.store(), { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: w.trusted() });
const pr = (runId: string) => post(w.app, `/v1/runs/${runId}/pull-request`, {});
const live = () => w.t.db.execute(sql`SELECT sha, base_sha, detail FROM candidates WHERE status = 'assembled' AND sha IS NOT NULL`);
const attempts = () => w.t.db.execute(sql`SELECT attempt_id, attempt_number FROM attempts ORDER BY attempt_number`);
let landings = 0;
const landOnMain = () => w.gitCommit('src/landed.ts', `export const landed = ${++landings};\n`);
/** What a person actually reads: the live snapshot through the real conversion, into the real Decisions and Evidence models. */
async function views(runId: string) {
  const snapshot = toViewSnapshot(await w.snapshot());
  const card = buildDecisions(snapshot, Date.now(), { mode: 'live', connection: 'live' }).cards.find((c) => c.id === `review:${runId}`)!;
  const report = buildEvidence(snapshot, runId)!;
  return { card, merged: report.states.find((x) => x.key === 'merged')! };
}

describe('main moves past a run that has no open pull request', () => {
  it('at ready_for_review: rebuilt on the new tip, re-verified with no worker redone, one live candidate throughout', async () => {
    const { runId, sha: old } = await w.verifiedRun(['t_a']);
    const before = await attempts();
    const tip = landOnMain();

    const tick = await w.assembly().tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    const fresh = tick.assembled[0]!;
    expect(fresh).not.toBe(old);
    expect(await live()).toMatchObject([{ sha: fresh, base_sha: tip }]);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_a')).status).toBe('verifying');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await attempts()).toEqual(before);
    expect((await pr(runId)).body.error.details.reason).toBe('run_not_ready');

    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await attempts()).toEqual(before);
    const opened = await pr(runId);
    expect(opened.status).toBe(200);
    expect(opened.body.candidateSha).toBe(fresh);

    // The next pass finds it current and does nothing.
    const eventsNow = await w.count('events');
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect(await w.count('events')).toBe(eventsNow);
  });

  it('a failed verdict on the rebuild blocks the task and starts no worker', async () => {
    const { runId } = await w.verifiedRun(['t_f']);
    const before = await attempts();
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.status('t_f')).status).toBe('blocked');
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('reverification_failed');
    expect((await w.api().claim()).lease).toBeNull();
    expect(await attempts()).toEqual(before);
    expect(await w.lifecycle(runId)).toBe('running');
  });

  it('a rebuild that conflicts goes to a targeted resolution proposal, once, and leaves no live candidate', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_c')]);
    await w.claimAndComplete('t_c');
    const old = (await w.assembly().tick()).assembled[0]!;
    await w.verification(passing).tick();
    expect(await valid(old)).not.toBeNull();
    w.gitCommit('src/t_c.ts', 'export const v = "main wrote this";\n');

    const tick = await w.assembly().tick();
    expect(tick.assembled).toEqual([]);
    expect(tick.failed).toEqual([{ runId, reason: 'conflict' }]);
    expect(await live()).toHaveLength(0);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_c')).status).toBe('verifying');
    const proposals = await w.t.db.execute(sql`SELECT status, source FROM plan_proposals`);
    expect(proposals).toMatchObject([{ status: 'proposed', source: 'integration' }]);

    for (let i = 0; i < 3; i++) await w.assembly().tick();
    expect(await w.count('events', `type = 'candidate.failed'`)).toBe(1);
    expect(await w.count('plan_proposals')).toBe(1);
    expect(await w.count('candidates', `status = 'conflicted'`)).toBe(1);
  });
});

describe('main moves past a run with an open pull request', () => {
  it('rebuilds and re-verifies with no worker, says the pull request is out of date, refuses a new one by name, and opens one after the old closes', async () => {
    const { runId, sha: old } = await w.verifiedRun(['t_o'], () => ({ requirementIds: ['FB-01'] }));
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    const before = await attempts();
    const callsBefore = [...w.gh.calls];
    const tip = landOnMain();

    const tick = await w.assembly().tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    const fresh = tick.assembled[0]!;
    expect(fresh).not.toBe(old);
    expect(await live()).toMatchObject([{ sha: fresh, base_sha: tip }]);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_o')).status).toBe('verifying');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await attempts()).toEqual(before);

    // As soon as the rebuild has started, before any verdict.
    const during = await views(runId);
    expect(during.card).toMatchObject({ kind: 'reconciliation', chip: 'Pull request out of date' });
    expect(during.card.title).toBe(`Pull request #${number} no longer holds the verified code`);
    expect(during.card.summary).toContain('The rebuilt code has not passed verification yet.');
    expect(during.card.note).toContain('open the new one once verification passes');
    expect(during.merged).toMatchObject({ value: 'Pull request out of date', tone: 'warning' });

    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await attempts()).toEqual(before);

    // Back in review, the old pull request still must not read as ready.
    const after = await views(runId);
    expect(after.card).toMatchObject({ kind: 'reconciliation', chip: 'Pull request out of date' });
    expect(after.card.summary).toContain('The rebuilt code has passed verification.');
    expect(after.card.title).not.toMatch(/ready for your review/i);
    expect(after.merged.detail).toContain(`Pull request #${number} no longer holds the verified code`);

    const refused = await pr(runId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ reason: 'candidate_changed', prNumber: number });
    expect(w.gh.prs).toHaveLength(1);
    // Nothing closed or touched the old one for the owner.
    expect(w.gh.calls.slice(callsBefore.length).filter((c) => c !== 'findPullRequest' && c !== 'branchHead')).toEqual([]);
    expect(w.gh.prs[0]).toMatchObject({ number, state: 'open' });

    w.gh.humanCloses(number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'closed' });
    const opened = await pr(runId);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ status: 'opened', candidateSha: fresh, adopted: false });
    expect(w.gh.prs).toHaveLength(2);
    expect((await views(runId)).card.chip).not.toBe('Pull request out of date');
  });

  it('a person merging the old pull request is recorded as stale and counts for nothing', async () => {
    const { runId } = await w.verifiedRun(['t_s']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    landOnMain();
    const fresh = (await w.assembly().tick()).assembled[0]!;
    expect((await w.verification(passing).tick()).verified).toBe(fresh);

    w.gh.humanMerges(number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'stale' });
    expect(await w.count('change_requests', `status = 'stale_candidate'`)).toBe(1);
    expect(await w.count('events', `type = 'change.merged'`)).toBe(0);
    expect((await w.status('t_s')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
  });

  it('a pull request main has not left behind is not called out of date', async () => {
    const { runId } = await w.verifiedRun(['t_k']);
    expect((await pr(runId)).status).toBe(200);
    expect((await w.assembly().tick()).assembled).toEqual([]);
    const { card, merged } = await views(runId);
    expect(card).toMatchObject({ kind: 'merge_review', chip: 'Merge readiness' });
    expect(merged.value).toBe('Awaiting a human merge');
  });
});

describe('what never moves', () => {
  it('a merged run is not rebuilt, whatever main does', async () => {
    const { runId, sha } = await w.verifiedRun(['t_m']);
    expect((await pr(runId)).status).toBe(200);
    w.gh.humanMerges(w.gh.prs[0]!.number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'merged' });
    const events = await w.count('events');
    landOnMain();
    for (let i = 0; i < 2; i++) expect((await w.assembly().tick()).assembled).toEqual([]);
    expect(await w.lifecycle(runId)).toBe('merged');
    expect((await w.status('t_m')).status).toBe('merged');
    expect(await w.count('events')).toBe(events);
    expect(await w.count('candidates', `sha <> '${sha}'`)).toBe(0);
  });

  it('a merge a person made of something else stops the driver: only they can say what it means', async () => {
    const { runId } = await w.verifiedRun(['t_x']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    w.gh.humanPushes(number, 'f'.repeat(40));
    w.gh.humanMerges(number);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).status).toBe('sha_mismatch');
    landOnMain();
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect((await w.status('t_x')).status).toBe('verified');
  });

  it('a tip that cannot be read leaves everything alone and records nothing', async () => {
    const { runId, sha } = await w.verifiedRun(['t_u']);
    const events = await w.count('events');
    const candidatesBefore = await w.t.db.execute(sql`SELECT candidate_id, status, detail FROM candidates ORDER BY candidate_id`);
    w.git('update-ref', '-d', 'refs/heads/main');
    try {
      for (let i = 0; i < 3; i++) expect(await w.assembly().tick()).toEqual({ assembled: [], failed: [] });
      expect(await w.t.db.execute(sql`SELECT candidate_id, status, detail FROM candidates ORDER BY candidate_id`)).toEqual(candidatesBefore);
      expect(await w.count('events')).toBe(events);
      expect((await w.status('t_u')).status).toBe('verified');
      expect(await w.lifecycle(runId)).toBe('ready_for_review');
      expect(await valid(sha)).not.toBeNull();
    } finally {
      w.git('update-ref', 'refs/heads/main', w.baseSha);
    }
  });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const hostGit = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const reconcile = (run: { tenantId: string; projectId: string; runId: string }) => reconcileRun(run, { db: w.t.db, port: w.gh, now: w.now });
const candidateStatus = async (sha: string) => (await w.t.db.execute(sql`SELECT status FROM candidates WHERE sha = ${sha}`))[0]?.['status'];

let fetchesOfAMissingBranch = 0;

describe('with GitHub on, main is what GitHub says', () => {
  /** A real bare remote the merges land on. `gh` is scripted because it can only talk to github.com; every git call is real. */
  function remote(): { bare: string; port: ReturnType<typeof createGhCliPort>; advance(): string } {
    const bare = join(w.root, `gh-${Date.now()}-${Math.random()}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: gitEnv });
    hostGit(w.repo, 'push', '-q', bare, `${w.baseSha}:refs/heads/main`);
    const port = createGhCliPort({ remoteUrl: () => bare, exec: async (file, args, opts) => execFileSync(file, [...args], { cwd: opts?.cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) });
    const clone = `${bare}-work`;
    hostGit(w.root, 'clone', '-q', bare, clone);
    let n = 0;
    return { bare, port, advance: () => {
      execFileSync('sh', ['-c', `echo merged${++n} > merged-on-github.txt`], { cwd: clone });
      hostGit(clone, 'add', '-A'); hostGit(clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'merged on GitHub'); hostGit(clone, 'push', '-q', 'origin', 'HEAD:main');
      return hostGit(clone, 'rev-parse', 'HEAD');
    } };
  }

  it('a commit merged only on GitHub triggers a rebuild on it, though the local branch never moved', async () => {
    const r = remote();
    const { sha: old } = await w.verifiedRun(['t_g']);
    const tip = r.advance();
    expect(w.git('rev-parse', 'refs/heads/main')).toBe(w.baseSha);

    const tick = await w.assembly({ remote: r.port }).tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    expect(await live()).toMatchObject([{ base_sha: tip }]);
    expect(await candidateStatus(old)).toBe('invalidated');
    expect(w.git('ls-tree', '-r', '--name-only', tick.assembled[0]!)).toContain('merged-on-github.txt');
    expect(w.git('rev-parse', 'refs/heads/main')).toBe(w.baseSha);
  });

  it('a commit only on the local branch is nothing, when GitHub is the authority', async () => {
    const r = remote();
    await w.verifiedRun(['t_l']);
    landOnMain();
    expect((await w.assembly({ remote: r.port }).tick()).assembled).toEqual([]);
    expect(await live()).toMatchObject([{ base_sha: w.baseSha }]);
  });

  it.each([
    ['branchHead fails', (p: ReturnType<typeof createGhCliPort>) => ({ ...p, branchHead: async () => { throw new Error('502'); } })],
    ['the branch reads as missing', (p: ReturnType<typeof createGhCliPort>) => ({ ...p, branchHead: async () => null, fetchBranch: async () => { fetchesOfAMissingBranch += 1; } })],
    ['the fetch fails', (p: ReturnType<typeof createGhCliPort>) => ({ ...p, fetchBranch: async () => { throw new Error('fetch refused'); } })],
  ])('%s: nothing changes and nothing is recorded', async (_name, broken) => {
    fetchesOfAMissingBranch = 0;
    const r = remote();
    const { runId, sha } = await w.verifiedRun(['t_x']);
    r.advance();
    const events = await w.count('events');
    for (let i = 0; i < 2; i++) expect(await w.assembly({ remote: broken(r.port) }).tick()).toEqual({ assembled: [], failed: [] });
    expect(await candidateStatus(sha)).toBe('assembled');
    expect((await w.status('t_x')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await w.count('events')).toBe(events);
    expect(await valid(sha)).not.toBeNull();
    expect(fetchesOfAMissingBranch).toBe(0);
  });
});

describe('a real merge can land before reconcile has seen it', () => {
  it.each([
    ['a merge commit', async (head: string) => { w.git('merge', '-q', '--no-ff', '-m', 'merge', head); return w.git('rev-parse', 'HEAD'); }],
    ['a squash merge', async (head: string) => { w.git('merge', '-q', '--squash', head); w.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'squash'); return w.git('rev-parse', 'HEAD'); }],
  ])('%s of the verified candidate is recorded as merged: no rebuild, no false conflict, no stale record', async (_kind, land) => {
    const { runId, sha } = await w.verifiedRun(['t_m']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    const merge = await (async () => {
      w.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'config', 'user.name', 't'); w.git('config', 'user.email', 't@t');
      return land(sha);
    })();
    w.gh.humanMerges(number, merge);

    const tick = await w.assembly({ reconcile }).tick();
    expect(tick).toEqual({ assembled: [], failed: [] });
    expect(await w.lifecycle(runId)).toBe('merged');
    expect((await w.status('t_m')).status).toBe('merged');
    expect(await w.count('change_requests', `status = 'merged'`)).toBe(1);
    expect(await w.count('events', `type = 'candidate.failed'`)).toBe(0);
    expect(await w.count('plan_proposals')).toBe(0);
    expect(await candidateStatus(sha)).toBe('assembled');
  });

  it('when GitHub cannot say what happened, nothing is retired on a guess', async () => {
    const { runId, sha } = await w.verifiedRun(['t_e']);
    expect((await pr(runId)).status).toBe(200);
    landOnMain();
    expect(await w.assembly({ reconcile: async () => { throw new Error('502'); } }).tick()).toEqual({ assembled: [], failed: [] });
    expect(await candidateStatus(sha)).toBe('assembled');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
  });
});

describe('a rebuild that would need a claim another run holds', () => {
  it('is deferred whole, visibly, with nothing touched, and runs when the claim is free', async () => {
    const { runId, sha } = await w.verifiedRun(['t_a', 't_b'], (id) => (id === 't_a' ? { resourceClaims: [{ key: 'db', mode: 'exclusive' }] } : {}));
    const other = await w.newRun();
    await w.plan(other, [w.task(other, 't_other', { resourceClaims: [{ key: 'db', mode: 'exclusive' }] })]);
    await w.claimAndComplete('t_other', 'src/other_only.ts');
    landOnMain();

    const events = await w.count('events');
    for (let i = 0; i < 3; i++) await w.assembly().tick();
    expect(await w.count('candidates', `run_id = '${runId}' AND status = 'assembled' AND sha = '${sha}'`)).toBe(1);
    expect((await w.status('t_a')).status).toBe('verified');
    expect((await w.status('t_b')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await valid(sha)).not.toBeNull();
    // `t_other`'s own assembly may run; what must not happen is anything on this run.
    expect(await w.count('events', `run_id = '${runId}' AND sequence > 0 AND type IN ('task.reopened', 'run.reverted', 'candidate.failed') AND occurred_at > now() - interval '0 seconds'`)).toBe(0);
    expect(events).toBeGreaterThan(0);

    const snapshotRun = (await w.snapshot()).runs.find((r: { runId: string }) => r.runId === runId);
    expect(snapshotRun.rebuildDeferred.message).toContain('db');
    expect((await views(runId)).card).toMatchObject({ kind: 'reconciliation', chip: 'Rebuild waiting' });

    const { rowRevision } = await w.status('t_other');
    expect((await w.command('t_other', rowRevision, 'free')).status).toBe(202);
    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    const files = w.git('ls-tree', '-r', '--name-only', tick.assembled[0]!);
    expect(files).toContain('src/t_a.ts');
    expect(files).toContain('src/t_b.ts');
    expect((await w.status('t_a')).status).toBe('verifying');
    expect((await w.status('t_b')).status).toBe('verifying');
  });
});

describe('a candidate whose own parts share a claim', () => {
  it('a later part still holding the claim, waiting for its first verdict, does not defer the rebuild for ever', async () => {
    const claim = { key: 'schema', mode: 'exclusive' as const };
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 'p_1', { resourceClaims: [claim] }), w.task(runId, 'p_2', { resourceClaims: [claim], dependencies: [{ taskId: 'p_1', revision: 1, condition: 'artifact_verified' }] })]);
    await w.claimAndComplete('p_1');
    await w.assembly().tick();
    await w.verification(passing).tick();
    await w.claimAndComplete('p_2');
    landOnMain();
    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    expect((await w.status('p_1')).status).toBe('verifying');
    expect((await w.status('p_2')).status).toBe('verifying');
    expect(await w.count('resource_claims', `resource_key = 'schema' AND released_at IS NULL`)).toBe(1);
    expect((await w.verification(passing).tick()).verified).toBe(tick.assembled[0]);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
  });

  it('rebuilds whole: the parts do not conflict with each other', async () => {
    const claim = { key: 'lockfile', mode: 'exclusive' as const };
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_1', { resourceClaims: [claim] }), w.task(runId, 't_2', { resourceClaims: [claim], dependencies: [{ taskId: 't_1', revision: 1, condition: 'artifact_verified' }] })]);
    await w.claimAndComplete('t_1');
    await w.assembly().tick();
    await w.verification(passing).tick();
    await w.claimAndComplete('t_2');
    await w.assembly().tick();
    await w.verification(passing).tick();
    expect(await w.lifecycle(runId)).toBe('ready_for_review');

    landOnMain();
    expect((await w.assembly().tick()).assembled).toHaveLength(1);
    expect((await w.status('t_1')).status).toBe('verifying');
    expect((await w.status('t_2')).status).toBe('verifying');
    // Postgres allows one live exclusive claim per key, so one row stands for the whole candidate.
    expect(await w.count('resource_claims', `resource_key = 'lockfile' AND released_at IS NULL`)).toBe(1);
  });
});

describe('a rebuild that goes wrong with a pull request open is named for what happened', () => {
  it('a failed verdict', async () => {
    const { runId } = await w.verifiedRun(['t_f2']);
    expect((await pr(runId)).status).toBe(200);
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    const { card, merged } = await views(runId);
    expect(card.summary).toContain('the rebuild failed');
    expect(card.summary).not.toContain('is being rebuilt');
    expect(merged.detail).toContain('the rebuild failed');
  });

  it('a conflict', async () => {
    const { runId } = await w.verifiedRun(['t_cf']);
    expect((await pr(runId)).status).toBe(200);
    w.gitCommit('src/t_cf.ts', 'export const v = "from main";\n');
    await w.assembly().tick();
    const { card } = await views(runId);
    expect(card.summary).toContain('could not be rebuilt: it conflicts with main');
    expect(card.summary).not.toContain('is being rebuilt');
  });
});

describe('after a failed rebuild', () => {
  it('main moving again retries it automatically, with no worker; main standing still does not', async () => {
    const { runId } = await w.verifiedRun(['t_retry']);
    const before = await attempts();
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.status('t_retry')).status).toBe('blocked');
    for (let i = 0; i < 2; i++) expect((await w.assembly().tick()).assembled).toEqual([]);
    expect((await w.status('t_retry')).status).toBe('blocked');

    const tip = landOnMain();
    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    expect(await live()).toMatchObject([{ base_sha: tip }]);
    expect((await w.status('t_retry')).status).toBe('verifying');
    expect((await w.verification(passing).tick()).verified).toBe(tick.assembled[0]);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await attempts()).toEqual(before);
  });

  it('the owner can re-verify it when main has moved, and not when it has not', async () => {
    const { runId } = await w.verifiedRun(['t_rv']);
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    const reverify = (key: string) => post(w.app, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: key });
    const same = await reverify('same');
    expect(same.status).toBe(403);
    expect(same.body.error.details.reason).toBe('nothing_to_reverify');

    landOnMain();
    const moved = await reverify('moved');
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.reopened).toEqual(['t_rv']);
    expect((await w.status('t_rv')).status).toBe('verifying');
  });

  it('a dependent stuck behind a blocked rebuild says so, and goes on once main moves and the rebuild passes', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 'a'), w.task(runId, 'b', { dependencies: [{ taskId: 'a', revision: 1, condition: 'artifact_verified' }], maxAttempts: 3 })]);
    await w.claimAndComplete('a');
    await w.assembly().tick();
    await w.verification(passing).tick();
    expect((await w.status('a')).status).toBe('verified');
    const lease = await w.claim();
    landOnMain();
    expect((await w.assembly().tick()).assembled).toEqual([]);
    await w.runWorker(lease, ({ write }) => { write('src/b.ts', 'export const b = 1;\n'); });

    expect((await w.assembly().tick()).assembled).toHaveLength(1);
    await w.verification(failingOn(['FB-01'])).tick();
    // `a` had been verified, so it blocks. `b` was never judged, so it keeps its bounded repair, and now waits on `a`.
    expect((await w.status('a')).status).toBe('blocked');
    expect((await w.status('b')).status).toBe('ready');
    const claim = await post(w.app, '/v1/runners/claim', {}, { authorization: `Bearer ${w.token}` });
    expect(claim.body).toMatchObject({ lease: null, reason: 'no_claimable_task' });
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect((await w.status('b')).placementBlock).toBe('dependency_blocked:a');

    landOnMain();
    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    expect((await w.verification(passing).tick()).verified).toBe(tick.assembled[0]);
    expect((await w.status('a')).status).toBe('verified');
    expect((await w.claim()).taskId).toBe('b');
    expect((await w.status('b')).placementBlock).toBeNull();
  });

  it('a part never judged before main moved keeps the existing bounded repair: repaired, then blocked at its budget', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_nj', { maxAttempts: 2 })]);
    await w.claimAndComplete('t_nj');
    await w.assembly().tick();
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.status('t_nj')).status).toBe('ready');
    const repair = await w.claim();
    expect(repair.attemptNumber).toBe(2);
    await w.runWorker(repair, ({ write }) => { write('src/t_nj.ts', 'export const v = 2;\n'); });
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.status('t_nj')).status).toBe('blocked');
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('repair_budget_exhausted');
  });
});

describe('an active main cannot pile up runs on old tips', () => {
  const stale = (runId: string) => w.t.db.execute(sql`UPDATE candidates SET base_sha = ${'0'.repeat(40)}, created_at = now() - interval '1 hour' WHERE run_id = ${runId} AND status = 'assembled'`);

  it('a candidate main has moved past is not claimed, and the next run behind it is served', async () => {
    const a = await w.newRun();
    await w.plan(a, [w.task(a, 't_oldtip')]);
    await w.claimAndComplete('t_oldtip');
    const aSha = (await w.assembly().tick()).assembled[0]!;

    const b = await w.newRun();
    await w.plan(b, [w.task(b, 't_current')]);
    await w.claimAndComplete('t_current');
    const bSha = (await w.assembly().tick()).assembled[0]!;
    await stale(a); // Oldest in the queue, and left behind by main.

    const judged: string[] = [];
    const runner = async (i: RunnerInput) => { judged.push(i.candidateDir); return passing(i); };
    const tick = await w.verification(runner).tick();
    expect(tick.verified).toBe(bSha);
    expect(judged).toHaveLength(1);
    expect(await w.count('check_runs', `candidate_sha = '${aSha}'`)).toBe(0);
  });

  it('main moving during a run aborts it: no verdict, no error, and the rebuild follows', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_abort')]);
    await w.claimAndComplete('t_abort');
    const old = (await w.assembly().tick()).assembled[0]!;

    let aborted = false;
    const runner = (i: RunnerInput) => new Promise<Awaited<ReturnType<typeof passing>>>((resolve) => {
      landOnMain();
      i.signal!.addEventListener('abort', () => { aborted = true; resolve({ exitCode: null, result: null, log: 'killed' }); });
    });
    const tick = await w.verification(runner, 0, { supersededCheckMs: 10 }).tick();
    expect(aborted).toBe(true);
    expect(tick).toEqual({ verified: null, reaped: [] });
    expect(await w.count('check_runs')).toBe(0);
    expect(await w.count('artifacts', `type = 'verification_record'`)).toBe(0);
    expect((await w.status('t_abort')).status).toBe('verifying');
    const rebuilt = await w.assembly().tick();
    expect(rebuilt.assembled).toHaveLength(1);
    expect(rebuilt.assembled[0]).not.toBe(old);
  });

  it('a tip that cannot be read during a run does not abort it', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_keep')]);
    await w.claimAndComplete('t_keep');
    const sha = (await w.assembly().tick()).assembled[0]!;
    try {
      const runner = async (i: RunnerInput) => { w.git('update-ref', '-d', 'refs/heads/main'); await new Promise((r) => setTimeout(r, 60)); return passing(i); };
      expect((await w.verification(runner, 0, { supersededCheckMs: 10 }).tick()).verified).toBe(sha);
    } finally {
      w.git('update-ref', 'refs/heads/main', w.baseSha);
    }
  });
});

describe('tip edge cases', () => {
  it('main returning to the pinned base retires the candidate built on the later tip first, and the rebuild keeps the no-repair rule', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_back')]);
    await w.claimAndComplete('t_back');
    // Built on a tip past the pinned base, with nothing yet verified: no rebuild has written the no-repair row for this attempt.
    const tip = landOnMain();
    const first = (await w.assembly().tick()).assembled[0]!;
    expect(await live()).toMatchObject([{ base_sha: tip }]);
    await w.verification(passing).tick();
    expect((await w.status('t_back')).status).toBe('verified');

    w.git('reset', '-q', '--hard', w.baseSha);
    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    expect(await candidateStatus(first)).toBe('invalidated');
    expect(await live()).toMatchObject([{ base_sha: w.baseSha }]);
    expect((await w.status('t_back')).status).toBe('verifying');
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('reverification_failed');
  });

  it('an unreadable tip on a run still waiting for its verdict concludes nothing', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_wait')]);
    await w.claimAndComplete('t_wait');
    const sha = (await w.assembly().tick()).assembled[0]!;
    w.git('update-ref', '-d', 'refs/heads/main');
    try {
      expect(await w.assembly().tick()).toEqual({ assembled: [], failed: [] });
      expect(await candidateStatus(sha)).toBe('assembled');
    } finally {
      w.git('update-ref', 'refs/heads/main', w.baseSha);
    }
  });

  it('the same conflict on each new commit of main stays one conflict', async () => {
    await w.verifiedRun(['t_once']);
    w.gitCommit('src/t_once.ts', 'export const v = "main";\n');
    await w.assembly().tick();
    for (let i = 0; i < 3; i++) { landOnMain(); await w.assembly().tick(); }
    expect(await w.count('events', `type = 'candidate.failed'`)).toBe(1);
    expect(await w.count('plan_proposals')).toBe(1);
    expect(await w.count('candidates', `status = 'conflicted'`)).toBe(1);
    const [proposal] = await w.t.db.execute(sql`SELECT detail ->> 'baseSha' AS base FROM plan_proposals`);
    expect(proposal!['base']).toBe(w.git('rev-parse', 'refs/heads/main'));
  });
});
