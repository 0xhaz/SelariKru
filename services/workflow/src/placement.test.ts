import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Policy } from '@selarikru/policy';
import { createScheduler } from './index.ts';
import { capacityForMode, place, PLACEMENT_MODES, type Capacity, type PlaceContext } from './placement.ts';
import { schema } from '@selarikru/persistence';
import {
  CAPS, PROJECT, RUN, TENANT, countRows, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, CLOUD_POLICY, type TestClock, type TestDb,
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

/** A mode that declares expansion: one slot each and no role mapping. */
const OPEN = { id: 'open', localSlots: 1, cloudSlots: 1 } as const;
const capOpen = (running = { local: 0, cloud: 0 }, total: number | null | undefined = 2): Capacity => capacityForMode(OPEN, { maxConcurrentTotal: total, running });

describe('place (pure)', () => {
  it('ready task goes local when a slot is free', () => {
    expect(place(task(), cap('L2'), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
    expect(place(task(), capOpen(), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
  });

  it('auto expands to cloud within limits and records reason', () => {
    const r = place(task(), capOpen({ local: 1, cloud: 0 }), policy, ctx);
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
    expect(place(task({ classification: 'restricted' }), capOpen(), policy, ctx)).toMatchObject({ target: 'local', reason: 'local_slot_free' });
    // Only waiting for the local slot is a transient wait, never a permanent classification block; cloud is not used.
    expect(place(task({ classification: 'restricted' }), capOpen({ local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot', transient: true });
    expect(place(task({ classification: 'restricted' }), cap('C1'), policy, ctx)).toMatchObject({ blocked: true, reason: 'classification_not_cloud_eligible', transient: false });
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
    expect(place(t, capOpen(), { ...policy, destinations: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
    expect(place(t, capOpen(), policy, { ...ctx, destination: null })).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
    expect(place(t, capOpen(), { ...policy, selectedSources: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:source_not_selected' });
    // eligible_any whose local slot is full is blocked rather than moved when the cloud grant is missing.
    expect(place(task(), capOpen({ local: 1, cloud: 0 }), { ...policy, destinations: [] }, ctx)).toMatchObject({ blocked: true, reason: 'policy_denied:missing_destination:execution' });
  });

  it('configured require_approval is Blocked, not silently started', () => {
    const p: Policy = { ...policy, operations: { start_cloud_worker: 'require_approval' } };
    expect(place(task({ execution: 'cloud' }), cap('C1'), p, ctx)).toMatchObject({ blocked: true, reason: 'approval_required:configured_require_approval:start_cloud_worker' });
  });

  it('execution local/cloud is honoured', () => {
    expect(place(task({ execution: 'local' }), capOpen(), policy, ctx)).toMatchObject({ target: 'local', reason: 'execution_local' });
    expect(place(task({ execution: 'cloud' }), capOpen(), policy, ctx)).toMatchObject({ target: 'cloud', reason: 'execution_cloud' });
    expect(place(task({ execution: 'local' }), capOpen({ local: 1, cloud: 0 }), policy, ctx)).toMatchObject({ blocked: true, reason: 'no_free_slot', transient: true });
  });

  it('a location with zero slots in the mode is disabled with a concrete reason', () => {
    expect(place(task({ execution: 'cloud' }), cap('L1'), policy, ctx)).toMatchObject({ blocked: true, reason: 'location_disabled:cloud' });
    expect(place(task({ execution: 'local' }), cap('C1'), policy, ctx)).toMatchObject({ blocked: true, reason: 'location_disabled:local' });
  });

  it('a missing limit on any candidate location blocks instead of expanding', () => {
    const c: Capacity = { maxConcurrentTotal: 2, local: { limit: null, running: 0 }, cloud: { limit: 1, running: 0 } };
    expect(place(task(), c, policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:local' });
    const c2: Capacity = { maxConcurrentTotal: 2, local: { limit: 1, running: 0 }, cloud: {  running: 0 } };
    expect(place(task(), c2, policy, ctx)).toMatchObject({ blocked: true, reason: 'missing_limit:cloud' });
  });

  describe('manifest modes', () => {
    it('H2 fails closed on roles it does not map, even when local is full', () => {
      for (const role of ['Backend', 'database', 'planner', 'worker', 'FRONTEND', '']) {
        const r = place(task({ role: role || 'x' }), cap('H2', { local: 1, cloud: 0 }), policy, ctx);
        expect(r, role).toMatchObject({ blocked: true, reason: `role_not_mapped:${role || 'x'}` });
        expect(place(task({ role: role || 'x' }), cap('H2'), policy, ctx), role).toMatchObject({ blocked: true, reason: `role_not_mapped:${role || 'x'}` });
      }
    });

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
    expect(await s.tryClaim(runner('l1'), CAPS)).toMatchObject({ skipped: [{ reason: 'placement_blocked:location_disabled:cloud' }] });
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

  describe('source labels come from stored rows, not the task', () => {
    const SHA = 'a'.repeat(64);
    const policyWith = (sources: string[], extra: Partial<Policy> = {}): Policy => ({ ...(CLOUD_POLICY as Policy), selectedSources: [`repo:${PROJECT}`, ...sources], ...extra });
    const addArtifact = (artifactId: string, classification: string, sha256 = SHA) =>
      t.db.insert(schema.artifacts).values({ tenantId: TENANT, projectId: PROJECT, artifactId, type: 'contract', sha256, classification });
    const cloudTask = (id = 'x', over: Parameters<typeof specFor>[1] = {}) => specFor(id, { execution: 'cloud', ...over });
    const claimCloud = (p: Policy) => sched('C1', p).tryClaim(cloud('c1'), CAPS);

    it('an internal task referencing a restricted artifact never gets a cloud lease', async () => {
      await addArtifact('a1', 'restricted');
      await seedTask(t.db, cloudTask('x', { contractRefs: [{ artifactId: 'a1', sha256: SHA }] }));
      expect(await claimCloud(policyWith(['artifact:a1']))).toMatchObject({ ok: false, skipped: [{ taskId: 'x', reason: 'placement_blocked:classification_not_cloud_eligible' }] });
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });

    it('an internal task in a restricted project never gets a cloud lease', async () => {
      await t.db.update(schema.projects).set({ classification: 'restricted' });
      await seedTask(t.db, cloudTask());
      expect(await claimCloud(policyWith([]))).toMatchObject({ ok: false, skipped: [{ reason: 'placement_blocked:classification_not_cloud_eligible' }] });
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });

    it('a missing artifact row or a sha mismatch is unclassified and denied by policy', async () => {
      await seedTask(t.db, cloudTask('x', { contractRefs: [{ artifactId: 'ghost', sha256: SHA }] }));
      expect(await claimCloud(policyWith(['artifact:ghost']))).toMatchObject({ skipped: [{ reason: 'placement_blocked:policy_denied:unclassified_source' }] });
      await addArtifact('a2', 'public', 'b'.repeat(64));
      await seedTask(t.db, cloudTask('y', { contractRefs: [{ artifactId: 'a2', sha256: SHA }] }));
      expect(await claimCloud(policyWith(['artifact:ghost', 'artifact:a2']))).toMatchObject({ skipped: expect.arrayContaining([{ taskId: 'y', reason: 'placement_blocked:policy_denied:unclassified_source' }]) });
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });

    it('a task fed by a restricted predecessor (its label or its artifacts) is not placed in cloud', async () => {
      await addArtifact('a3', 'restricted');
      await seedTask(t.db, specFor('p1', { classification: 'restricted' }), 'verified');
      await seedTask(t.db, specFor('p2', { contractRefs: [{ artifactId: 'a3', sha256: SHA }] }), 'verified');
      const dep = (taskId: string) => ({ taskId, revision: 1, condition: 'artifact_verified' as const });
      await seedTask(t.db, cloudTask('s1', { dependencies: [dep('p1')] }), 'planned');
      await seedTask(t.db, cloudTask('s2', { dependencies: [dep('p2')] }), 'planned');
      const r = await claimCloud(policyWith(['artifact:a3']));
      expect(r).toMatchObject({ ok: false, skipped: expect.arrayContaining([
        { taskId: 's1', reason: 'placement_blocked:classification_not_cloud_eligible' },
        { taskId: 's2', reason: 'placement_blocked:classification_not_cloud_eligible' },
      ]) });
    });

    it('a restricted label propagates through a multi-hop chain, a diamond and a cycle', async () => {
      const dep = (taskId: string) => ({ taskId, revision: 1, condition: 'artifact_verified' as const });
      // A (restricted) -> B (internal) -> C (cloud, internal)
      await seedTask(t.db, specFor('A', { classification: 'restricted' }), 'verified');
      await seedTask(t.db, specFor('B', { dependencies: [dep('A')] }), 'verified');
      await seedTask(t.db, cloudTask('C', { dependencies: [dep('B')] }), 'planned');
      // diamond: R (restricted) -> L, M (internal) -> D (cloud)
      await seedTask(t.db, specFor('R', { classification: 'restricted' }), 'verified');
      await seedTask(t.db, specFor('L', { dependencies: [dep('R')] }), 'verified');
      await seedTask(t.db, specFor('M', { dependencies: [dep('R')] }), 'verified');
      await seedTask(t.db, cloudTask('D', { dependencies: [dep('L'), dep('M')] }), 'planned');
      // a dependency cycle among verified tasks terminates, and a clean chain still places
      await seedTask(t.db, specFor('X'), 'verified');
      await seedTask(t.db, specFor('Y', { dependencies: [dep('X')] }), 'verified');
      await t.db.insert(schema.dependencies).values({ tenantId: TENANT, projectId: PROJECT, taskId: 'X', revision: 1, dependsOnTaskId: 'Y', dependsOnRevision: 1, condition: 'artifact_verified' });
      await seedTask(t.db, cloudTask('Z', { dependencies: [dep('X')] }), 'planned');
      const r = await claimCloud(policyWith([]));
      expect(r).toMatchObject({ ok: true, lease: { taskId: 'Z', location: 'cloud' }, skipped: expect.arrayContaining([
        { taskId: 'C', reason: 'placement_blocked:classification_not_cloud_eligible' },
        { taskId: 'D', reason: 'placement_blocked:classification_not_cloud_eligible' },
      ]) });
    });

    it('control: public artifact and internal project and task still place in cloud', async () => {
      await addArtifact('a4', 'public');
      await seedTask(t.db, cloudTask('x', { contractRefs: [{ artifactId: 'a4', sha256: SHA }] }));
      expect(await claimCloud(policyWith(['artifact:a4']))).toMatchObject({ ok: true, lease: { location: 'cloud' } });
    });
  });

  describe('run-level placement', () => {
    const setRun = (runId: string, placement: { mode: string; cloudDestination: string | null } | null) =>
      t.db.update(schema.runs).set({ placement }).where(sql`run_id = ${runId}`);
    const plain = () => createScheduler({ db: t.db, now: clock.now, policy: CLOUD_POLICY as Policy });

    it('the run row carries the mode: H2 sends backend local and frontend cloud with no scheduler-level config', async () => {
      await setRun(RUN, { mode: 'H2', cloudDestination: 'cloud-sandbox-eu' });
      await seedTask(t.db, specFor('be', { role: 'backend' }));
      await seedTask(t.db, specFor('fe', { role: 'frontend' }));
      const s = plain();
      expect(await s.claimNext(cloud('c1'), CAPS)).toMatchObject({ taskId: 'fe', location: 'cloud' });
      expect(await s.claimNext(runner('l1'), CAPS)).toMatchObject({ taskId: 'be', location: 'local' });
    });

    it('a run without a valid mode gets local-only defaults; an unknown mode name blocks', async () => {
      await seedTask(t.db, specFor('c', { execution: 'cloud' }));
      expect(await plain().tryClaim(cloud('c1'), CAPS)).toMatchObject({ skipped: [{ reason: 'placement_blocked:location_disabled:cloud' }] });
      await setRun(RUN, { mode: 'ZZ', cloudDestination: null });
      expect(await plain().tryClaim(runner('l1'), CAPS)).toMatchObject({ ok: false, skipped: [{ reason: 'placement_blocked:unknown_placement_mode' }] });
    });

    it('slots are counted per run while the total of 2 stays global', async () => {
      await t.db.insert(schema.runs).values({ tenantId: TENANT, projectId: PROJECT, runId: 'run_b', lifecycle: 'running', budget: { limitUsd: 1000 } });
      await setRun(RUN, { mode: 'L1', cloudDestination: null });
      await setRun('run_b', { mode: 'L1', cloudDestination: null });
      for (const id of ['a1', 'a2']) await seedTask(t.db, specFor(id));
      for (const id of ['b1', 'b2']) await seedTask(t.db, specFor(id, { runId: 'run_b' }));
      const s = plain();
      const l1 = await s.claimNext(runner('l1'), CAPS);
      const l2 = await s.claimNext(runner('l2'), CAPS);
      expect([l1?.runId, l2?.runId].sort()).toEqual([RUN, 'run_b']); // one slot per run
      expect(await s.claimNext(runner('l3'), CAPS)).toBeNull(); // the global total of 2 holds
    });
  });

  describe('permanent blocks are visible, transient ones are silent', () => {
    const blockedEvents = () => t.db.execute(sql`SELECT payload, actor_kind FROM events WHERE type = 'placement.blocked' ORDER BY sequence`);
    const blockCol = async (id: string) => String((await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = ${id}`))[0]!['placement_block']);

    it('writes one placement.blocked event per reason change and exposes the reason on task_status', async () => {
      await seedTask(t.db, specFor('r1', { role: 'frontend', classification: 'restricted' }));
      const s = sched('H2');
      for (let i = 0; i < 3; i++) await s.tryClaim(cloud('c1'), CAPS);
      await s.tryClaim(runner('l1'), CAPS);
      const ev = await blockedEvents();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor_kind: 'scheduler', payload: { reason: 'classification_not_cloud_eligible', mode: 'H2' } });
      expect(await blockCol('r1')).toBe('classification_not_cloud_eligible');
      expect((await statusOf(t.db, 'r1')).status).toBe('ready');
    });

    it('a changed reason writes a new event; a successful placement clears the field', async () => {
      await seedTask(t.db, specFor('x', { execution: 'cloud' }));
      await sched('C1', { ...(CLOUD_POLICY as Policy), destinations: [] }).tryClaim(cloud('c1'), CAPS);
      await sched('C1', { ...(CLOUD_POLICY as Policy), operations: { start_cloud_worker: 'require_approval' } }).tryClaim(cloud('c1'), CAPS);
      const ev = await blockedEvents();
      expect(ev.map((e) => (e['payload'] as { reason: string }).reason)).toEqual([
        'policy_denied:missing_destination:execution', 'approval_required:configured_require_approval:start_cloud_worker',
      ]);
      expect(await countRows(t.db, 'approvals')).toBe(0);
      expect((await statusOf(t.db, 'x')).status).toBe('ready');
      expect(await sched('C1').claimNext(cloud('c1'), CAPS)).not.toBeNull();
      expect((await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 'x'`))[0]!['placement_block']).toBeNull();
    });

    it('a restricted task only waiting for the local slot is a transient wait: no event, no field', async () => {
      for (const id of ['r1', 'r2']) await seedTask(t.db, specFor(id, { classification: 'restricted' }));
      const s = sched('L1');
      expect(await s.claimNext(runner('l1'), CAPS)).toMatchObject({ taskId: 'r1' });
      expect(await s.tryClaim(runner('l2'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'r2', reason: 'placement_blocked:no_free_slot' }] });
      expect(await blockedEvents()).toHaveLength(0);
      expect((await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 'r2'`))[0]!['placement_block']).toBeNull();
    });

    it('a transient wait does not clear the field, so a repeated permanent reason writes one event', async () => {
      const SHA = 'a'.repeat(64);
      const s = sched('H2', { ...(CLOUD_POLICY as Policy), selectedSources: [`repo:${PROJECT}`, 'artifact:ghost'] });
      await seedTask(t.db, specFor('f1', { role: 'frontend', contractRefs: [{ artifactId: 'ghost', sha256: SHA }] }));
      await s.tryClaim(cloud('c1'), CAPS); // permanently denied: unlabelled source
      await seedTask(t.db, specFor('f2', { role: 'frontend' }));
      const lease = (await s.claimNext(cloud('c1'), CAPS))!; // f2 takes the one cloud slot
      expect(lease.taskId).toBe('f2');
      expect(await s.tryClaim(cloud('c2'), CAPS)).toMatchObject({ skipped: [{ taskId: 'f1', reason: 'placement_blocked:no_free_slot' }] }); // transient
      await s.publishResult(lease, { outcome: 'completed' });
      await s.tryClaim(cloud('c2'), CAPS); // denied again, same reason
      const ev = await blockedEvents();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ payload: { reason: 'policy_denied:unclassified_source' } });
    });

    it('transient blocks write no event', async () => {
      for (const id of ['a', 'b']) await seedTask(t.db, specFor(id));
      const s = sched('L1');
      await s.claimNext(runner('l1'), CAPS);
      expect(await s.tryClaim(runner('l2'), CAPS)).toMatchObject({ ok: false });
      expect(await blockedEvents()).toHaveLength(0);
    });

    it('repair_within_limits configured require_approval is visible with its reason', async () => {
      const s = createScheduler({ db: t.db, now: clock.now, policy: { ...(CLOUD_POLICY as Policy), operations: { repair_within_limits: 'require_approval' } } });
      await seedTask(t.db, specFor('rp'));
      const lease = (await s.claimNext(runner('l1'), CAPS))!;
      await s.publishResult(lease, { outcome: 'failed', reason: 'boom' });
      await s.tryClaim(runner('l1'), CAPS);
      expect((await statusOf(t.db, 'rp')).status).toBe('blocked');
      const rows = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked'`);
      expect(rows[0]!['payload']).toMatchObject({ reason: 'configured_require_approval:repair_within_limits' });
    });
  });
});
