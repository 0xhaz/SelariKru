import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendUsage, correctUsage, InvalidUsageEntry, loadUsageSummary, readUsageEntries, schema, sql, withTx, type NewUsageEntry } from '@selarikru/persistence';
import { reconcileObservedCost, runUsageLines, stopForExhaustedBudget, type Lease, type Scheduler } from './index.ts';
import {
  CAPS, PROJECT, RUN, TENANT, capsWith, countRows, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, testClock, type TestClock, type TestDb,
} from '../test/helpers.ts';

let t: TestDb;
let s: Scheduler;
let clock: TestClock;
const scope = { tenantId: TENANT, projectId: PROJECT, runId: RUN };

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db, { limitUsd: 10 });
  clock = testClock();
  s = makeScheduler(t.db, clock);
});

/** Passes time with a live worker: heartbeats keep the lease from lapsing. */
const elapse = async (lease: Lease, seconds: number) => {
  for (let left = seconds; left > 0; left -= 30) {
    clock.advance(Math.min(30, left));
    expect((await s.heartbeat(lease)).ok).toBe(true);
  }
};

const claimAndPublish = async (taskId: string, role: string, result: Parameters<Scheduler['publishResult']>[1], seconds = 100) => {
  await seedTask(t.db, specFor(taskId, { role }));
  const lease = (await s.claimNext(runner(`r_${taskId}`), capsWith(5)))!;
  await elapse(lease, seconds);
  const published = await s.publishResult(lease, result);
  expect(published.ok).toBe(true);
  return lease;
};

const append = (e: Partial<NewUsageEntry> & Pick<NewUsageEntry, 'dedupeKey' | 'role' | 'metric' | 'quantity' | 'provenance' | 'source'>) =>
  withTx(t.db, (tx) => appendUsage(tx, { ...scope, recordedAt: clock.now(), ...e }));
const time = (dedupeKey: string, role: string, seconds: string, over: Partial<NewUsageEntry> = {}) =>
  append({ dedupeKey, role, metric: 'worker_seconds', quantity: seconds, provenance: 'observed', source: 'controller_clock', phase: 'active', host: 'local', basis: 'measured', ...over });
const summary = () => loadUsageSummary(t.db, scope);

describe('usage ledger', () => {
  it('tokens by role with provenance', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0.05, reportedUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheCreationTokens: null } });
    await claimAndPublish('b', 'frontend', { outcome: 'completed' });
    await append({ dedupeKey: 'lead-call-1', role: 'lead', metric: 'input_tokens', quantity: '900', provenance: 'observed', source: 'provider_response' });

    const { tokensByRole } = await summary();
    expect(tokensByRole['backend']).toMatchObject({
      input_tokens: { value: '100', provenance: 'estimated' }, output_tokens: { value: '50', provenance: 'estimated' }, cache_read_tokens: { value: '7', provenance: 'estimated' },
      // Unknown stays null, never zero.
      cache_creation_tokens: { value: null, provenance: 'unavailable', unavailableEntries: 1 },
    });
    expect(tokensByRole['frontend']!.input_tokens).toEqual({ value: null, provenance: 'unavailable', unavailableEntries: 1 });
    expect(tokensByRole['lead']!.input_tokens).toEqual({ value: '900', provenance: 'observed', unavailableEntries: 0 });
  });

  it('time spent setting up a toolchain counts as setup even when that setup failed', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'infrastructure_failed', reason: 'provisioning_failed: x', reportedUsage: { setupSeconds: 20 } }, 100);
    const { workerSeconds } = await summary();
    expect(workerSeconds.byPhase.setup).toMatchObject({ value: '20', provenance: 'estimated' });
  });

  it('worker-hours include setup, idle, abandoned', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedUsage: { setupSeconds: 20, idleSeconds: 5 } }, 100);

    await seedTask(t.db, specFor('b'));
    await s.claimNext(runner('r2'), CAPS);
    clock.advance(120);
    expect(await s.expireLeases(clock.now())).toMatchObject([{ reason: 'lease_expired' }]);

    const { workerSeconds } = await summary();
    expect(workerSeconds.byPhase.setup).toMatchObject({ value: '20', provenance: 'estimated' });
    expect(workerSeconds.byPhase.idle).toMatchObject({ value: '5', provenance: 'estimated' });
    expect(workerSeconds.byPhase.active).toMatchObject({ value: '75', provenance: 'estimated' });
    // Counted to when the lease lapsed (60 s after the claim), not to when the reaper ran.
    expect(workerSeconds.byPhase.abandoned).toMatchObject({ value: '60', provenance: 'estimated' });
    expect(workerSeconds.byHost.local.measured.value).toBe('160');
    expect(workerSeconds.total.measured.value).toBe('160');
    // Nothing billed was recorded: unknown, not zero.
    expect(workerSeconds.total.billed).toEqual({ value: null, provenance: 'unavailable', unavailableEntries: 0 });
  });

  it('a delayed reaper counts abandoned time only up to the renewed lease expiry', async () => {
    await seedTask(t.db, specFor('a'));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    await elapse(lease, 30);
    clock.advance(8 * 3600);
    expect(await s.expireLeases(clock.now())).toMatchObject([{ reason: 'lease_expired' }]);
    expect((await summary()).workerSeconds.byPhase.abandoned).toMatchObject({ value: '90', provenance: 'estimated' });
  });

  it('a delayed reaper counts abandoned time only up to the attempt deadline', async () => {
    await seedTask(t.db, specFor('a', { timeoutSeconds: 40 }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    await elapse(lease, 30);
    clock.advance(8 * 3600);
    expect(await s.expireLeases(clock.now())).toMatchObject([{ reason: 'attempt_timeout' }]);
    expect((await summary()).workerSeconds.byPhase.abandoned).toMatchObject({ value: '40', provenance: 'estimated' });
  });

  it('an attempt with no worker breakdown is fully observed active time', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed' }, 90);
    expect((await summary()).workerSeconds.byPhase.active).toEqual({ value: '90', provenance: 'observed', unavailableEntries: 0 });
  });

  it('a worker breakdown larger than the observed time is ignored', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedUsage: { setupSeconds: 500 } }, 90);
    const { workerSeconds } = await summary();
    expect(workerSeconds.total.measured.value).toBe('90');
    expect(workerSeconds.byPhase.setup.value).toBeNull();
  });

  it('integration hours counted inside host totals, not added again', async () => {
    await time('coding', 'backend', '3600');
    await time('integrate', 'integration', '1800', { source: 'integration' });
    await time('verify', 'verification', '900', { source: 'verifier' });
    await time('cloud-coding', 'backend', '600', { host: 'cloud' });

    const { workerSeconds } = await summary();
    expect(workerSeconds.byHost.local.measured.value).toBe('6300');
    expect(workerSeconds.byHost.cloud.measured.value).toBe('600');
    expect(workerSeconds.integrationSubtotal.value).toBe('1800');
    expect(workerSeconds.verificationSubtotal.value).toBe('900');
    expect(workerSeconds.total.measured.value).toBe('6900');
  });

  it('billed and measured time are never added together', async () => {
    await time('m', 'backend', '100', { host: 'cloud' });
    await time('b', 'backend', '160', { host: 'cloud', basis: 'billed', source: 'provider_response' });
    const { workerSeconds } = await summary();
    expect(workerSeconds.byHost.cloud).toMatchObject({ measured: { value: '100' }, billed: { value: '160' } });
    expect(workerSeconds.total.measured.value).toBe('100');
  });

  it('budget exhaustion stops new reservations and preserves artifacts', async () => {
    await resetDb(t.db, { limitUsd: 1 });
    const lease = await claimAndPublish('a', 'backend', { outcome: 'completed', headSha: 'head1', reportedCostUsd: 0.2 });
    await t.db.insert(schema.artifacts).values({ tenantId: TENANT, projectId: PROJECT, artifactId: 'art_1', runId: RUN, type: 'change_manifest', sha256: 'f'.repeat(64), sourceRevision: 'head1', classification: 'internal', locator: { attemptId: lease.attemptId } });

    await seedTask(t.db, specFor('b', { maxCostUsd: 0.01 }));
    expect(await s.tryClaim(runner('r2'), capsWith(5))).toMatchObject({ ok: false, skipped: [{ taskId: 'b', reason: 'budget:exceeds_limit' }] });
    expect(await countRows(t.db, 'budget_reservations')).toBe(1);

    // A zero cap reserves nothing, so it would otherwise walk through an exhausted budget.
    await seedTask(t.db, specFor('zero', { maxCostUsd: 0 }));
    const zero = await s.tryClaim(runner('r2'), capsWith(5));
    expect(zero.ok).toBe(false);
    expect(zero.skipped).toContainEqual({ taskId: 'zero', reason: 'budget:unknown_cost' });
    expect(await countRows(t.db, 'budget_reservations')).toBe(1);
    expect(await countRows(t.db, 'attempts', `task_id = 'zero'`)).toBe(0);

    // Spend beyond the limit: a trusted bill arrives above the hold, while another attempt is running under an earlier hold.
    await resetDb(t.db, { limitUsd: 2 });
    const done = await claimAndPublish('c', 'backend', { outcome: 'completed', headSha: 'head2' });
    await t.db.insert(schema.artifacts).values({ tenantId: TENANT, projectId: PROJECT, artifactId: 'art_2', runId: RUN, type: 'change_manifest', sha256: 'e'.repeat(64), sourceRevision: 'head2', classification: 'internal', locator: {} });
    await seedTask(t.db, specFor('d'));
    const running = (await s.claimNext(runner('r3'), capsWith(5)))!;

    const reconciled = await reconcileObservedCost({ codingWorkers: 'claude_code', db: t.db, now: clock.now }, { ...scope, attemptId: done.attemptId, costUsd: '1.500000', operationId: 'bill-1' });
    expect(reconciled).toMatchObject({ reconciled: true, amountUsd: '1.500000' });

    await seedTask(t.db, specFor('e', { maxCostUsd: 0.01 }));
    expect(await s.tryClaim(runner('r4'), capsWith(5))).toMatchObject({ ok: false, skipped: [{ taskId: 'e', reason: 'budget:exceeds_limit' }] });
    // The running attempt is asked to stop, through the existing cancel channel, once and only once.
    const beat = await s.heartbeat(running);
    expect(beat).toMatchObject({ ok: true, value: { cancelRequested: true } });
    expect(await countRows(t.db, 'task_commands', `command = 'cancel' AND state = 'cancel_requested'`)).toBe(1);
    expect(await stopForExhaustedBudget({ codingWorkers: 'claude_code', db: t.db, now: clock.now }, scope)).toEqual([]);
    expect(await countRows(t.db, 'task_commands')).toBe(1);

    // Nothing was deleted or invalidated.
    expect(await countRows(t.db, 'artifacts')).toBe(1);
    expect(await countRows(t.db, 'attempts')).toBe(2);
    expect(await countRows(t.db, 'budget_reservations')).toBe(2);
    expect(await countRows(t.db, 'task_status', `task_id = 'c' AND status = 'verifying'`)).toBe(1);

    // The end of the attempt names the budget, so it does not read as an owner cancel.
    expect((await s.publishResult(running, { outcome: 'failed', reason: 'stopped' })).ok).toBe(true);
    const cancelled = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.cancelled'`);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!['payload']).toMatchObject({ reason: 'budget_exhausted' });
  });

  it('a limit that is exactly used up asks nothing running to stop', async () => {
    await resetDb(t.db, { limitUsd: 1 });
    await seedTask(t.db, specFor('a'));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(await stopForExhaustedBudget({ codingWorkers: 'claude_code', db: t.db, now: clock.now }, scope)).toEqual([]);
    expect(await s.heartbeat(lease)).toMatchObject({ ok: true, value: { cancelRequested: false } });
  });

  it('opaque harness usage labeled estimated', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0.0793001, reportedUsage: { inputTokens: 6, outputTokens: 531 } });
    const entries = await readUsageEntries(t.db, scope);
    const figures = entries.filter((e) => e.metric !== 'worker_seconds' && e.quantity !== null);
    expect(figures.length).toBeGreaterThan(0);
    for (const e of figures) expect(e).toMatchObject({ provenance: 'estimated', source: 'worker_report' });
    expect((await summary()).costUsd).toEqual({ value: '0.0793', provenance: 'estimated', unavailableEntries: 0 });

    // No path, neither the API nor the database, lets a self-report read as observed.
    const claim = { dedupeKey: 'lie', role: 'backend', metric: 'input_tokens', quantity: '1', provenance: 'observed' } as const;
    await expect(append({ ...claim, source: 'harness_report' })).rejects.toBeInstanceOf(InvalidUsageEntry);
    await expect(append({ ...claim, source: 'worker_report' })).rejects.toBeInstanceOf(InvalidUsageEntry);
    await expect(t.db.execute(sql`
      INSERT INTO usage_entries (tenant_id, project_id, entry_id, dedupe_key, run_id, role, metric, quantity, provenance, source, recorded_at)
      VALUES (${TENANT}, ${PROJECT}, 'u1', 'k1', ${RUN}, 'backend', 'input_tokens', 1, 'observed', 'harness_report', now())`)).rejects.toSatisfy((e: { cause?: { code?: string } }) => e.cause?.code === '23514');
  });

  it('a reported cost frees nothing and an absurd one is unavailable', async () => {
    await resetDb(t.db, { limitUsd: 5 });
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0 });
    await claimAndPublish('b', 'backend', { outcome: 'completed', reportedCostUsd: 1e300 });
    const held = await t.db.select().from(schema.budgetReservations);
    for (const r of held) expect(r).toMatchObject({ amountUsd: '1.000000', amountProvenance: 'estimated', state: 'settled' });
    // 0 is a figure and is kept; a figure beyond any real cost is not a figure.
    expect((await summary()).costUsd).toEqual({ value: '0', provenance: 'estimated', unavailableEntries: 1 });
  });

  it('a retried publish and a late fenced publish add nothing', async () => {
    const lease = await claimAndPublish('a', 'backend', { outcome: 'completed', reportedUsage: { inputTokens: 10 } });
    const before = await countRows(t.db, 'usage_entries');
    expect((await s.publishResult(lease, { outcome: 'completed', reportedUsage: { inputTokens: 999 } })).ok).toBe(true);
    expect(await countRows(t.db, 'usage_entries')).toBe(before);

    await seedTask(t.db, specFor('b'));
    const lost = (await s.claimNext(runner('r2'), CAPS))!;
    clock.advance(120);
    await s.expireLeases(clock.now());
    const count = await countRows(t.db, 'usage_entries');
    expect((await s.publishResult(lost, { outcome: 'completed', reportedCostUsd: 3 })).ok).toBe(false);
    expect(await countRows(t.db, 'usage_entries')).toBe(count);
  });

  it('usage rows are append-only and corrected by a new row', async () => {
    const id = await append({ dedupeKey: 'c1', role: 'lead', metric: 'cost_usd', quantity: '1.5', provenance: 'estimated', source: 'rate_card', rateCardVersion: 'rc-1' });
    expect(await append({ dedupeKey: 'c1', role: 'lead', metric: 'cost_usd', quantity: '9', provenance: 'estimated', source: 'rate_card' })).toBe(id);

    await expect(t.db.execute(sql`UPDATE usage_entries SET quantity = 2`)).rejects.toThrow();
    await expect(t.db.execute(sql`DELETE FROM usage_entries`)).rejects.toThrow();

    await withTx(t.db, (tx) => correctUsage(tx, { tenantId: TENANT, projectId: PROJECT, entryId: id }, 'c1-fix', { quantity: '1.25', provenance: 'observed', source: 'provider_response' }, clock.now()));
    expect((await summary()).costUsd).toEqual({ value: '1.25', provenance: 'observed', unavailableEntries: 0 });
    expect(await countRows(t.db, 'usage_entries')).toBe(2);
  });

  it('a trusted bill reconciles a settled hold; a running or lost attempt stays held', async () => {
    await resetDb(t.db, { limitUsd: 2 });
    const done = await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0.9 });
    const ctx = { db: t.db, now: clock.now, codingWorkers: 'claude_code' as const };
    const input = { ...scope, attemptId: done.attemptId, costUsd: '0.250000', operationId: 'bill-1' };
    expect(await reconcileObservedCost(ctx, input)).toEqual({ reconciled: true, amountUsd: '0.250000' });
    // Replays the receipt.
    expect(await reconcileObservedCost(ctx, input)).toEqual({ reconciled: true, amountUsd: '0.250000' });
    const held = (await t.db.select().from(schema.budgetReservations))[0]!;
    expect(held).toMatchObject({ amountUsd: '0.250000', amountProvenance: 'observed', detail: { reservedUsd: '1.000000' } });
    // The worker's figure was corrected, not added to.
    expect((await summary()).costUsd).toEqual({ value: '0.25', provenance: 'observed', unavailableEntries: 0 });

    await seedTask(t.db, specFor('b'));
    const running = (await s.claimNext(runner('r2'), capsWith(5)))!;
    expect(await reconcileObservedCost(ctx, { ...scope, attemptId: running.attemptId, costUsd: '0.1', operationId: 'x' })).toEqual({ reconciled: false, reason: 'reservation_not_settled' });
    clock.advance(120);
    await s.expireLeases(clock.now());
    expect(await reconcileObservedCost(ctx, { ...scope, attemptId: running.attemptId, costUsd: '0.1', operationId: 'x' })).toEqual({ reconciled: false, reason: 'reservation_not_settled' });
  });

  it('PR usage lines print what is known and say so when nothing is', async () => {
    expect(await runUsageLines(t.db, scope)).toEqual([
      { label: 'Tokens', value: null, unit: 'tokens', provenance: 'unavailable' },
      { label: 'Measured worker-hours', value: null, unit: 'hours', provenance: 'unavailable' },
      { label: 'Billed worker-hours', value: null, unit: 'hours', provenance: 'unavailable' },
      { label: 'Cost', value: null, unit: 'USD', provenance: 'unavailable' },
    ]);

    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0.05, reportedUsage: { inputTokens: 100, costBasis: 'list' } }, 1790);
    await time('integrate', 'integration', '1810', { source: 'integration' });
    const lines = await runUsageLines(t.db, scope);
    expect(lines).toContainEqual({ label: 'Tokens (backend, input)', value: '100', unit: 'tokens', provenance: 'estimated' });
    expect(lines).toContainEqual({ label: 'Tokens (backend, output)', value: null, unit: 'tokens', provenance: 'unavailable' });
    expect(lines).toContainEqual({ label: 'Measured worker-hours, local', value: '1.0000', unit: 'hours', provenance: 'observed' });
    expect(lines).toContainEqual({ label: 'Measured worker-hours, of which integration (already in the host totals)', value: '0.5028', unit: 'hours', provenance: 'observed' });
    expect(lines).toContainEqual({ label: 'Billed worker-hours', value: null, unit: 'hours', provenance: 'unavailable' });
    expect(lines).toContainEqual({ label: 'Cost (list basis)', value: '0.05', unit: 'USD', provenance: 'estimated' });

    const cost = (await readUsageEntries(t.db, scope)).find((e) => e.metric === 'cost_usd')!;
    expect(cost.detail).toMatchObject({ costBasis: 'list' });
    expect(cost.rateCardVersion).toBeNull();
  });

  it('a cost with no stated basis says so', async () => {
    await claimAndPublish('a', 'backend', { outcome: 'completed', reportedCostUsd: 0.05 });
    expect(await runUsageLines(t.db, scope)).toContainEqual({ label: 'Cost (unknown basis)', value: '0.05', unit: 'USD', provenance: 'estimated' });
  });
});
