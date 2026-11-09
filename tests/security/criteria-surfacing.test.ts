/** Case: surface failed and untested criteria: in the snapshot the operator reads and the failures route, and in the pull request a reviewer reads. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CRITERIA, failingOn, passing, post, PROJECT, skippingOn, World } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const UNTESTED = 'ZZ-99';
const criteriaOf = async (runId: string): Promise<{ total: number; verified: number; byId: Record<string, { state: string; verified: boolean }> }> => {
  const snap = await w.snapshot();
  const run = snap.runs.find((r: { runId: string }) => r.runId === runId);
  return { ...run.criteria, byId: Object.fromEntries(run.evidence.criteria.map((c: { criterionId: string; state: string; verified: boolean }) => [c.criterionId, c])) };
};

async function built(taskId: string, requirementIds: readonly string[]): Promise<{ runId: string; sha: string }> {
  const runId = await w.newRun();
  expect((await w.plan(runId, [w.task(runId, taskId, { requirementIds: [...requirementIds] })])).status).toBe(201);
  await w.claimAndComplete(taskId);
  return { runId, sha: (await w.assembly().tick()).assembled[0]! };
}

describe('failed and untested criteria are shown, never smoothed over', () => {
  it('a failed criterion, a requirement no check covers and a passing one read as three different things, and nothing counts as verified', async () => {
    const { runId } = await built('t_f', ['FB-01', 'FB-02', UNTESTED]);
    await w.verification(failingOn(['FB-02'], 'expected 201, got 500')).tick();

    const c = await criteriaOf(runId);
    expect(c.total).toBe(3);
    expect(c.verified).toBe(0);
    expect(c.byId['FB-02']).toMatchObject({ state: 'failed', verified: false });
    expect(c.byId[UNTESTED]).toMatchObject({ state: 'not_run', verified: false });
    expect(c.byId['FB-01']).toMatchObject({ state: 'passed', verified: false });

    const failures = await w.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/runs/${runId}/failures`, headers: { authorization: 'Bearer firebase-owner-token' } });
    expect(failures.json().failures).toEqual([expect.objectContaining({ criterionId: 'FB-02', message: 'expected 201, got 500' })]);
    expect(await w.lifecycle(runId)).toBe('running');
    const pr = await post(w.app, `/v1/runs/${runId}/pull-request`, {});
    expect(pr.status).toBe(409);
    expect(pr.body.error.details.reason).toBe('run_not_ready');
    expect(w.gh.calls).toEqual([]);
  });

  it('a skipped check is not a pass and cannot reach review', async () => {
    const { runId } = await built('t_s', ['FB-03']);
    await w.verification(skippingOn(['FB-03'])).tick();
    expect((await w.status('t_s')).status).toBe('blocked');
    // A skip is no verdict: the candidate is retired, the operator sees why, and the criterion reads as not run, never as passed.
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('verification_skipped');
    const c = await criteriaOf(runId);
    expect(c.byId['FB-03']).toMatchObject({ state: 'not_run', verified: false });
    expect(c.verified).toBe(0);
    expect(await w.lifecycle(runId)).toBe('running');
  });

  it('a run whose checks all pass still names the requirement no check covered, to the operator and in the pull request', async () => {
    const ids = [...CRITERIA.slice(0, 2), UNTESTED];
    const { runId, sha } = await built('t_u', ids);
    expect((await w.verification(passing).tick()).verified).toBe(sha);

    const c = await criteriaOf(runId);
    expect(c.total).toBe(3);
    expect(c.verified).toBe(2);
    expect(c.byId[UNTESTED]).toMatchObject({ state: 'not_run', verified: false });

    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    const pr = await post(w.app, `/v1/runs/${runId}/pull-request`, {});
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    const body = w.gh.prs[0]!.body;
    expect(body, body).toContain(UNTESTED);
    expect(body).toMatch(new RegExp(`${UNTESTED}.*(no check|not tested|untested)`, 'i'));
  });
});
