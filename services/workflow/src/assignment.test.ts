import { evaluate, type Policy } from '@selarikru/policy';
import { schema } from '@selarikru/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPS, POLICY, PROJECT, RUN, TENANT, TEST_CATALOG, capsWith, reservedTotal, countRows, eventTypes, resetDb, runner, seedTask, setupTestDb, specFor, testClock, type TestClock, type TestDb } from '../test/helpers.ts';
import { createScheduler, validateSelection, worstCaseHold, type Lease, type Scheduler } from './index.ts';

const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' };

describe('model assignments', () => {
  let t: TestDb;
  let clock: TestClock;
  let sched: Scheduler;

  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.db);
    clock = testClock();
    sched = createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG });
  });

  const assign = async (scope: 'role' | 'task', key: string, s: { provider: string; model: string } | null, revision = 1): Promise<void> => {
    await t.db.insert(schema.modelAssignments).values({ tenantId: TENANT, projectId: PROJECT, scopeKind: scope, scopeKey: key, revision, provider: s?.provider ?? null, model: s?.model ?? null, updatedBy: 'owner', updatedAt: clock.now() });
  };
  const claim = async (runnerId = 'r1'): Promise<Lease> => {
    const out = await sched.tryClaim(runner(runnerId), CAPS);
    if (!out.ok) throw new Error(`claim refused: ${out.reason} ${JSON.stringify(out.skipped)}`);
    return out.lease;
  };
  const attemptRow = async (attemptId: string) => {
    const [row] = await t.db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, TENANT), eq(schema.attempts.attemptId, attemptId)));
    return row!;
  };
  const startedPayload = async (attemptId: string) => (await t.db.execute(sql`SELECT payload FROM events WHERE type = 'attempt.started' AND attempt_id = ${attemptId}`))[0]!['payload'] as Record<string, unknown>;
  const failAttempt = async (lease: Lease) => {
    await sched.publishResult(lease, { outcome: 'failed', reason: 'tests failed' });
    await t.db.execute(sql`UPDATE task_status SET status = 'ready' WHERE task_id = ${lease.taskId} AND status = 'failed'`);
  };

  it('assignment is recorded on the attempt and shown on the inference badge', async () => {
    await seedTask(t.db, specFor('t1'));
    await assign('role', 'backend', OPUS);
    const lease = await claim();
    expect(lease.assignment).toEqual({ ...OPUS, source: 'role', route: 'cloud' });
    expect(await attemptRow(lease.attemptId)).toMatchObject({ modelProvider: 'anthropic', modelId: 'claude-opus-5-5', modelRoute: 'cloud', assignmentSource: 'role' });
    // `attempt.started` is what the inference badge reads: the reducer test proves the same payload reaches the worker row.
    const payload = await startedPayload(lease.attemptId);
    expect(payload['modelRoute']).toBe('cloud');
    expect(payload['assignment']).toEqual({ ...OPUS, source: 'role' });
    expect(payload).not.toHaveProperty('model');
    expect(JSON.stringify(payload)).not.toMatch(/token|credential|api_?key/i);
  });

  it('a task override beats its role, the role beats the project default, and the default is recorded as such', async () => {
    await seedTask(t.db, specFor('t1'));
    const byDefault = await claim();
    expect(byDefault.assignment).toEqual({ ...SONNET, source: 'default', route: 'cloud' });
    await failAttempt(byDefault);
    await assign('role', 'backend', OPUS);
    const byRole = await claim();
    expect(byRole.assignment).toEqual({ ...OPUS, source: 'role', route: 'cloud' });
    await failAttempt(byRole);
    await assign('task', 't1', SONNET);
    const byTask = await claim();
    expect(byTask.assignment).toEqual({ ...SONNET, source: 'task', route: 'cloud' });
  });

  it('assignment change applies only to the next attempt', async () => {
    await seedTask(t.db, specFor('t1'));
    await assign('role', 'backend', SONNET);
    const first = await claim();
    await assign('role', 'backend', OPUS, 2);
    // The running attempt's record does not move; only the next attempt picks up the change.
    expect((await attemptRow(first.attemptId)).modelId).toBe('claude-sonnet-5-5');
    await failAttempt(first);
    const second = await claim();
    expect(second.assignment?.model).toBe('claude-opus-5-5');
    expect((await attemptRow(first.attemptId)).modelId).toBe('claude-sonnet-5-5');
    expect((await attemptRow(second.attemptId)).modelId).toBe('claude-opus-5-5');
  });

  it('unsupported provider or model fails before launch', async () => {
    await seedTask(t.db, specFor('a', { role: 'codex-role' }));
    await assign('role', 'codex-role', { provider: 'codex', model: 'gpt-x' });
    let out = await sched.tryClaim(runner('r1'), CAPS);
    expect(out.ok).toBe(false);
    expect(out.skipped).toEqual([{ taskId: 'a', reason: 'model_blocked:unsupported_provider:codex/gpt-x' }]);
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);
    expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
    expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBe('unsupported_provider:codex/gpt-x');

    await assign('role', 'codex-role', { provider: 'anthropic', model: 'claude-made-up' }, 2);
    out = await sched.tryClaim(runner('r1'), CAPS);
    expect(out.skipped[0]!.reason).toBe('model_blocked:unsupported_model:anthropic/claude-made-up');

    // An installed model policy does not permit is refused the same way, and policy can change after the choice was made.
    await assign('role', 'codex-role', { provider: 'anthropic', model: 'claude-haiku-5-5' }, 3);
    out = await sched.tryClaim(runner('r1'), CAPS);
    expect(out.skipped[0]!.reason).toBe('model_blocked:model_not_allowed:anthropic/claude-haiku-5-5');
    expect(await countRows(t.db, 'attempts')).toBe(0);

    // Nothing detected means nothing launches, and the screen is told why.
    const none = createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: { status: 'none', detail: 'not installed', providers: [] } });
    await assign('role', 'codex-role', OPUS, 4);
    const refused = await none.tryClaim(runner('r1'), CAPS);
    expect(refused.skipped[0]!.reason).toBe('model_blocked:no_provider_detected:anthropic/claude-opus-5-5');
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);

    // The owner fixes it, and the block clears.
    const fixed = await sched.tryClaim(runner('r1'), CAPS);
    expect(fixed.ok).toBe(true);
    expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBeNull();
  });

  it('no assignment and no default blocks with the role named, and an absent catalog blocks too', async () => {
    await seedTask(t.db, specFor('a'));
    const noDefault: Policy = { ...POLICY, models: { allowed: POLICY.models.allowed } };
    const s1 = createScheduler({ db: t.db, now: clock.now, policy: noDefault, catalog: TEST_CATALOG });
    expect((await s1.tryClaim(runner('r1'), CAPS)).skipped[0]!.reason).toBe('model_blocked:model_not_assigned:backend');
    const noCatalog = createScheduler({ db: t.db, now: clock.now, policy: POLICY });
    expect((await noCatalog.tryClaim(runner('r1'), CAPS)).skipped[0]!.reason).toBe('model_blocked:no_provider_detected:anthropic/claude-sonnet-5-5');
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  describe('benchmark trials', () => {
    const makeTrial = async (pin: typeof SONNET | null): Promise<void> => {
      await t.db.update(schema.runs).set({ trial: true, pinnedModel: pin }).where(eq(schema.runs.runId, RUN));
    };

    it('benchmark trial pins one model', async () => {
      await makeTrial(SONNET);
      await seedTask(t.db, specFor('t1', { role: 'backend' }));
      // Neither the role assignment nor a stored task override can change a trial's model.
      await assign('role', 'backend', OPUS);
      await assign('task', 't1', OPUS);
      const first = await claim();
      expect(first.assignment).toEqual({ ...SONNET, source: 'trial_pin', route: 'cloud' });
      await failAttempt(first);
      await assign('role', 'backend', { provider: 'anthropic', model: 'claude-haiku-5-5' }, 2);
      const second = await claim();
      expect((await attemptRow(second.attemptId)).modelId).toBe('claude-sonnet-5-5');
      expect(second.assignment?.source).toBe('trial_pin');
    });

    it('a trial with no pinned model cannot start', async () => {
      await makeTrial(null);
      await seedTask(t.db, specFor('t1'));
      const out = await sched.tryClaim(runner('r1'), CAPS);
      expect(out.skipped[0]!.reason).toBe('model_blocked:trial_model_not_pinned');
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });
  });

  describe('worst-case budget hold', () => {
    const cap = 1_000_000;

    const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' };
    const priced = { ...TEST_CATALOG, providers: [{ ...TEST_CATALOG.providers[0]!, models: TEST_CATALOG.providers[0]!.models.map((m) => (m.id === HAIKU.model ? { ...m, rate: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5, source: 'test-table' } } : m)) }, TEST_CATALOG.providers[1]!] };

    it('holds the cap on the reference model and more on a dearer one', () => {
      expect(worstCaseHold(cap, SONNET, TEST_CATALOG, POLICY)).toMatchObject({ amountMicros: cap, basis: 'known_rate' });
      expect(worstCaseHold(cap, OPUS, TEST_CATALOG, POLICY)).toMatchObject({ amountMicros: 2 * cap, basis: 'known_rate', rateSource: 'test-table' });
    });

    it('never holds less than the cap for a cheaper known rate', () => {
      expect(worstCaseHold(cap, HAIKU, priced, POLICY)).toEqual({ amountMicros: cap, basis: 'known_rate', rateSource: 'test-table' });
    });

    it('stays conservative with no rate for the model, and says so', () => {
      expect(worstCaseHold(cap, HAIKU, TEST_CATALOG, POLICY)).toEqual({ amountMicros: 2 * cap, basis: 'conservative', rateSource: null });
    });

    it('with no reference it holds the cap and does not call that conservative', () => {
      expect(worstCaseHold(cap, OPUS, TEST_CATALOG, { ...POLICY, models: { allowed: POLICY.models.allowed } })).toEqual({ amountMicros: cap, basis: 'no_reference', rateSource: null });
    });

    it('a cheap model cannot start more work than the budget holds at the cap', async () => {
      await t.db.update(schema.runs).set({ budget: { limitUsd: 2 } }).where(eq(schema.runs.runId, RUN));
      for (let i = 0; i < 10; i += 1) await seedTask(t.db, specFor(`t${i}`, { maxCostUsd: 1 }));
      await assign('role', 'backend', HAIKU);
      const cheap = createScheduler({ db: t.db, now: clock.now, policy: { ...POLICY, models: { ...POLICY.models, allowed: [...POLICY.models.allowed, HAIKU] } }, catalog: priced });
      let started = 0;
      for (let i = 0; i < 10; i += 1) if ((await cheap.tryClaim(runner(`r${i}`), capsWith(20))).ok) started += 1;
      expect(started).toBe(2);
      expect(await reservedTotal(t.db)).toBe(2);
    });

    it('the reservation follows the assigned model, and stays an estimate', async () => {
      await seedTask(t.db, specFor('t1', { maxCostUsd: 2 }));
      await assign('role', 'backend', OPUS);
      const lease = await claim();
      const [row] = await t.db.select().from(schema.budgetReservations).where(eq(schema.budgetReservations.reservationId, lease.reservationId));
      expect(row).toMatchObject({ amountUsd: '4.000000', amountProvenance: 'estimated' });
      expect(row!.detail).toMatchObject({ rateBasis: 'known_rate', rateSource: 'test-table' });
      expect((await startedPayload(lease.attemptId))['amountUsd']).toBe(4);
    });

    it('a dearer model that no longer fits the budget is refused with the budget reason, not silently swapped', async () => {
      await t.db.update(schema.runs).set({ budget: { limitUsd: 1.5 } }).where(eq(schema.runs.runId, RUN));
      await seedTask(t.db, specFor('t1', { maxCostUsd: 1 }));
      await assign('role', 'backend', OPUS);
      const out = await sched.tryClaim(runner('r1'), CAPS);
      expect(out.ok).toBe(false);
      expect(out.skipped[0]!.reason).toBe('budget:exceeds_limit');
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });
  });

  describe('the inference route against the data', () => {
    const DEVICE = { provider: 'test-device', model: 'device-1' };

    it('restricted work on a cloud model is refused from a local runner, typed, with no attempt or reservation', async () => {
      await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
      const out = await sched.tryClaim(runner('r1', 'local'), CAPS);
      expect(out.skipped[0]!.reason).toBe('model_blocked:restricted_requires_device_model:anthropic/claude-sonnet-5-5');
      expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBe('restricted_requires_device_model:anthropic/claude-sonnet-5-5');
      expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
      expect(await countRows(t.db, 'attempts')).toBe(0);
      expect(await countRows(t.db, 'budget_reservations')).toBe(0);
    });

    it('takes the label from stored data, so a task cannot lower it', async () => {
      await t.db.update(schema.projects).set({ classification: 'restricted' });
      await seedTask(t.db, specFor('t1', { classification: 'internal' }));
      expect((await sched.tryClaim(runner('r1', 'local'), CAPS)).skipped[0]!.reason).toMatch(/^model_blocked:restricted_requires_device_model/);
    });

    describe('a contract reference that cannot be labelled counts as secret for the route', () => {
      const SHA = 'a'.repeat(64);
      const refused = async () => {
        const out = await sched.tryClaim(runner('r1', 'local'), CAPS);
        expect(out.ok).toBe(false);
        expect(out.skipped[0]!.reason).toBe('model_blocked:restricted_requires_device_model:anthropic/claude-sonnet-5-5');
        expect(await countRows(t.db, 'attempts')).toBe(0);
        expect(await countRows(t.db, 'budget_reservations')).toBe(0);
      };

      it('an artifact that does not exist', async () => {
        await seedTask(t.db, specFor('t1', { classification: 'internal', contractRefs: [{ artifactId: 'ghost', sha256: SHA }] }));
        await refused();
      });

      it('an artifact whose stored digest does not match, even one labelled public', async () => {
        await t.db.insert(schema.artifacts).values({ tenantId: TENANT, projectId: PROJECT, artifactId: 'a1', type: 'contract', sha256: 'b'.repeat(64), classification: 'public' });
        await seedTask(t.db, specFor('t1', { classification: 'internal', contractRefs: [{ artifactId: 'a1', sha256: SHA }] }));
        await refused();
      });

      it('a labelled reference still claims on a cloud model', async () => {
        await t.db.insert(schema.artifacts).values({ tenantId: TENANT, projectId: PROJECT, artifactId: 'a2', type: 'contract', sha256: SHA, classification: 'internal' });
        await seedTask(t.db, specFor('t1', { classification: 'internal', contractRefs: [{ artifactId: 'a2', sha256: SHA }] }));
        expect((await sched.tryClaim(runner('r1', 'local'), CAPS)).ok).toBe(true);
      });
    });

    it('restricted work on a device model can run', async () => {
      await seedTask(t.db, specFor('t1', { classification: 'restricted', execution: 'local' }));
      await assign('role', 'backend', DEVICE);
      const out = await sched.tryClaim(runner('d1'), CAPS);
      expect(out.ok && out.lease.assignment).toEqual({ ...DEVICE, source: 'role', route: 'device' });
    });

    it('a model whose route is unknown is refused for any data', async () => {
      const unknownRoute = { ...TEST_CATALOG, providers: [{ ...TEST_CATALOG.providers[0]!, models: TEST_CATALOG.providers[0]!.models.map((m) => ({ ...m, route: 'unknown' as const })) }] };
      await seedTask(t.db, specFor('t1', { classification: 'public' }));
      const s = createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: unknownRoute });
      expect((await s.tryClaim(runner('r1'), CAPS)).skipped[0]!.reason).toBe('model_blocked:model_route_unknown:anthropic/claude-sonnet-5-5');
      expect(await countRows(t.db, 'attempts')).toBe(0);
    });
  });

  it('a runner without the model is refused before launch, typed, and one that has it can still claim', async () => {
    await seedTask(t.db, specFor('t1'));
    const without = { ...runner('r1'), harnesses: [{ provider: 'anthropic', harnessVersion: '2.1.316', models: ['claude-opus-5-5'] }] };
    expect((await sched.tryClaim(without, CAPS)).skipped[0]!.reason).toBe('model_blocked:model_not_on_runner:anthropic/claude-sonnet-5-5');
    expect((await sched.tryClaim({ ...runner('r2'), harnesses: undefined }, CAPS)).skipped[0]!.reason).toBe('model_blocked:model_not_on_runner:anthropic/claude-sonnet-5-5');
    expect(await countRows(t.db, 'attempts')).toBe(0);
    const able = await sched.tryClaim(runner('r3'), CAPS);
    expect(able.ok).toBe(true);
    expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBeNull();
  });

  describe('polling runners do not grow the log', () => {
    const enrol = async (runnerId: string, models: string[], location: 'local' | 'cloud' = 'local') => {
      const harnesses = [{ provider: 'anthropic', harnessVersion: '2.1.316', models }];
      await t.db.insert(schema.runners).values({ tenantId: TENANT, runnerId, location, tokenHash: `hash-${runnerId}`, harnessReport: harnesses });
      return { ...runner(runnerId, location), harnesses };
    };
    const rowRevision = async () => (await t.db.select().from(schema.taskStatus))[0]!.rowRevision;
    beforeEach(async () => { await t.db.delete(schema.runners); });

    it('mixed runners: one lacks the model, another has it but cannot take the task, and nothing is written', async () => {
      await seedTask(t.db, specFor('t1', { execution: 'local' }));
      const lacks = await enrol('a', ['claude-opus-5-5']);
      const has = await enrol('b', ['claude-sonnet-5-5'], 'cloud');
      const before = await rowRevision();
      for (let i = 0; i < 4; i += 1) {
        expect((await sched.tryClaim(lacks, CAPS)).skipped[0]!.reason).toBe('model_blocked:model_not_on_runner:anthropic/claude-sonnet-5-5');
        expect((await sched.tryClaim(has, CAPS)).ok).toBe(false);
      }
      expect(await rowRevision()).toBe(before);
      expect(await eventTypes(t.db)).toEqual([]);
      expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBeNull();
    });

    it('when no runner has the model it is recorded once, however many poll', async () => {
      await seedTask(t.db, specFor('t1'));
      const a = await enrol('a', ['claude-opus-5-5']);
      const b = await enrol('b', ['claude-haiku-5-5']);
      for (let i = 0; i < 4; i += 1) { await sched.tryClaim(a, CAPS); await sched.tryClaim(b, CAPS); }
      expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
      expect(await rowRevision()).toBe(1);
      expect((await t.db.select().from(schema.taskStatus))[0]!.placementBlock).toBe('model_not_on_runner:anthropic/claude-sonnet-5-5');
    });

    it('a revoked runner does not count as having the model', async () => {
      await seedTask(t.db, specFor('t1'));
      const lacks = await enrol('a', ['claude-opus-5-5']);
      await enrol('gone', ['claude-sonnet-5-5']);
      await t.db.update(schema.runners).set({ revokedAt: clock.now() }).where(eq(schema.runners.runnerId, 'gone'));
      await sched.tryClaim(lacks, CAPS);
      expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
    });
  });

  it('validateSelection is the single check, and policy has the last word', () => {
    expect(validateSelection(SONNET, TEST_CATALOG, POLICY)).toMatchObject({ ok: true });
    expect(validateSelection({ provider: 'anthropic', model: 'claude-opus-5-5' }, TEST_CATALOG, { ...POLICY, models: { allowed: [SONNET] } })).toMatchObject({ ok: false, reason: 'model_not_allowed' });
    expect(validateSelection(SONNET, { ...TEST_CATALOG, providers: [{ ...TEST_CATALOG.providers[0]!, modelSelection: 'not established' }] }, POLICY)).toMatchObject({ ok: false, reason: 'unsupported_provider' });
    expect(evaluate({ kind: 'assign_model', selection: SONNET }, { policyVersion: 'x' }).reason).toBe('missing_models_config');
    expect(evaluate({ kind: 'assign_model', selection: null }, { policyVersion: 'x' }).decision).toBe('allow');
    expect(evaluate({ kind: 'assign_model', selection: SONNET }, undefined).reason).toBe('missing_policy');
    expect(evaluate({ kind: 'assign_model', selection: SONNET }, { policyVersion: 'x', operations: { assign_model: 'deny' }, models: { allowed: [SONNET] } }).reason).toBe('configured_deny:assign_model');
  });
});
