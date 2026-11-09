/**
 * Case: legacy `review-passed` never yields `verified`. The word exists in no code path of this system, so the test is every way a review-provider state could try to arrive: a runner's result,
 * an owner command, a client report, a signed GitHub webhook, and a row imported from the old system's vocabulary. Only the verifier's own record may produce `verified`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkEventAuthority } from '@selarikru/domain';
import { processPendingDeliveries, reconcileRun, signBody } from '@selarikru/integrations-github';
import { applyVerification } from '@selarikru/workflow';
import { owner, post, PROJECT, sql, TENANT, WEBHOOK_SECRET, World, toolUse } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const verified = () => w.count('task_status', `status = 'verified'`);
const verifiedCriteria = async (runId: string) => (await w.snapshot()).runs.find((r: { runId: string }) => r.runId === runId).criteria;

async function verifying(taskId: string, over = {}): Promise<string> {
  const runId = await w.newRun();
  expect((await w.plan(runId, [w.task(runId, taskId, { requirementIds: ['FB-01'], ...over })])).status).toBe(201);
  await w.claimAndComplete(taskId);
  return runId;
}

describe('review-passed never becomes verified', () => {
  it('a runner reporting it, as an outcome or as a field, is refused and the task does not move', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_w')]);
    const lease = await w.claim();
    const ref = { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken };
    const auth = { authorization: `Bearer ${w.token}` };
    for (const result of [{ outcome: 'review-passed' }, { outcome: 'completed', status: 'review-passed' }, { outcome: 'completed', verification: { result: 'passed' } }]) {
      const res = await post(w.app, '/v1/runners/result', { lease: ref, result }, auth);
      expect(res.status, JSON.stringify(result)).toBe(400);
    }
    expect((await w.status('t_w')).status).toBe('running');
    expect(await w.count('events', `type LIKE 'verification.%'`)).toBe(0);
  });

  it('an agent announcing it in its output or as a file changes nothing the verifier owns', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_say', { requirementIds: ['FB-01'], allowedPaths: ['src'] })]);
    const { report } = await w.runWorker(await w.claim(), ({ stream, write }) => {
      stream.push(`${toolUse('Bash', { command: 'echo review-passed; echo verified' })}\n`);
      write('src/review-passed.md', 'status: review-passed\nverified: true\n');
    });
    expect(report.outcome).toBe('completed');
    expect((await w.status('t_say')).status).toBe('verifying');
    expect(await w.count('events', `type = 'verification.passed'`)).toBe(0);
    expect(await verifiedCriteria(runId)).toMatchObject({ verified: 0 });
  });

  it('an owner command and a client report using it are refused', async () => {
    await verifying('t_cmd');
    const { rowRevision } = await w.status('t_cmd');
    expect((await post(w.app, '/v1/tasks/t_cmd/commands', { command: 'review-passed', expectedRevision: rowRevision, idempotencyKey: 'k1' })).status).toBe(400);
    expect((await post(w.app, '/v1/tasks/t_cmd/client-reports', { kind: 'review-passed', mode: 'ONLY_IN_CLOUD', observedSource: 'in_cloud' })).status).toBe(400);
    expect((await post(w.app, '/v1/tasks/t_cmd/client-reports', { kind: 'inference', mode: 'ONLY_IN_CLOUD', observedSource: 'in_cloud', review: 'review-passed' })).status).toBe(400);
    expect((await w.status('t_cmd')).status).toBe('verifying');
    expect(await verified()).toBe(0);
  });

  it('a signed GitHub review approval, a passing check suite and a review-passed label on the PR only queue a hint', async () => {
    const runId = await verifying('t_gh');
    // A change request as if a PR were already open, so the webhook's PR number finds a row to reconcile.
    await w.t.db.execute(sql`INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, base_ref, pr_number, url, status, observed_head_sha) VALUES (${TENANT}, ${PROJECT}, ${runId}, 'acme/feedback-board', ${'a'.repeat(40)}, 'b', 'main', 7, 'u', 'open', ${'a'.repeat(40)})`);
    w.gh.prs.push({ number: 7, url: 'u', state: 'open', draft: true, headRef: 'b', headSha: 'a'.repeat(40), baseRef: 'main', isCrossRepository: false, mergeCommitSha: null, title: 't', body: 'b' });
    const deliver = async (event: string, payload: object, id: string) => {
      const body = Buffer.from(JSON.stringify(payload));
      return w.app.inject({ method: 'POST', url: '/v1/webhooks/github', payload: body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id, 'x-hub-signature-256': signBody(WEBHOOK_SECRET, body) } });
    };
    const base = { repository: { full_name: 'acme/feedback-board' }, number: 7, pull_request: { number: 7, merged: false, state: 'open', labels: [{ name: 'review-passed' }] } };
    for (const [event, payload, id] of [
      ['pull_request_review', { ...base, action: 'submitted', review: { state: 'approved' } }, 'd1'],
      ['check_suite', { ...base, action: 'completed', check_suite: { conclusion: 'success' } }, 'd2'],
      ['pull_request', { ...base, action: 'labeled', label: { name: 'review-passed' } }, 'd3'],
    ] as const) expect((await deliver(event, payload, id)).statusCode).toBeLessThan(500);

    const eventsBefore = await w.count('events');
    await processPendingDeliveries({ db: w.t.db, port: w.gh, now: w.now });
    expect(await w.status('t_gh')).toMatchObject({ status: 'verifying' });
    expect(await verified()).toBe(0);
    expect(await w.count('events')).toBe(eventsBefore);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'open' });
    expect(await verifiedCriteria(runId)).toMatchObject({ verified: 0 });
  });

  it('a legacy row at rest does not count: not as a task status, not as a check result, and it cannot open a PR', async () => {
    const runId = await verifying('t_row');
    const sha = (await w.assembly().tick()).assembled[0]!;
    await w.t.db.execute(sql`UPDATE task_status SET status = 'review-passed' WHERE task_id = 't_row'`);
    await w.t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result) VALUES (${TENANT}, ${PROJECT}, 'chk_legacy', 't_row', 1, NULL, 'FB-01', '1', ${sha}, 'review-passed')`);

    const snap = await w.snapshot();
    const run = snap.runs.find((r: { runId: string }) => r.runId === runId);
    expect(run.criteria).toMatchObject({ verified: 0 });
    expect(run.evidence.criteria[0]).toMatchObject({ criterionId: 'FB-01', verified: false });
    expect(await w.lifecycle(runId)).toBe('running');
    expect((await post(w.app, `/v1/runs/${runId}/pull-request`, {})).status).toBe(409);
    expect(await verified()).toBe(0);
    // And a real verdict cannot be applied to it either, since it is not verifying.
    await w.verification(async () => { throw new Error('the verifier must not treat this as a verdict'); }).tick();
    expect(await verified()).toBe(0);
  });

  it('no principal but the verifier can write a passing verdict, by the state machine or by event', async () => {
    await verifying('t_auth');
    for (const kind of ['worker', 'human', 'system', 'scheduler', 'integration'] as const) {
      await expect(applyVerification({ db: w.t.db, now: w.now }, { tenantId: TENANT, projectId: PROJECT, taskId: 't_auth' }, { actor: { kind, id: 'x' }, outcome: 'passed', detail: {} })).rejects.toThrow(/verifier/);
    }
    const envelope = { schemaVersion: 1, eventId: 'e', projectId: PROJECT, runId: 'r', taskId: 't_auth', attemptId: null, type: 'verification.passed', sequence: 0, aggregateRevision: 1, actor: { kind: 'worker', id: 'x' }, occurredAt: '2026-01-01T00:00:00Z', receivedAt: '2026-01-01T00:00:00Z', causationId: null, traceId: 't', payload: {} } as const;
    expect(checkEventAuthority(envelope).ok).toBe(false);
    expect(checkEventAuthority({ ...envelope, actor: { kind: 'verifier', id: 'v' } }).ok).toBe(true);
    expect((await w.status('t_auth')).status).toBe('verifying');
  });
});

describe('the only way to verified', () => {
  it('control: the real verifier record does produce verified, so the refusals above are not a broken pipeline', async () => {
    const runId = await verifying('t_real');
    const sha = (await w.assembly().tick()).assembled[0]!;
    const { passing } = await import('./world.ts');
    expect((await w.verification(passing).tick()).verified).toBe(sha);
    expect((await w.status('t_real')).status).toBe('verified');
    expect(await verifiedCriteria(runId)).toMatchObject({ verified: 1 });
    expect(owner()).toBeDefined();
  });
});
