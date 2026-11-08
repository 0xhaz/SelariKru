import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Policy } from '@selarikru/policy';
import { createScheduler } from './index.ts';
import { capacityForMode, place, PLACEMENT_MODES, type Capacity, type PlaceContext } from './placement.ts';
import {
  CAPS, countRows, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, CLOUD_POLICY, type TestClock, type TestDb,
} from '../test/helpers.ts';
import { sql } from 'drizzle-orm';

const DEST = 'cloud-sandbox-eu';
const policy: Policy = {
  policyVersion: 'pl.1', limits: { maxConcurrentTotal: 2, repairAttempts: 2 }, selectedSources: ['repo'],
  destinations: [{ destination: DEST, purpose: 'execution', classifications: ['public', 'internal'] }],
};
const ctx: PlaceContext = { sources: [{ id: 'repo', classification: 'internal' }], destination: DEST, estimatedCost: 1, remainingBudget: 10 };
/** Role `worker` is not pinned by any mode, so mode pins only show where a test asks for backend or frontend. */
const task = (over: Parameters<typeof specFor>[1] = {}) => specFor('t1', { role: 'worker', ...over });
/** A fake capacity table: nothing running, mode limits from the manifest, total 2. */
const cap = (mode: keyof typeof PLACEMENT_MODES, running = { local: 0, cloud: 0 }, total: number | null | undefined = 2): Capacity =>
  capacityForMode(PLACEMENT_MODES[mode], { maxConcurrentTotal: total, running });

describe('place (pure)', () => {
  it('ready task goes local when a slot is free', () => {
    expect(place(task(), cap('L2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
    expect(place(task(), cap('H2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
  });

  it('auto expands to cloud within limits and records reason', () => {
    const r = place(task(), cap('H2', { local: 1, cloud: 0 }), policy, ctx);
    expect(r).toMatchObject({
      target: 'cloud', reason: 'expanded_to_cloud:local_full',
      policy: { decision: 'allow', record: 'policy_decision', reason: 'eligible_cloud_start_within_limits', policyVersion: 'pl.1' },
    });
    expect(JSON.stringify(r)).not.toContain('approval.granted');
  });

  it('expansion beyond the total of 2 is blocked even when the cloud quota would allow it', () => {
    const c = capacityForMode({ id: 'wide', localSlots: 2, cloudSlots: 2 }, { maxConcurrentTotal: 2, running: { local: 1, cloud: 1 } });
    expect(place(task(), c, policy, ctx)).toMatchObject({ blocked: true, reason: 'concurrency_limit_reached', transient: true });
  });

  it('per-location limits can only narrow the total', () => {
    const wide = capacityForMode({ id: 'wide', localSlots: 5, cloudSlots: 5 }, { maxConcurrentTotal: 2, running: { local: 2, cloud: 0 } });
    expect(place(task(), wide, policy, ctx)).toMatchObject({ blocked: true, reason: 'concurrency_limit_reached' });
    const narrow = capacityForMode({ id: 'n', localSlots: 1, cloudSlots: 1 }, { maxConcurrentTotal: 2, running: { local: 1, cloud: 1 } });
    expect(place(task(), narrow, policy, ctx)).toMatchObject({ blocked: true, reason: 'concurrency_limit_reached' });
    const noCloudRoom = capacityForMode({ id: 'n', localSlots: 1, cloudSlots: 1 }, { maxConcurrentTotal: 3, running: { local: 1, cloud: 1 } });
    expect(place(task(), noCloudRoom, { ...policy, limits: { maxConcurrentTotal: 3 } }, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot' });
  });

  it('restricted task never placed in cloud', () => {
    for (const execution of ['cloud', 'eligible_any'] as const) {
      for (const classification of ['restricted', 'secret'] as const) {
        const r = place(task({ execution, classification }), cap('C1'), policy, ctx);
        expect(r, `${execution} ${classification}`).toMatchObject({ blocked: true, reason: 'classification_not_cloud_eligible' });
      }
    }
    // eligible_any stays local when local has room, with a stable reason; it is never moved to cloud when local is full.
    expect(place(task({ classification: 'restricted' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
    expect(place(task({ classification: 'restricted' }), cap('H2', { local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'classification_not_cloud_eligible' });
    // A restricted source feeding a public task is refused by the policy package, not placed.
    const mixed = { ...ctx, sources: [{ id: 'repo', classification: 'restricted' as const }] };
    expect(place(task({ execution: 'cloud' }), cap('C1'), policy, mixed)).toMatchObject({ blocked: true, reason: 'policy_denied:source_not_cloud_eligible' });
  });

  it('missing limit blocks with concrete reason', () => {
    expect(place(task(), cap('L2', undefined, null), policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:maxConcurrentTotal' });
    expect(place(task(), cap('L2', undefined, 0), policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:maxConcurrentTotal' });
    const noCloud: Capacity = { maxConcurrentTotal: 2, local: { limit: 1, running: 0 }, cloud: { running: 0 } };
    expect(place(task({ execution: 'cloud' }), noCloud, policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:cloud' });
    const noLocal: Capacity = { maxConcurrentTotal: 2, local: { limit: null, running: 0 }, cloud: { limit: 1, running: 0 } };
    expect(place(task({ execution: 'local' }), noLocal, policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:local' });
    expect(place(task({ execution: 'cloud' }), cap('C1'), { ...policy, limits: {} }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_limit:maxConcurrentTotal' });
    expect(place(task({ execution: 'cloud' }), cap('C1'), undefined, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_policy' });
  });

  it('a missing execution grant, destination or source selection blocks cloud and never falls back to local', () => {
    const t = task({ execution: 'cloud' });
    expect(place(t, cap('H2'), { ...policy, destinations: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
    expect(place(t, cap('H2'), policy, { ...ctx, destination: null })).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
    expect(place(t, cap('H2'), { ...policy, selectedSources: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:source_not_selected' });
    // eligible_any whose local slot is full is blocked rather than moved when the cloud grant is missing.
    expect(place(task(), cap('H2', { local: 1, cloud: 0 }), { ...policy, destinations: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
  });

  it('configured require_approval is Blocked, not silently started', () => {
    const p: Policy = { ...policy, operations: { start_cloud_worker: 'require_approval' } };
    expect(place(task({ execution: 'cloud' }), cap('C1'), p, ctx)).toMatchObject({ blocked: true, reason: 'approval_required:configured_require_approval:start_cloud_worker' });
  });

  it('execution local/cloud is honoured', () => {
    expect(place(task({ execution: 'local' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'execution_local' });
    expect(place(task({ execution: 'cloud' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'cloud', reason: 'execution_cloud' });
    expect(place(task({ execution: 'local' }), cap('H2', { local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot', transient: true });
  });

  it('a location with zero slots in the mode is disabled with a concrete reason', () => {
    expect(place(task({ execution: 'cloud' }), cap('L1'), policy, ctx)).toMatchObject({ blocked: true, reason: 'location_disabled:cloud' });
    expect(place(task({ execution: 'local' }), cap('C1'), policy, ctx)).toMatchObject({ blocked: true, reason: 'location_disabled:local' });
  });

  describe('manifest modes', () => {
    it('L1: one local coding slot, nothing in cloud', () => {
      expect(place(task(), cap('L1'), policy, ctx)).toMatchObject({ target: 'local' });
      expect(place(task(), cap('L1', { local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot' });
    });
    it('C1: one cloud coding slot, nothing local', () => {
      expect(place(task(), cap('C1'), policy, ctx)).toMatchObject({ target: 'cloud', reason: 'cloud_only_mode' });
      expect(place(task(), cap('C1', { local: 0, cloud: 1 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot' });
    });
    it('H2: backend local, frontend cloud', () => {
      expect(place(task({ role: 'backend' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'role_pinned_local' });
      expect(place(task({ role: 'frontend' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'cloud', reason: 'role_pinned_cloud' });
      // The pin holds when the pinned location is full: no spill over to the other location.
      expect(place(task({ role: 'backend' }), cap('H2', { local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot' });
      expect(place(task({ role: 'frontend' }), cap('H2', { local: 0, cloud: 1 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot' });
      expect(place(task({ role: 'frontend', execution: 'local' }), cap('H2'), policy, ctx)).toMatchObject({ blocked: true, reason: 'execution_conflicts_with_role_pin' });
      expect(place(task({ role: 'backend', classification: 'restricted' }), cap('H2'), policy, ctx)).toMatchObject({ target: 'local' });
      expect(place(task({ role: 'frontend', classification: 'restricted' }), cap('H2'), policy, ctx)).toMatchObject({ blocked: true, reason: 'classification_not_cloud_eligible' });
    });
    it('L2: two local coding slots', () => {
      expect(place(task(), cap('L2', { local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ target: 'local' });
      expect(place(task(), cap('L2', { local: 2, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true });
    });
    it('the manifest modes match the committed manifest values', () => {
      expect(PLACEMENT_MODES.L1).toMatchObject({ localSlots: 1, cloudSlots: 0 });
      expect(PLACEMENT_MODES.C1).toMatchObject({ localSlots: 0, cloudSlots: 1 });
      expect(PLACEMENT_MODES.H2).toMatchObject({ localSlots: 1, cloudSlots: 1, rolePlacement: { backend: 'local', frontend: 'cloud' } });
      expect(PLACEMENT_MODES.L2).toMatchObject({ localSlots: 2, cloudSlots: 0 });
    });
  });
});

describe('placement in claimNext', () => {
  let t: TestDb;
  let clock: TestClock;
  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { clock = testClock(); await resetDb(t.db); });
  const sched = (mode: keyof typeof PLACEMENT_MODES, p: Policy | undefined = CLOUD_POLICY as Policy) =>
    createScheduler({ db: t.db, now: clock.now, policy: p, placement: { mode: PLACEMENT_MODES[mode], cloudDestination: 'cloud-sandbox-eu' } });
  const cloud = (id: string) => runner(id, 'cloud');

  it('a runner only receives tasks placed for its location', async () => {
    const s = sched('H2');
    await seedTask(t.db, specFor('be', { role: 'backend' }));
    await seedTask(t.db, specFor('fe', { role: 'frontend' }));
    expect(await s.claimNext(runner('l1'), CAPS)).toMatchObject({ taskId: 'be', location: 'local' });
    // The local runner would take fe next, but it is placed for cloud.
    expect(await s.tryClaim(runner('l2'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'fe', reason: 'location_mismatch' }] });
    expect(await s.claimNext(cloud('c1'), CAPS)).toMatchObject({ taskId: 'fe', location: 'cloud' });
  });

  it('records placement.decided with the reason and the policy decision, by the scheduler', async () => {
    const s = sched('H2');
    await seedTask(t.db, specFor('fe', { role: 'frontend' }));
    await s.claimNext(cloud('c1'), CAPS);
    const rows = await t.db.execute(sql`SELECT actor_kind, actor_id, payload, attempt_id FROM events WHERE type = 'placement.decided'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['actor_kind']).toBe('scheduler');
    expect(rows[0]!['attempt_id']).not.toBeNull();
    expect(rows[0]!['payload']).toMatchObject({
      target: 'cloud', reason: 'role_pinned_cloud', mode: 'H2', destination: 'cloud-sandbox-eu',
      policyDecision: { decision: 'allow', record: 'policy_decision' },
    });
    expect(await countRows(t.db, 'events', "type = 'approval.granted'")).toBe(0);
  });

  it('restricted task is never claimed by a cloud runner, and nothing moves it', async () => {
    const s = sched('H2');
    await seedTask(t.db, specFor('r1', { role: 'frontend', classification: 'restricted' }));
    expect(await s.tryClaim(cloud('c1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'r1', reason: 'placement_blocked:classification_not_cloud_eligible' }] });
    expect(await s.tryClaim(runner('l1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'r1', reason: 'placement_blocked:classification_not_cloud_eligible' }] });
    expect((await statusOf(t.db, 'r1')).status).toBe('ready');
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('a cloud runner without a policy grant gets nothing; a local-only deployment still works', async () => {
    await seedTask(t.db, specFor('x', { execution: 'cloud' }));
    expect(await createScheduler({ db: t.db, now: clock.now, placement: { mode: PLACEMENT_MODES.C1, cloudDestination: 'cloud-sandbox-eu' } }).tryClaim(cloud('c1'), CAPS)).toMatchObject({ ok: false, skipped: [{ reason: 'placement_blocked:policy_denied:missing_policy' }] });
    await seedTask(t.db, specFor('y', { execution: 'local' }));
    expect(await createScheduler({ db: t.db, now: clock.now, placement: { mode: PLACEMENT_MODES.L1, cloudDestination: null } }).claimNext(runner('l1'), CAPS)).toMatchObject({ taskId: 'y' });
  });

  it('with no placement configured, local runners work and cloud is denied by the missing limit', async () => {
    const s = makeScheduler(t.db, clock);
    await seedTask(t.db, specFor('c', { execution: 'cloud' }));
    expect(await s.tryClaim(runner('l1'), CAPS)).toMatchObject({ skipped: [{ reason: 'placement_blocked:missing_limit:cloud' }] });
    await seedTask(t.db, specFor('l', { execution: 'local' }), 'ready');
    expect(await s.claimNext(runner('l1'), CAPS)).toMatchObject({ taskId: 'l' });
  });

  it('L2 runs two local claims at once and no third', async () => {
    const s = sched('L2');
    for (const id of ['a', 'b', 'c']) await seedTask(t.db, specFor(id));
    expect(await s.claimNext(runner('l1'), CAPS)).not.toBeNull();
    expect(await s.claimNext(runner('l2'), CAPS)).not.toBeNull();
    expect(await s.claimNext(runner('l3'), CAPS)).toBeNull();
  });

  it('L1 runs one local claim; C1 one cloud claim', async () => {
    for (const id of ['a', 'b']) await seedTask(t.db, specFor(id));
    const l1 = sched('L1');
    expect(await l1.claimNext(runner('l1'), CAPS)).not.toBeNull();
    expect(await l1.claimNext(runner('l2'), CAPS)).toBeNull();
    expect(await l1.claimNext(cloud('c1'), CAPS)).toBeNull();
    await resetDb(t.db);
    for (const id of ['a', 'b']) await seedTask(t.db, specFor(id));
    const c1 = sched('C1');
    expect(await c1.claimNext(runner('l1'), CAPS)).toBeNull();
    expect(await c1.claimNext(cloud('c1'), CAPS)).not.toBeNull();
    expect(await c1.claimNext(cloud('c2'), CAPS)).toBeNull();
  });

  it("adding workers doesn't parallelize sequential deps", async () => {
    const s = sched('H2');
    await seedTask(t.db, specFor('first', { role: 'backend' }), 'ready');
    await seedTask(t.db, specFor('second', { role: 'frontend', dependencies: [{ taskId: 'first', revision: 1, condition: 'artifact_verified' }] }), 'planned');
    const a = await s.claimNext(runner('l1'), CAPS);
    expect(a?.taskId).toBe('first');
    // A free cloud slot and a second runner do not start the dependent task while its predecessor is unverified.
    expect(await s.tryClaim(cloud('c1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'second', reason: 'dependencies_unsatisfied' }] });
    expect(await countRows(t.db, 'attempts')).toBe(1);
  });
});
