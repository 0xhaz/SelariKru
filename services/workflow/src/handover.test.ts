import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkpointDigest } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { validateCheckpoint } from '@selarikru/protocol';
import postgres from 'postgres';
import { SUCCESSOR_RETRY_LIMIT } from '@selarikru/domain';
import { assessHandover, CLOUD_RUNNER_FRESH_SECONDS, createScheduler, decideHandover, recordCheckpoint, requestHandover, reviewHandovers, successorCheckpoint, type Lease, type Scheduler, type SchedulerContext } from './index.ts';
import { CAPS, CLOUD_POLICY, PROJECT, RUN, TENANT, TEST_DATABASE_URL, TEST_CATALOG, TEST_RUNNER_REPORT, countRows, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb } from '../test/helpers.ts';

const BASE = 'a'.repeat(40);
const key = { tenantId: TENANT, projectId: PROJECT, taskId: 'T1' };

let t: TestDb;
let clock: TestClock;
let s: Scheduler;
let ctx: SchedulerContext;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  ctx = { db: t.db, now: clock.now, policy: CLOUD_POLICY as Policy, catalog: TEST_CATALOG };
  s = createScheduler(ctx);
  // H2: one local slot, one cloud slot, the backend role pinned local. The owner's explicit handover is the only way this backend task reaches cloud.
  await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'H2', cloudDestination: 'cloud-sandbox-eu' })}::jsonb`);
});

const file = (path: string, body: string) => {
  const bytes = Buffer.from(body);
  return { path, status: 'modified' as const, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, executable: false, content: bytes.toString('base64') };
};
const upload = (files: ReturnType<typeof file>[], exclusions: { path: string; reason: 'secret_file_name' | 'outside_allowed_paths' }[] = []) => ({ baseSha: BASE, files, exclusions, patchSha256: checkpointDigest(BASE, files) });

async function cloudRunnerEnrolled(id = 'cloud1'): Promise<void> {
  await t.db.insert(schema.runners).values({ tenantId: TENANT, runnerId: id, location: 'cloud', tokenHash: `hash-${id}`, harnessReport: TEST_RUNNER_REPORT as never, createdAt: clock.now(), lastSeenAt: clock.now(), lastPolledAt: clock.now() });
}

async function localRunning(over: Parameters<typeof specFor>[1] = {}): Promise<Lease> {
  await seedTask(t.db, specFor('T1', { baseSha: BASE, allowedPaths: ['server'], ...over }));
  const lease = await s.claimNext(runner('local1'), CAPS);
  if (!lease) throw new Error('no local claim');
  expect(lease.location).toBe('local');
  return lease;
}

/** What the runner route does: the protocol's validator, run against the task revision the workflow reads under its lock. */
const checkpoint = (lease: Lease, u: ReturnType<typeof upload>) => recordCheckpoint(ctx, lease, (task) => validateCheckpoint(u, task));

const events = async () => (await t.db.execute(sql`SELECT sequence, type, attempt_id, payload FROM events ORDER BY sequence`)).map((r) => ({ seq: Number(r['sequence']), type: String(r['type']), attemptId: r['attempt_id'] as string | null, payload: r['payload'] as Record<string, unknown> }));
const handoverRow = async () => (await t.db.execute(sql`SELECT * FROM checkpoints ORDER BY requested_at DESC, checkpoint_id DESC`))[0]!;
/** The owner's release of a reviewed checkpoint: only this lets a successor claim. */
const release = async () => decideHandover(ctx, key, String((await handoverRow())['checkpoint_id']), 'release', 'owner');

describe('checkpoint continuation', () => {
  it('assesses eligibility from placement, data, budget and an enrolled cloud runner', async () => {
    await localRunning();
    expect(await assessHandover(ctx, key, CAPS)).toMatchObject({ resume: { eligible: false, reasons: ['no_cloud_runner'] } });
    await cloudRunnerEnrolled();
    const a = await assessHandover(ctx, key, CAPS);
    expect(a.resume).toEqual({ eligible: true, reasons: [] });
    expect(a.baseSha).toBe(BASE);
    expect(a.estimate.costUsd).toMatchObject({ provenance: 'estimated' });
    expect(a.estimate.costUsd.value).toBeGreaterThan(0);
    // The run's budget cannot reserve a second worst-case hold.
    await t.db.execute(sql`UPDATE runs SET budget = '{"limitUsd": 1}'::jsonb`);
    expect((await assessHandover(ctx, key, CAPS)).resume).toMatchObject({ eligible: false, reasons: ['budget_insufficient'] });
    // A run without cloud slots does not allow it.
    await t.db.execute(sql`UPDATE runs SET budget = '{"limitUsd": 1000}'::jsonb, placement = ${JSON.stringify({ mode: 'L2', cloudDestination: null })}::jsonb`);
    expect((await assessHandover(ctx, key, CAPS)).resume.reasons).toContain('cloud_not_allowed');
  });

  it('refuses restricted work and offers only a local restart from the persisted input', async () => {
    await cloudRunnerEnrolled();
    await seedTask(t.db, specFor('T1', { baseSha: BASE, allowedPaths: ['server'], classification: 'restricted' }));
    // Restricted work runs on a device model, on the local runner.
    await t.db.insert(schema.modelAssignments).values({ tenantId: TENANT, projectId: PROJECT, scopeKind: 'role', scopeKey: 'backend', revision: 1, provider: 'test-device', model: 'device-1', updatedBy: 'test' });
    const lease = await s.claimNext(runner('local1'), CAPS);
    expect(lease).not.toBeNull();
    const a = await assessHandover(ctx, key, CAPS);
    expect(a.resume).toMatchObject({ eligible: false, reasons: ['restricted_work'] });
    expect(a.restart).toMatchObject({ eligible: true, target: 'local' });
    expect(await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS })).toMatchObject({ ok: false, error: { reason: 'restricted_work' } });
    expect(await countRows(t.db, 'checkpoints')).toBe(0);
    // The restart it is offered stays on a local runner, through the same fence.
    expect(await requestHandover(ctx, key, { mode: 'restart', requestedBy: 'owner', caps: CAPS })).toMatchObject({ ok: true, value: { mode: 'restart', target: 'local' } });
    expect((await s.heartbeat(lease!)).ok && (await s.heartbeat(lease!))).toMatchObject({ ok: true, value: { handover: { mode: 'restart' } } });
    await s.publishResult(lease!, { outcome: 'failed', reason: 'worker_failed' });
    expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(false);
    const again = await s.tryClaim(runner('local1'), CAPS);
    expect(again).toMatchObject({ ok: true, lease: { location: 'local', fence: lease!.fence + 1, handover: { mode: 'restart', patchSha256: null } } });
  });

  it('fences the prior attempt before the successor can claim, and the successor starts from the checked checkpoint', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    const asked = await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    expect(asked).toMatchObject({ ok: true, value: { state: 'stopping', mode: 'resume', target: 'cloud' } });

    // The stop is delivered on the next heartbeat, and says it is a handover, so the runner checkpoints rather than just stopping.
    const beat = await s.heartbeat(prior);
    expect(beat).toMatchObject({ ok: true, value: { cancelRequested: true, handover: { mode: 'resume' } } });

    // While the prior attempt holds its lease no successor can claim, on any runner.
    expect(await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).toMatchObject({ ok: false });
    expect(await countRows(t.db, 'attempts')).toBe(1);

    const recorded = await checkpoint(prior, upload([file('server/app.ts', 'export const a = 2;\n')], [{ path: '.env', reason: 'secret_file_name' }]));
    expect(recorded).toMatchObject({ ok: true, value: { fileCount: 1, excluded: 1 } });
    const row = await handoverRow();
    expect(row['exclusions']).toEqual([{ path: '.env', reason: 'secret_file_name' }]);

    // Still not claimable: the checkpoint is not the acknowledgement; the attempt ending is.
    expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(false);
    const ack = await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    expect(ack).toMatchObject({ ok: true, value: { taskStatus: 'ready' } });
    // The prior attempt is fenced, and its checked checkpoint waits for the owner's review: no runner may claim until it is released.
    expect((await handoverRow())['state']).toBe('awaiting_review');
    expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(false);
    expect(await release()).toMatchObject({ ok: true, value: { state: 'fenced' } });
    expect((await handoverRow())['released_by']).toBe('owner');

    // A local runner never takes a task handed to cloud, and says why on the task.
    expect((await s.tryClaim(runner('local1'), CAPS)).ok).toBe(false);
    expect((await statusOf(t.db, 'T1')).status).toBe('ready');
    expect((await t.db.execute(sql`SELECT placement_block FROM task_status`))[0]!['placement_block']).toBe('handover_held_for_cloud');
    const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    if (!next.ok) throw new Error(`no successor: ${next.reason} ${JSON.stringify(next.skipped)}`);
    expect(next.lease).toMatchObject({ location: 'cloud', revision: prior.revision, fence: prior.fence + 1, handover: { mode: 'resume', priorAttemptId: prior.attemptId, baseSha: BASE, patchSha256: row['patch_sha256'] } });

    const log = await events();
    const fenced = log.find((e) => e.type === 'attempt.fenced')!;
    const routed = log.find((e) => e.type === 'attempt.route_changed')!;
    const started = log.filter((e) => e.type === 'attempt.started').at(-1)!;
    expect(fenced.attemptId).toBe(prior.attemptId);
    expect(fenced.seq).toBeLessThan(started.seq);
    expect(fenced.seq).toBeLessThan(routed.seq);
    expect(routed.payload).toMatchObject({ fromAttemptId: prior.attemptId, toAttemptId: next.lease.attemptId, from: 'local', to: 'cloud' });
    // No content in any event.
    expect(JSON.stringify(log)).not.toContain(Buffer.from('export const a = 2;\n').toString('base64'));

    const content = await successorCheckpoint(ctx, next.lease);
    expect(content).toMatchObject({ ok: true, value: { baseSha: BASE, files: [{ path: 'server/app.ts' }] } });

    // The successor's worker started: the handover reads Running, and the stored copy of the checkpoint is dropped, with why.
    await s.heartbeat(next.lease, undefined, { setupComplete: true });
    expect(await handoverRow()).toMatchObject({ state: 'running', content: null, diffs: null, content_dropped_reason: 'successor_running' });
    expect((await t.db.execute(sql`SELECT placement_block FROM task_status`))[0]!['placement_block']).toBeNull();
    // The successor ends: the handover closes and holds nothing.
    await s.publishResult(next.lease, { outcome: 'completed', headSha: 'e'.repeat(40) });
    expect(await handoverRow()).toMatchObject({ state: 'closed', closed_reason: 'successor_completed' });
  });

  it('refuses and records a late publish from the fenced attempt, and opens no approval for it', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/app.ts', 'x\n')]));
    const ack = { outcome: 'failed' as const, reason: 'handover' };
    const first = await s.publishResult(prior, ack);
    // A replay of the prior attempt's own acknowledgement is that acknowledgement again, not a late publish.
    expect(await s.publishResult(prior, ack)).toEqual(first);
    await release();
    const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    expect(next.ok).toBe(true);
    // The prior attempt keeps trying to publish after the handover.
    for (const r of [{ outcome: 'completed' as const, headSha: 'b'.repeat(40) }, { outcome: 'approval_requested' as const, reason: 'needs it', operation: 'destructive_data_migration' }, { outcome: 'completed' as const }]) {
      expect(await s.publishResult(prior, r)).toMatchObject({ ok: false, error: { reason: 'stale_fence' } });
    }
    expect(await s.heartbeat(prior)).toMatchObject({ ok: false, error: { reason: 'stale_fence' } });
    expect(await checkpoint(prior, upload([file('server/app.ts', 'late\n')]))).toMatchObject({ ok: false, error: { reason: 'stale_fence' } });
    expect(await countRows(t.db, 'approvals')).toBe(0);
    expect((await handoverRow())['late_publishes']).toBe(3);
    expect((await events()).filter((e) => e.type === 'attempt.publish_refused')).toHaveLength(1);
    expect((await statusOf(t.db, 'T1')).status).toBe('running');
  });

  it('a prior attempt that never acknowledges is fenced at lease expiry, and with no checkpoint a restart is offered with its estimated cost', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    clock.advance(61);
    await s.expireLeases(clock.now());
    const row = await handoverRow();
    expect(row).toMatchObject({ state: 'restart_offered', refusal: 'no_checkpoint' });
    expect((row['estimate'] as any).costUsd).toMatchObject({ provenance: 'estimated' });
    const refused = (await events()).find((e) => e.type === 'checkpoint.refused')!;
    expect(refused.payload).toMatchObject({ reason: 'no_checkpoint', restart: { costUsd: { provenance: 'estimated' } } });
    // Held for the owner's choice: nobody claims it meanwhile.
    expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(false);
    expect((await s.tryClaim(runner('local1'), CAPS)).ok).toBe(false);

    expect(await decideHandover(ctx, key, String(row['checkpoint_id']), 'restart', 'owner')).toMatchObject({ ok: true, value: { state: 'fenced', mode: 'restart' } });
    const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    if (!next.ok) throw new Error(next.reason);
    expect(next.lease.fence).toBe(prior.fence + 1);
    expect(next.lease.handover).toMatchObject({ mode: 'restart', patchSha256: null });
    expect(await successorCheckpoint(ctx, next.lease)).toMatchObject({ ok: false, error: { reason: 'no_checkpoint' } });
  });

  it('a required file the runner had to exclude refuses the resume with a reason, and the owner may keep the task local', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    expect(await checkpoint(prior, upload([file('server/app.ts', 'x')], [{ path: 'server/.env.local', reason: 'secret_file_name' }]))).toMatchObject({ ok: false, error: { reason: 'required_file_excluded' } });
    expect((await handoverRow())['content']).toBeNull();
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'required_file_excluded' });
    expect(await decideHandover(ctx, key, String((await handoverRow())['checkpoint_id']), 'decline', 'owner')).toMatchObject({ ok: true, value: { state: 'declined' } });
    const local = await s.tryClaim(runner('local1'), CAPS);
    expect(local).toMatchObject({ ok: true, lease: { location: 'local' } });
  });

  it('a successor that finds the stored checkpoint changed starts nothing, and a restart is offered', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/app.ts', 'good\n')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    await release();
    const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    if (!next.ok) throw new Error(next.reason);
    await t.db.execute(sql`UPDATE checkpoints SET content = jsonb_build_object('server/app.ts', ${Buffer.from('evil\n').toString('base64')}::text)`);
    expect(await successorCheckpoint(ctx, next.lease)).toMatchObject({ ok: false, error: { reason: 'checkpoint_tampered' } });
    expect(await s.publishResult(next.lease, { outcome: 'infrastructure_failed', reason: 'checkpoint_tampered' })).toMatchObject({ ok: true });
    expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'checkpoint_tampered' });
  });

  it('one open handover per task, and a cancel or an open stop refuses a new one', async () => {
    await cloudRunnerEnrolled();
    await localRunning();
    expect((await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS })).ok).toBe(true);
    expect(await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS })).toMatchObject({ ok: false, error: { reason: 'handover_open' } });
    expect((await assessHandover(ctx, key, CAPS)).resume.reasons).toContain('handover_open');
    void RUN;
  });

  it('a fenced handover that can no longer run in cloud is offered back to the owner, and keeping it local releases the hold (case B)', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/a.ts', 'x')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    await release();
    // The only cloud runner is revoked: nothing can take the task, so the sweep says so once the grace has passed.
    await t.db.execute(sql`UPDATE runners SET revoked_at = now() WHERE location = 'cloud'`);
    expect(await reviewHandovers(ctx, CAPS, clock.now())).toEqual([]);
    clock.advance(CLOUD_RUNNER_FRESH_SECONDS + 1);
    expect(await reviewHandovers(ctx, CAPS, clock.now())).toEqual([String((await handoverRow())['checkpoint_id'])]);
    expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'no_cloud_runner' });
    expect((await events()).filter((e) => e.type === 'checkpoint.refused').at(-1)!.payload).toMatchObject({ reason: 'no_cloud_runner' });
    // The owner keeps it local: the hold is released, the checkpoint discarded with why, and a local runner takes it from the persisted base input.
    expect(await decideHandover(ctx, key, String((await handoverRow())['checkpoint_id']), 'decline', 'owner')).toMatchObject({ ok: true, value: { state: 'declined' } });
    expect(await handoverRow()).toMatchObject({ content: null, content_dropped_reason: 'declined' });
    const local = await s.tryClaim(runner('local1'), CAPS);
    expect(local).toMatchObject({ ok: true, lease: { location: 'local' } });
    expect(local.ok && local.lease.handover).toBeUndefined();
  });

  it('the owner may keep it local while it is fenced or waiting for review', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/a.ts', 'x')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    expect((await handoverRow())['state']).toBe('awaiting_review');
    expect(await decideHandover(ctx, key, String((await handoverRow())['checkpoint_id']), 'decline', 'owner')).toMatchObject({ ok: true, value: { state: 'declined' } });
    expect(await s.tryClaim(runner('local1'), CAPS)).toMatchObject({ ok: true, lease: { location: 'local' } });
  });

  it('a successor lost during setup is offered again to a cloud runner at a new fence, never to a local one, and after the retries the owner decides', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/a.ts', 'x')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    await release();
    let fence = prior.fence;
    for (let i = 0; i <= SUCCESSOR_RETRY_LIMIT; i++) {
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(`no successor ${i}: ${next.reason} ${JSON.stringify(next.skipped)}`);
      expect(next.lease.fence).toBe(fence + 1);
      expect(next.lease.handover).toMatchObject({ mode: 'resume' });
      fence = next.lease.fence;
      clock.advance(120);
      await s.expireLeases(clock.now());
      await t.db.execute(sql`UPDATE runners SET last_seen_at = ${clock.now().toISOString()}::timestamptz, last_polled_at = ${clock.now().toISOString()}::timestamptz`);
      // Never a local claim from the base without the owner deciding.
      clock.advance(60);
      expect((await s.tryClaim(runner('local1'), CAPS)).ok).toBe(false);
      if (i < SUCCESSOR_RETRY_LIMIT) expect(await handoverRow()).toMatchObject({ state: 'fenced', successor_retries: i + 1 });
    }
    expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'successor_failed' });
    expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(false);
  });

  it('a successor lost after its worker started cannot be resumed again: its copy was dropped, so the owner is asked', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/a.ts', 'x')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    await release();
    const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    if (!next.ok) throw new Error(next.reason);
    await s.heartbeat(next.lease, undefined, { setupComplete: true });
    clock.advance(120);
    await s.expireLeases(clock.now());
    expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'successor_lost' });
  });

  it('a reclassification to restricted after the request refuses the checkpoint and stores nothing', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await t.db.execute(sql`UPDATE projects SET classification = 'restricted'`);
    expect(await checkpoint(prior, upload([file('server/a.ts', 'x')]))).toMatchObject({ ok: false, error: { reason: 'restricted_work' } });
    expect(await handoverRow()).toMatchObject({ content: null, files: null, patch_sha256: null, refusal: 'restricted_work' });
  });

  it('a stale row on an earlier revision never blocks a new handover, and an answer to it is refused', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
    const stale = String((await handoverRow())['checkpoint_id']);
    // A revision move that left the row open (a path that predates the close on replan).
    await seedTask(t.db, specFor('T1', { revision: 2, baseSha: BASE, allowedPaths: ['server'] })).catch(() => undefined);
    await t.db.execute(sql`UPDATE task_status SET current_revision = 2, status = 'ready'`);
    expect(await decideHandover(ctx, key, stale, 'restart', 'owner')).toMatchObject({ ok: false, error: { status: 409 } });
    const again = await s.tryClaim(runner('local1'), CAPS);
    if (!again.ok) throw new Error(`${again.reason} ${JSON.stringify(again.skipped)}`);
    expect(await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS })).toMatchObject({ ok: true });
    expect((await t.db.execute(sql`SELECT state, closed_reason FROM checkpoints WHERE checkpoint_id = ${stale}`))[0]).toMatchObject({ state: 'closed', closed_reason: 'stale_revision' });
  });

  it('reads eligibility without locking the run row', async () => {
    await cloudRunnerEnrolled();
    await localRunning();
    const other = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await other.begin(async (q) => {
        await q.unsafe(`SET LOCAL search_path TO ${t.schema}`);
        await q.unsafe(`SET LOCAL lock_timeout = '5s'`);
        await q.unsafe(`SELECT 1 FROM runs FOR UPDATE`);
        // With the run row held elsewhere, a read that took it would wait for this transaction; this one answers first.
        const answered = await Promise.race([assessHandover(ctx, key, CAPS).then(() => 'answered'), new Promise((r) => setTimeout(() => r('waited'), 2_000))]);
        expect(answered).toBe('answered');
      });
    } finally {
      await other.end();
    }
  });

  describe('fix round 2', () => {
    async function released(): Promise<Lease> {
      await cloudRunnerEnrolled();
      const prior = await localRunning();
      await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
      await checkpoint(prior, upload([file('server/a.ts', 'x')]));
      await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
      await release();
      return prior;
    }
    const freshRunners = () => t.db.execute(sql`UPDATE runners SET last_seen_at = ${clock.now().toISOString()}::timestamptz, last_polled_at = ${clock.now().toISOString()}::timestamptz`);
    const statusRevision = async () => Number((await t.db.execute(sql`SELECT row_revision FROM task_status`))[0]!['row_revision']);

    it('when the infrastructure retries run out the task blocks, and the handover says the same (INFRA=1)', async () => {
      const caps = { ...CAPS, maxInfraRetries: 1 };
      await released();
      for (let i = 0; i < 2; i++) {
        const next = await s.tryClaim(runner('cloud1', 'cloud'), caps);
        if (!next.ok) throw new Error(`${i}: ${next.reason}`);
        clock.advance(70);
        await s.expireLeases(clock.now());
        clock.advance(60);
        await freshRunners();
      }
      expect((await s.tryClaim(runner('cloud1', 'cloud'), caps)).ok).toBe(false);
      expect((await statusOf(t.db, 'T1')).status).toBe('blocked');
      expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'infra_retries_exhausted' });
      // The event is at the status row's own revision, not a guess.
      const refused = (await t.db.execute(sql`SELECT aggregate_revision FROM events WHERE type = 'checkpoint.refused' ORDER BY sequence DESC LIMIT 1`))[0]!;
      expect(Number(refused['aggregate_revision'])).toBe(await statusRevision());
      // A blocked task cannot take a release or a restart: only declining is offered, and it is refused nothing.
      const id = String((await handoverRow())['checkpoint_id']);
      expect(await decideHandover(ctx, key, id, 'restart', 'owner')).toMatchObject({ ok: false, error: { reason: 'handover_task_blocked', status: 409 } });
      expect(await decideHandover(ctx, key, id, 'decline', 'owner')).toMatchObject({ ok: true, value: { state: 'declined' } });
    });

    it('a successor whose deadline runs out during setup is lost, and offered again at a new fence (T7.6)', async () => {
      await released();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), { ...CAPS, attemptTimeoutSeconds: 30 });
      if (!next.ok) throw new Error(next.reason);
      clock.advance(31);
      await s.expireLeases(clock.now());
      expect(await handoverRow()).toMatchObject({ state: 'fenced', successor_retries: 1 });
      await freshRunners();
      clock.advance(CAPS.infraRetryBackoffSeconds);
      expect(await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).toMatchObject({ ok: true, lease: { fence: next.lease.fence + 1, handover: { mode: 'resume' } } });
    });

    it('a successor that fails before its worker starts is offered again, not closed and placed anywhere', async () => {
      await released();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(next.reason);
      expect(await s.publishResult(next.lease, { outcome: 'failed', reason: 'task_bundle_failed' })).toMatchObject({ ok: true });
      expect(await handoverRow()).toMatchObject({ state: 'fenced', successor_retries: 1 });
      expect((await s.tryClaim(runner('local1'), CAPS)).ok).toBe(false);
      const again = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      expect(again).toMatchObject({ ok: true, lease: { location: 'cloud', fence: next.lease.fence + 1, handover: { mode: 'resume' } } });
      // After its worker started, a failure is the work's own: the handover closes.
      if (!again.ok) return;
      await s.heartbeat(again.lease, undefined, { setupComplete: true });
      await s.publishResult(again.lease, { outcome: 'failed', reason: 'agent_result_failed' });
      expect(await handoverRow()).toMatchObject({ state: 'closed', closed_reason: 'successor_failed' });
    });

    it('a successor reported blocked before it started is offered to the owner at once, and the event is at the real revision', async () => {
      await released();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(next.reason);
      const startedAt = Number((await t.db.execute(sql`SELECT aggregate_revision FROM events WHERE type = 'attempt.started' ORDER BY sequence DESC LIMIT 1`))[0]!['aggregate_revision']);
      await s.publishResult(next.lease, { outcome: 'blocked', reason: 'toolchain_unresolved' });
      expect((await statusOf(t.db, 'T1')).status).toBe('blocked');
      expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'successor_failed' });
      expect(await decideHandover(ctx, key, String((await handoverRow())['checkpoint_id']), 'restart', 'owner')).toMatchObject({ ok: false, error: { reason: 'handover_task_blocked' } });
      // Every event of the publish is at a revision the row really had, each one after the last: the offer moved it, then the status write moved it again.
      const revs = (await t.db.execute(sql`SELECT aggregate_revision FROM events WHERE sequence > (SELECT max(sequence) FROM events WHERE type = 'attempt.route_changed') ORDER BY sequence`)).map((r) => Number(r['aggregate_revision']));
      expect(revs).toEqual([...revs].sort((a, b) => a - b).filter((r) => r > startedAt));
      expect(Math.max(...revs)).toBe(await statusRevision());
      expect(new Set(revs).size).toBe(2);
    });

    it('after a lost successor the restart estimate includes the cloud attempt\'s time and what it held, labelled estimated', async () => {
      await released();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(next.reason);
      await s.heartbeat(next.lease, undefined, { setupComplete: true });
      const before = (await handoverRow())['estimate'] as { timeSeconds: { value: number } };
      clock.advance(70);
      await s.expireLeases(clock.now());
      const est = (await handoverRow())['estimate'] as { timeSeconds: { value: number; provenance: string }; spentUsd: { value: number; provenance: string } };
      expect(est.timeSeconds.provenance).toBe('estimated');
      expect(est.timeSeconds.value).toBeGreaterThanOrEqual(before.timeSeconds.value + 60);
      expect(est.spentUsd).toMatchObject({ provenance: 'estimated' });
      expect(est.spentUsd.value).toBeGreaterThan(0);
    });

    it('the review sweep keys on when the handover was released, so late publishes do not postpone it', async () => {
      const prior = await released();
      await t.db.execute(sql`UPDATE runners SET revoked_at = now() WHERE location = 'cloud'`);
      for (let i = 0; i < 2; i++) {
        clock.advance(60);
        await s.publishResult(prior, { outcome: 'completed', headSha: 'b'.repeat(40) });
      }
      clock.advance(10);
      expect(await reviewHandovers(ctx, CAPS, clock.now())).toHaveLength(1);
      expect(await handoverRow()).toMatchObject({ state: 'restart_offered', refusal: 'no_cloud_runner' });
      const refused = (await t.db.execute(sql`SELECT aggregate_revision FROM events WHERE type = 'checkpoint.refused' ORDER BY sequence DESC LIMIT 1`))[0]!;
      expect(Number(refused['aggregate_revision'])).toBe(await statusRevision());
    });

    it('migration 0031 closes starting and running rows whose successor attempt has ended', async () => {
      await released();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(next.reason);
      // A successor that ended under code that left its row open.
      await t.db.execute(sql`UPDATE attempts SET ended_at = now(), outcome = 'failed' WHERE attempt_id = ${next.lease.attemptId}`);
      const file0031 = readFileSync(new URL('../../../packages/persistence/migrations/0031_close_ended_successors.sql', import.meta.url), 'utf8');
      for (const stmt of file0031.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) await t.db.execute(sql.raw(stmt));
      expect(await handoverRow()).toMatchObject({ state: 'closed', closed_reason: 'successor_ended', content: null });
    });
  });

  describe('races, with the task row held on a connection of its own', () => {
    /**
     * Holds the task's status row on its own connection (with a lock timeout), starts `racers`, waits (bounded) until `n` of them are queued behind it, then releases it by
     * ending its transaction, always, and returns what the racers did.
     */
    async function heldWhile<T>(n: number, racers: () => Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
      // The pool opens connections as it needs them; it is warmed first, so each racer has one waiting rather than queueing behind another in this process.
      await Promise.all([0, 1, 2, 3].map(() => withTx(t.db, (tx) => tx.execute(sql`SELECT pg_sleep(0.05)`))));
      const other = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
      let started: Promise<T>[] = [];
      try {
        await other.begin(async (q) => {
          await q.unsafe(`SET LOCAL search_path TO ${t.schema}`);
          await q.unsafe(`SET LOCAL lock_timeout = '10s'`);
          await q.unsafe(`SELECT 1 FROM task_status WHERE task_id = 'T1' FOR UPDATE`);
          const [me] = await q.unsafe(`SELECT pg_backend_pid() AS pid`);
          started = racers();
          for (let i = 0; i < 500; i++) {
            // Every backend waiting on this one, directly or behind another waiter for the same row.
            const [row] = await q.unsafe(`WITH RECURSIVE w(pid) AS (SELECT pid FROM pg_stat_activity WHERE ${Number(me!['pid'])} = ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))) SELECT count(*)::int AS n FROM w`);
            if (Number(row!['n']) >= n) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error('the racers never queued behind the held row');
        });
      } finally {
        await other.end();
        // Released either way, and the racers are waited for either way, so none outlives the test.
        await Promise.allSettled(started);
      }
      return Promise.allSettled(started);
    }

    it('the fence and a late publish: one is the acknowledgement, the other is refused and counted, and the fence happens once', async () => {
      await cloudRunnerEnrolled();
      const prior = await localRunning();
      await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
      await checkpoint(prior, upload([file('server/a.ts', 'x')]));
      const out = await heldWhile(2, () => [s.publishResult(prior, { outcome: 'failed', reason: 'handover' }), s.publishResult(prior, { outcome: 'completed', headSha: 'b'.repeat(40) })]);
      const values = out.map((o) => (o.status === 'fulfilled' ? o.value : null));
      expect(values.filter((v) => v?.ok)).toHaveLength(1);
      expect(values.filter((v) => v && !v.ok && v.error.reason === 'stale_fence')).toHaveLength(1);
      expect(await handoverRow()).toMatchObject({ state: 'awaiting_review', late_publishes: 1 });
      expect((await events()).filter((e) => e.type === 'attempt.fenced')).toHaveLength(1);
    });

    it('a successor claim and the prior attempt\'s lease expiry: no successor is granted before the fence', async () => {
      await cloudRunnerEnrolled();
      const prior = await localRunning();
      await requestHandover(ctx, key, { mode: 'restart', requestedBy: 'owner', caps: CAPS });
      clock.advance(61);
      // The expiry queues behind the held row; the claim, which cannot see a running task as claimable, answers at once with nothing.
      const out = await heldWhile(1, () => [s.expireLeases(clock.now()) as Promise<unknown>, s.tryClaim(runner('cloud1', 'cloud'), CAPS) as Promise<unknown>]);
      expect(out[1]).toMatchObject({ status: 'fulfilled', value: { ok: false } });
      expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
      // Whichever went first, the order in the log holds: a successor starts only after the fence.
      if (!(await countRows(t.db, 'attempts', `attempt_id <> '${prior.attemptId}'`))) expect((await s.tryClaim(runner('cloud1', 'cloud'), CAPS)).ok).toBe(true);
      const log = await events();
      const fenced = log.find((e) => e.type === 'attempt.fenced')!;
      const started = log.filter((e) => e.type === 'attempt.started' && e.attemptId !== prior.attemptId);
      expect(started).toHaveLength(1);
      expect(fenced.seq).toBeLessThan(started[0]!.seq);
    });

    it('a successor that cannot apply its checkpoint, and the owner keeping it local at the same moment: the end state is one of the two, never both', async () => {
      await cloudRunnerEnrolled();
      const prior = await localRunning();
      await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
      await checkpoint(prior, upload([file('server/a.ts', 'x')]));
      await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
      await release();
      const next = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
      if (!next.ok) throw new Error(next.reason);
      const id = String((await handoverRow())['checkpoint_id']);
      const out = await heldWhile(2, () => [s.publishResult(next.lease, { outcome: 'infrastructure_failed', reason: 'checkpoint_apply_failed: conflict' }) as Promise<unknown>, decideHandover(ctx, key, id, 'decline', 'owner') as Promise<unknown>]);
      expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
      expect(['restart_offered', 'declined']).toContain(String((await handoverRow())['state']));
      expect(await countRows(t.db, 'checkpoints', `state IN ('stopping', 'awaiting_review', 'fenced', 'starting', 'running', 'restart_offered')`)).toBeLessThanOrEqual(1);
    });
  });
});
