/**
 * Architecture section 6 rule 8: if main advances, rebuild the candidate and rerun affected gates. Real assembly and verification drivers against real git commits on the source repository's main.
 * With an open pull request the driver stands still and the owner decides.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRun } from '@selarikru/integrations-github';
import { API_POLICY } from '@selarikru/control-api/test-helpers';
import type { Policy } from '@selarikru/policy';
import { failingOn, passing, post, PROJECT, sql, TENANT, World } from './world.ts';
import { loadValidRecord } from '../../services/verifier/src/service.ts';

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
const rebuild = (runId: string, key: string, expectedPlanRevision = 1) => post(w.app, `/v1/runs/${runId}/rebuild`, { expectedPlanRevision, idempotencyKey: key });

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
  async function reviewing(taskId: string): Promise<{ runId: string; sha: string; number: number }> {
    const { runId, sha } = await w.verifiedRun([taskId]);
    expect((await pr(runId)).status).toBe(200);
    return { runId, sha, number: w.gh.prs[0]!.number };
  }

  it('does not rebuild: the commit stays under review, and the fact is written once for the tip', async () => {
    const { runId, sha } = await reviewing('t_o');
    const tip = landOnMain();

    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect((await w.status('t_o')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await valid(sha)).not.toBeNull();
    const [first] = await live();
    expect(first).toMatchObject({ sha, detail: { mainMoved: { tipSha: tip } } });

    const events = await w.count('events');
    w.advance(30);
    for (let i = 0; i < 3; i++) await w.assembly().tick();
    expect(await w.count('events')).toBe(events);
    expect((await live())[0]!['detail']).toEqual(first!['detail']);

    // Read through the snapshot the Decisions card uses, on a run with no requirement ids and so no evidence report.
    const snap = await w.snapshot();
    expect(snap.changeRequests).toMatchObject([{ runId, candidateSha: sha, mainMoved: { tipSha: tip, baseSha: w.baseSha } }]);
  });

  it('the fact also reaches the evidence report of a run with criteria', async () => {
    const { runId, sha } = await w.verifiedRun(['t_e'], () => ({ requirementIds: ['FB-01'] }));
    expect((await pr(runId)).status).toBe(200);
    const tip = landOnMain();
    await w.assembly().tick();
    const run = (await w.snapshot()).runs.find((r: { runId: string }) => r.runId === runId);
    expect(run.evidence.candidate).toMatchObject({ sha, mainMoved: { tipSha: tip } });
  });

  it('the owner’s rebuild rebuilds, re-verifies with no worker, and the old pull request is then refused by name', async () => {
    const { runId, sha, number } = await reviewing('t_r');
    const before = await attempts();
    landOnMain();
    await w.assembly().tick();

    const asked = await rebuild(runId, 'k1');
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ runId, candidateSha: sha, state: 'requested' });
    expect((await rebuild(runId, 'k1')).body).toEqual(asked.body);
    expect(await w.count('task_commands', `command = 'rebuild'`)).toBe(1);

    const tick = await w.assembly().tick();
    expect(tick.assembled).toHaveLength(1);
    const fresh = tick.assembled[0]!;
    expect(fresh).not.toBe(sha);
    expect(await w.lifecycle(runId)).toBe('running');
    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await attempts()).toEqual(before);

    const refused = await pr(runId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ reason: 'candidate_changed', prNumber: number });
    expect(w.gh.prs).toHaveLength(1);

    // That pull request now carries an old commit, so nobody is reviewing this candidate through it: the next move of main rebuilds again on its own.
    landOnMain();
    expect((await w.assembly().tick()).assembled).toHaveLength(1);
  });

  it('the owner’s rebuild is refused with nothing to rebuild, to anyone but the owner, past its bound, and under a denying policy', async () => {
    const { runId } = await reviewing('t_b');
    expect((await rebuild(runId, 'early')).body.error.details.reason).toBe('nothing_to_rebuild');
    landOnMain();
    await w.assembly().tick();
    expect((await post(w.app, `/v1/runs/${runId}/rebuild`, { expectedPlanRevision: 1, idempotencyKey: 'r' }, { authorization: `Bearer ${w.token}` })).status).toBe(403);
    expect((await rebuild(runId, 'stale', 9)).status).toBe(409);

    await w.t.db.execute(sql`INSERT INTO task_commands (tenant_id, project_id, operation_id, task_id, revision, command, state, requested_by, requested_at, detail)
      SELECT ${TENANT}, ${PROJECT}, 'op_' || n, 't_b', 1, 'rebuild', 'applied', 'owner', now(), '{}'::jsonb FROM generate_series(1, 3) n`);
    const over = await rebuild(runId, 'k2');
    expect(over.status).toBe(403);
    expect(over.body.error.details).toMatchObject({ reason: 'rebuild_limit_reached', taskId: 't_b' });
    expect((await live())[0]!['detail']).not.toHaveProperty('rebuildRequested');
  });

  it('after the pull request is closed the driver rebuilds on its own', async () => {
    const { runId, number } = await reviewing('t_cl');
    landOnMain();
    await w.assembly().tick();
    w.gh.humanCloses(number);
    await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now });
    // The fact is still on the candidate, but with no open pull request there is nothing for the owner to ask for.
    expect((await rebuild(runId, 'closed')).body.error.details.reason).toBe('nothing_to_rebuild');
    expect((await w.assembly().tick()).assembled).toHaveLength(1);
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
    expect((await live())[0]!['detail']).not.toHaveProperty('mainMoved');
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

  it('a policy that withholds replanning withholds the rebuild', async () => {
    const deny = await World.create({ policy: { ...API_POLICY, operations: { assign_replan_tasks: 'deny' } } as Policy });
    try {
      await deny.reset();
      const res = await post(deny.app, '/v1/runs/run_a/rebuild', { expectedPlanRevision: 0, idempotencyKey: 'p' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('policy_denied');
    } finally {
      await deny.destroy();
    }
  });
});
