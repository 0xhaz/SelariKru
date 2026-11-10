import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkpointDigest } from '@selarikru/domain';
import { schema } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { validateCheckpoint } from '@selarikru/protocol';
import { assessHandover, createScheduler, decideHandover, recordCheckpoint, requestHandover, successorCheckpoint, type Lease, type Scheduler, type SchedulerContext } from './index.ts';
import { CAPS, CLOUD_POLICY, PROJECT, RUN, TENANT, TEST_CATALOG, TEST_RUNNER_REPORT, countRows, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb } from '../test/helpers.ts';

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
const handoverRow = async () => (await t.db.execute(sql`SELECT * FROM checkpoints`))[0]!;

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
    expect((await handoverRow())['state']).toBe('fenced');

    // A local runner never takes a task handed to cloud.
    expect((await s.tryClaim(runner('local1'), CAPS)).ok).toBe(false);
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

    // The successor's worker started: the handover reads Running.
    await s.heartbeat(next.lease, undefined, { setupComplete: true });
    expect((await handoverRow())['state']).toBe('running');
  });

  it('refuses and records a late publish from the fenced attempt, and opens no approval for it', async () => {
    await cloudRunnerEnrolled();
    const prior = await localRunning();
    await requestHandover(ctx, key, { mode: 'resume', requestedBy: 'owner', caps: CAPS });
    await checkpoint(prior, upload([file('server/app.ts', 'x\n')]));
    await s.publishResult(prior, { outcome: 'failed', reason: 'handover' });
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
});
