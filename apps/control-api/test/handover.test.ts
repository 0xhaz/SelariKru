/**
 * Checkpoint continuation over the real runner protocol: a local runner enrolment holds the prior attempt, and a second enrolment with location `cloud` is the successor.
 * No cloud adapter is mocked: both runners speak to the API exactly as the runner binary does. Hosted cloud infrastructure is T7.3.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkpointDigest } from '@selarikru/domain';
import { schema } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { createScheduler, loadLatestAppliedRecord } from '@selarikru/workflow';
import { CLOUD_POLICY } from '@selarikru/workflow/test-helpers';
import { API_POLICY, CAPS, PROJECT, RUN, TENANT, TEST_CATALOG, bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, testClock, type Harness, type TestDb } from './helpers.ts';

const BASE = 'a'.repeat(40);
const POLICY = { ...CLOUD_POLICY, operations: { ...API_POLICY.operations, destructive_data_migration: 'require_approval' } } as unknown as Policy;
const url = (taskId = 'T1') => `/v1/projects/${PROJECT}/tasks/${taskId}/handover`;

let t: TestDb;
let h: Harness;
let local: { runnerId: string; token: string };
let cloud: { runnerId: string; token: string };

beforeAll(async () => { t = await setupTestDb(); });
afterEach(async () => { await h.app.close(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'H2', cloudDestination: 'cloud-sandbox-eu' })}::jsonb`);
  const clock = testClock();
  h = { ...makeHarness(t, {}, POLICY, { scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY }), now: clock.now }), clock };
  await h.app.ready();
  local = await enrolRunner(h.app, 'local');
  cloud = await enrolRunner(h.app, 'cloud');
});

const file = (path: string, body: string) => {
  const bytes = Buffer.from(body);
  return { path, status: 'modified' as const, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, executable: false, content: bytes.toString('base64') };
};
const checkpointBody = (lease: Ref, files: ReturnType<typeof file>[], exclusions: { path: string; reason: string }[] = []) => ({ lease, baseSha: BASE, files, exclusions, patchSha256: checkpointDigest(BASE, files) });

type Ref = { attemptId: string; fence: number; leaseToken: string };
const refOf = (l: any): Ref => ({ attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken });
const claim = async (token: string) => (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body;
const events = async () => (await t.db.execute(sql`SELECT sequence, type, attempt_id, payload FROM events ORDER BY sequence`)).map((r) => ({ seq: Number(r['sequence']), type: String(r['type']), attemptId: r['attempt_id'] as string | null, payload: r['payload'] }));

async function localRunning(over: Parameters<typeof specFor>[1] = {}): Promise<Ref> {
  await seedTask(t.db, specFor('T1', { baseSha: BASE, allowedPaths: ['server'], ...over }));
  const c = await claim(local.token);
  expect(c.lease).toMatchObject({ taskId: 'T1', location: 'local' });
  return refOf(c.lease);
}

describe('continue in cloud', () => {
  it('end to end: the prior attempt is fenced first, secret files are excluded and listed, the successor checks the hashes, and the candidate is verified again', async () => {
    const prior = await localRunning();
    const view = await get(h.app, url());
    expect(view.status).toBe(200);
    expect(view.body.resume).toMatchObject({ eligible: true, reasons: [] });
    expect(view.body.baseSha).toBe(BASE);
    expect(view.body.estimate.costUsd).toMatchObject({ provenance: 'estimated' });
    expect(view.body.excludes.join(' ')).toContain('.env');

    const asked = await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ state: 'stopping', mode: 'resume', target: 'cloud' });
    // The same key replays the receipt: one request, one stop.
    expect((await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' })).body).toEqual(asked.body);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM checkpoints`))[0]!['n'])).toBe(1);

    // Nothing for the cloud runner while the prior attempt holds its lease.
    expect((await claim(cloud.token)).lease).toBeNull();
    const beat = await post(h.app, '/v1/runners/heartbeat', { lease: prior }, bearer(local.token));
    expect(beat.body).toMatchObject({ cancelRequested: true, handover: { mode: 'resume', checkpointId: asked.body.checkpointId } });

    const changed = { ...file('server/app.ts', 'export const a = 2;\n'), diff: { binary: false, lines: [['-', 'export const a = 1; // token=sk_live_CANARY0123456789abcdefXYZ'], ['+', 'export const a = 2;'], ['+', '']] as [string, string][] } };
    const sent = await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [changed], [{ path: '.env', reason: 'secret_file_name' }, { path: 'notes.md', reason: 'outside_allowed_paths' }]), bearer(local.token));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ accepted: true, fileCount: 1, excluded: 2 });
    // The checkpoint is not the acknowledgement: still nothing to claim.
    expect((await claim(cloud.token)).lease).toBeNull();
    expect((await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token))).status).toBe(200);

    // Fenced, and waiting for the owner's review: no runner may claim before the release.
    const review = await get(h.app, url());
    expect(review.body.current).toMatchObject({ state: 'awaiting_review', stateLabel: 'Checkpoint ready for review', exclusions: [{ path: '.env', reason: 'secret_file_name' }, { path: 'notes.md', reason: 'outside_allowed_paths' }] });
    expect(review.body.current.patch).toMatchObject({ fileCount: 1, stat: { added: 2, removed: 1 }, files: [{ path: 'server/app.ts', status: 'modified', size: 20, added: 2, removed: 1, hasDiff: true }] });
    expect(review.body.current.estimate.costUsd).toMatchObject({ provenance: 'estimated' });
    expect((await claim(cloud.token)).lease).toBeNull();
    expect((await claim(local.token)).lease).toBeNull();
    // The owner opens the file's diff; a base line that held a secret is shown redacted.
    const id = review.body.current.checkpointId;
    const diff = await get(h.app, `${url()}/diff?checkpointId=${id}&path=server/app.ts`);
    expect(diff.body).toMatchObject({ path: 'server/app.ts', added: 2, removed: 1, redacted: true });
    expect(JSON.stringify(diff.body)).not.toContain('CANARY');
    // Only the owner releases: a runner's credential is refused, and nothing moved.
    const byRunner = await post(h.app, `${url()}/decision`, { checkpointId: id, choice: 'release', idempotencyKey: 'r0' }, bearer(cloud.token));
    expect(byRunner.status).toBeGreaterThanOrEqual(401);
    expect(byRunner.status).toBeLessThanOrEqual(403);
    expect((await get(h.app, url())).body.current.state).toBe('awaiting_review');
    expect((await post(h.app, `${url()}/decision`, { checkpointId: id, choice: 'release', idempotencyKey: 'r1' })).body).toMatchObject({ state: 'fenced' });

    // A local runner never takes it now, and the task says why; the cloud runner does, at the next fence.
    expect((await claim(local.token)).lease).toBeNull();
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.tasks.find((x: any) => x.taskId === 'T1').placementBlock).toBe('handover_held_for_cloud');
    const next = await claim(cloud.token);
    expect(next.lease).toMatchObject({ taskId: 'T1', location: 'cloud', fence: prior.fence + 1, handover: { mode: 'resume', priorAttemptId: prior.attemptId, baseSha: BASE, fileCount: 1 } });
    const successor = refOf(next.lease);

    const log = await events();
    const fenced = log.find((e) => e.type === 'attempt.fenced')!;
    const started = log.filter((e) => e.type === 'attempt.started' && e.attemptId === successor.attemptId)[0]!;
    expect(fenced.seq).toBeLessThan(started.seq);
    expect(log.find((e) => e.type === 'attempt.route_changed')!.payload).toMatchObject({ fromAttemptId: prior.attemptId, toAttemptId: successor.attemptId, from: 'local', to: 'cloud' });

    // The successor fetches the checkpoint and checks every hash itself.
    const fetched = await post(h.app, '/v1/runners/checkpoint/fetch', { lease: successor }, bearer(cloud.token));
    expect(fetched.status).toBe(200);
    for (const f of fetched.body.files) expect(createHash('sha256').update(Buffer.from(f.content, 'base64')).digest('hex')).toBe(f.sha256);
    expect(checkpointDigest(fetched.body.baseSha, fetched.body.files)).toBe(fetched.body.patchSha256);
    // Only the lease's own runner may read it.
    expect((await post(h.app, '/v1/runners/checkpoint/fetch', { lease: successor }, bearer(local.token))).status).toBe(409);

    // The prior attempt keeps trying after the handover: every call is refused as stale and recorded.
    expect((await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'completed', headSha: 'c'.repeat(40) } }, bearer(local.token))).body.error.details).toMatchObject({ reason: 'stale_fence' });
    expect((await post(h.app, '/v1/runners/heartbeat', { lease: prior }, bearer(local.token))).status).toBe(409);
    expect((await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'late')]), bearer(local.token))).status).toBe(409);

    await post(h.app, '/v1/runners/heartbeat', { lease: successor, setupComplete: true }, bearer(cloud.token));
    const running = await get(h.app, url());
    expect(running.body.current).toMatchObject({ state: 'running', stateLabel: 'Running', latePublishes: 1, exclusions: [{ path: '.env', reason: 'secret_file_name' }, { path: 'notes.md', reason: 'outside_allowed_paths' }] });
    expect(running.body.current.patch).toMatchObject({ fileCount: 1, files: [{ path: 'server/app.ts', status: 'modified' }] });
    // The successor has its own copy now: the stored one is gone, and the record says so.
    expect(running.body.current.contentDropped).toMatchObject({ reason: 'successor_running' });
    expect((await get(h.app, `${url()}/diff?checkpointId=${id}&path=server/app.ts`)).status).toBe(404);
    // No file content anywhere in the view or the event log.
    const b64 = changed.content;
    expect(JSON.stringify(running.body)).not.toContain(b64);
    expect(JSON.stringify(await events())).not.toContain(b64);

    // An earlier applied record for this run's old candidate does not stand for the combined one: the successor's candidate goes to verification.
    const OLD = 'd'.repeat(40);
    await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator) VALUES (${TENANT}, ${PROJECT}, 'rec_old', ${RUN}, 'verification_record', ${'9'.repeat(64)}, ${OLD}, 'internal', ${JSON.stringify({ recordId: 'rec_old', candidateSha: OLD, applied: true, checkRunIds: [] })}::jsonb)`);
    const NEW = 'e'.repeat(40);
    expect((await post(h.app, '/v1/runners/result', { lease: successor, result: { outcome: 'completed', headSha: NEW, changeManifestSha256: 'f'.repeat(64) } }, bearer(cloud.token))).status).toBe(200);
    const [status] = await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 'T1'`);
    expect(status!['status']).toBe('verifying');
    expect((await t.db.execute(sql`SELECT lifecycle FROM runs`))[0]!['lifecycle']).not.toBe('ready_for_review');
    expect(await loadLatestAppliedRecord(t.db, { tenantId: TENANT, projectId: PROJECT, sha: NEW })).toBeNull();
  });

  it('refuses restricted work, and its runner cannot send a checkpoint', async () => {
    await t.db.insert(schema.modelAssignments).values({ tenantId: TENANT, projectId: PROJECT, scopeKind: 'role', scopeKey: 'backend', revision: 1, provider: 'test-device', model: 'device-1', updatedBy: 'test' });
    const prior = await localRunning({ classification: 'restricted' });
    const view = await get(h.app, url());
    expect(view.body.resume).toMatchObject({ eligible: false, reasons: ['restricted_work'] });
    expect(view.body.resume.reasonText[0]).toMatch(/stays on this device/);
    expect(view.body.restart).toMatchObject({ eligible: true, target: 'local' });
    const refused = await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'handover_refused', details: { reason: 'restricted_work' } });
    const sent = await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'restricted body')]), bearer(local.token));
    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe('checkpoint_restricted');
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM checkpoints`))[0]!['n'])).toBe(0);
  });

  it('a checkpoint that cannot be resumed safely offers a restart from the persisted input with its estimated cost, and opens no duplicate approval', async () => {
    const prior = await localRunning();
    await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    const big = Array.from({ length: 5 }, (_, i) => file(`server/f${i}.ts`, 'y'.repeat(500 * 1024)));
    const sent = await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, big), bearer(local.token));
    expect(sent.status).toBe(422);
    expect(sent.body.error).toMatchObject({ code: 'checkpoint_refused', details: { reason: 'checkpoint_too_large' } });
    // The prior attempt asks for an approval as it stops: the stop wins, and no approval is opened for a fenced attempt.
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'approval_requested', reason: 'needs migration', operation: 'destructive_data_migration' } }, bearer(local.token));
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM approvals`))[0]!['n'])).toBe(0);

    const offered = await get(h.app, url());
    expect(offered.body.current).toMatchObject({ state: 'restart_offered', refusal: { code: 'checkpoint_too_large' } });
    expect(offered.body.current.estimate.costUsd).toMatchObject({ provenance: 'estimated' });
    expect(offered.body.current.refusal.text).toMatch(/larger than/);
    const list = await get(h.app, `/v1/projects/${PROJECT}/handovers`);
    expect(list.body.records.map((r: any) => r.state)).toEqual(['restart_offered']);
    expect((await claim(cloud.token)).lease).toBeNull();

    const chosen = await post(h.app, `${url()}/decision`, { checkpointId: offered.body.current.checkpointId, choice: 'restart', idempotencyKey: 'd1' });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ state: 'fenced', mode: 'restart' });
    const next = await claim(cloud.token);
    expect(next.lease).toMatchObject({ location: 'cloud', fence: prior.fence + 1, handover: { mode: 'restart', patchSha256: null } });
    expect((await post(h.app, '/v1/runners/checkpoint/fetch', { lease: refOf(next.lease) }, bearer(cloud.token))).status).toBe(404);

    // The successor's own approval request opens exactly one approval; the fenced attempt's late one is refused.
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'approval_requested', reason: 'again', operation: 'destructive_data_migration' } }, bearer(local.token));
    await post(h.app, '/v1/runners/result', { lease: refOf(next.lease), result: { outcome: 'approval_requested', reason: 'needs migration', operation: 'destructive_data_migration' } }, bearer(cloud.token));
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM approvals`))[0]!['n'])).toBe(1);
  });

  it('a required excluded file refuses with its reason; a tampered stored checkpoint is never served', async () => {
    const prior = await localRunning();
    await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    const refused = await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'x')], [{ path: 'server/.env.local', reason: 'secret_file_name' }]), bearer(local.token));
    expect(refused.body.error).toMatchObject({ code: 'checkpoint_refused', details: { reason: 'required_file_excluded' } });
    // A good checkpoint sent after the refusal replaces it.
    expect((await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'good')]), bearer(local.token))).status).toBe(200);
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token));
    await post(h.app, `${url()}/decision`, { checkpointId: (await get(h.app, url())).body.current.checkpointId, choice: 'release', idempotencyKey: 'r1' });
    const next = await claim(cloud.token);
    await t.db.execute(sql`UPDATE checkpoints SET content = jsonb_build_object('server/app.ts', ${Buffer.from('evil').toString('base64')}::text)`);
    const fetched = await post(h.app, '/v1/runners/checkpoint/fetch', { lease: refOf(next.lease) }, bearer(cloud.token));
    // 422, not 409: the lease is still good, so the runner reports the refusal (and starts nothing) rather than treating it as a lost lease.
    expect(fetched.status).toBe(422);
    expect(fetched.body.error.code).toBe('checkpoint_tampered');
  });

  it('says why a task cannot continue in cloud', async () => {
    await localRunning();
    await t.db.execute(sql`DELETE FROM runners WHERE location = 'cloud'`);
    const view = await get(h.app, url());
    expect(view.body.resume).toMatchObject({ eligible: false, reasons: ['no_cloud_runner'] });
    const refused = await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k2' });
    expect(refused.body.error).toMatchObject({ code: 'handover_refused', details: { reason: 'no_cloud_runner' } });
    expect((await get(h.app, url('nope'))).status).toBe(404);
  });

  it('a replan while a restart is offered closes that handover, and the next one on the new revision is accepted (case A)', async () => {
    const prior = await localRunning();
    expect((await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' })).status).toBe(202);
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token));
    const offered = (await get(h.app, url())).body.current;
    expect(offered.state).toBe('restart_offered');
    await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
    const replanned = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 1, tasks: [specFor('T1', { revision: 2, baseSha: BASE, allowedPaths: ['server'] })] });
    expect(replanned.status, JSON.stringify(replanned.body)).toBe(201);
    expect((await t.db.execute(sql`SELECT state, closed_reason FROM checkpoints`))[0]).toMatchObject({ state: 'closed', closed_reason: 'replanned' });
    // An answer to the old offer changes nothing true now: refused.
    expect((await post(h.app, `${url()}/decision`, { checkpointId: offered.checkpointId, choice: 'restart', idempotencyKey: 'd1' })).status).toBe(409);
    const again = await claim(local.token);
    expect(again.lease).toMatchObject({ revision: 2 });
    h.clock.advance(1);
    const second = await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k2' });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    const list = await get(h.app, `/v1/projects/${PROJECT}/handovers`);
    expect(list.body.records.map((r: any) => [r.revision, r.state])).toEqual([[2, 'stopping'], [1, 'closed']]);
    expect(list.body.records[1].closed).toMatchObject({ reason: 'replanned' });
  });

  it('a run cancel while a handover is fenced closes it with the run', async () => {
    const prior = await localRunning();
    await post(h.app, url(), { mode: 'restart', idempotencyKey: 'k1' });
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token));
    expect((await get(h.app, url())).body.current.state).toBe('fenced');
    const cancelled = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c1' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    expect((await t.db.execute(sql`SELECT state, closed_reason FROM checkpoints`))[0]).toMatchObject({ state: 'closed', closed_reason: 'run_cancelled' });
    expect((await claim(cloud.token)).lease).toBeNull();
  });

  it('a restricted attempt is refused before its body is read, whatever the body holds', async () => {
    await t.db.insert(schema.modelAssignments).values({ tenantId: TENANT, projectId: PROJECT, scopeKind: 'role', scopeKey: 'backend', revision: 1, provider: 'test-device', model: 'device-1', updatedBy: 'test' });
    const prior = await localRunning({ classification: 'restricted' });
    // A body that would not even parse: the refusal comes first, so nothing in it is validated or kept.
    const sent = await post(h.app, '/v1/runners/checkpoint', { lease: prior, files: 'not a list', home: '/Users/me' }, bearer(local.token));
    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe('checkpoint_restricted');
  });

  it('an earlier applied record for the prior attempt\'s own candidate does not make the successor\'s ready', async () => {
    const prior = await localRunning();
    await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    const PRIOR_SHA = 'b'.repeat(40);
    await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'x')]), bearer(local.token));
    // The prior attempt acknowledges with a commit of its own: the stop wins, and that commit is only history.
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'completed', headSha: PRIOR_SHA, changeManifestSha256: 'f'.repeat(64) } }, bearer(local.token));
    await t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result) VALUES (${TENANT}, ${PROJECT}, 'chk_old', 'T1', 1, ${prior.attemptId}, 'FB-01', 'v1', ${PRIOR_SHA}, 'passed')`).catch(() => undefined);
    await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator) VALUES (${TENANT}, ${PROJECT}, 'rec_prior', ${RUN}, 'verification_record', ${'9'.repeat(64)}, ${PRIOR_SHA}, 'internal', ${JSON.stringify({ recordId: 'rec_prior', candidateSha: PRIOR_SHA, applied: true, checkRunIds: ['chk_old'] })}::jsonb)`);
    await post(h.app, `${url()}/decision`, { checkpointId: (await get(h.app, url())).body.current.checkpointId, choice: 'release', idempotencyKey: 'r1' });
    const next = await claim(cloud.token);
    // Even a successor that reports the very same commit is verified again: its task goes to verifying, not verified, and the run is not ready.
    expect((await post(h.app, '/v1/runners/result', { lease: refOf(next.lease), result: { outcome: 'completed', headSha: PRIOR_SHA, changeManifestSha256: 'e'.repeat(64) } }, bearer(cloud.token))).status).toBe(200);
    expect((await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 'T1'`))[0]!['status']).toBe('verifying');
    expect((await t.db.execute(sql`SELECT lifecycle FROM runs`))[0]!['lifecycle']).not.toBe('ready_for_review');
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE type IN ('verification.passed', 'task.verified')`))[0]!['n'])).toBe(0);
  });

  it('a pull request opened before the handover is not duplicated after it, and reads out of date', async () => {
    // The run already had a reviewable change for its earlier work, and T1 was added by a later plan.
    await seedTask(t.db, specFor('T0', { baseSha: BASE, allowedPaths: ['tests/backend'] }), 'verified');
    await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, parts, status) VALUES (${TENANT}, ${PROJECT}, 'cand_1', ${RUN}, 'main', ${'c'.repeat(40)}, ${BASE}, ${JSON.stringify([{ taskId: 'T0', revision: 1 }])}::jsonb, 'assembled')`);
    await t.db.execute(sql`INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, base_ref, pr_number, url, status) VALUES (${TENANT}, ${PROJECT}, ${RUN}, 'r', ${'c'.repeat(40)}, 'selarikru/run_a', 'main', 7, 'https://github.com/o/r/pull/7', 'open')`);
    const prior = await localRunning();
    const before = (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.changeRequests;
    expect(before).toHaveLength(1);
    expect(before[0].outOfDate).toMatchObject({ reason: 'superseded' });
    await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'x')]), bearer(local.token));
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token));
    await post(h.app, `${url()}/decision`, { checkpointId: (await get(h.app, url())).body.current.checkpointId, choice: 'release', idempotencyKey: 'r1' });
    const next = await claim(cloud.token);
    await post(h.app, '/v1/runners/result', { lease: refOf(next.lease), result: { outcome: 'completed', headSha: 'e'.repeat(40), changeManifestSha256: 'e'.repeat(64) } }, bearer(cloud.token));
    // Still one pull request for the run, the same one, and it must not be merged as it stands.
    const after = (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.changeRequests;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ prNumber: 7, candidateSha: 'c'.repeat(40) });
    expect(after[0].outOfDate).toMatchObject({ reason: 'superseded' });
  });

  it('a blocked task\'s handover offers only declining: a release or a restart is refused with handover_task_blocked (INFRA=1)', async () => {
    await h.app.close();
    const clock = testClock();
    h = { ...makeHarness(t, { caps: { ...CAPS, maxInfraRetries: 1 } }, POLICY, { scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY }), now: clock.now }), clock };
    await h.app.ready();
    const prior = await localRunning();
    await post(h.app, url(), { mode: 'resume', idempotencyKey: 'k1' });
    await post(h.app, '/v1/runners/checkpoint', checkpointBody(prior, [file('server/app.ts', 'x')]), bearer(local.token));
    await post(h.app, '/v1/runners/result', { lease: prior, result: { outcome: 'failed', reason: 'handover' } }, bearer(local.token));
    const id = (await get(h.app, url())).body.current.checkpointId;
    await post(h.app, `${url()}/decision`, { checkpointId: id, choice: 'release', idempotencyKey: 'r1' });
    for (let i = 0; i < 2; i++) {
      expect((await claim(cloud.token)).lease).not.toBeNull();
      clock.advance(70);
      await createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY }).expireLeases(clock.now());
      clock.advance(60);
      await t.db.execute(sql`UPDATE runners SET last_seen_at = ${clock.now().toISOString()}::timestamptz`);
    }
    expect((await claim(cloud.token)).lease).toBeNull();
    const view = (await get(h.app, url())).body;
    expect(view.status).toBe('blocked');
    expect(view.current).toMatchObject({ state: 'restart_offered', refusal: { code: 'infra_retries_exhausted' }, taskBlocked: true });
    const refused = await post(h.app, `${url()}/decision`, { checkpointId: id, choice: 'restart', idempotencyKey: 'd1' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('handover_task_blocked');
    expect((await post(h.app, `${url()}/decision`, { checkpointId: id, choice: 'decline', idempotencyKey: 'd2' })).body).toMatchObject({ state: 'declined' });
  });
});
