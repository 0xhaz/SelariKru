import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '@selarikru/persistence';
import { PROJECT, RUN, bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { bumpStatus } from '../src/store.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DROP TRIGGER IF EXISTS fail_stop ON task_commands`);
  await t.db.execute(sql`DELETE FROM runners`);
  h = makeHarness(t);
});

const save = (key: string, change: Record<string, unknown>, expectedRevision = 0) => post(h.app, `/v1/projects/${PROJECT}/settings`, { key, change, expectedRevision, idempotencyKey: `k-${Math.random()}` });
const paused = async () => (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.settings.find((x: any) => x.field === 'paused');
const claim = (token: string, config?: { revision: number; slots: number }) => post(h.app, '/v1/runners/claim', config ? { config } : {}, bearer(token));

describe('N1: a runner counts as recent only once it has polled', () => {
  it('a newly enrolled runner that has not polled yet does not hold a change back', async () => {
    const a = await enrolRunner(h.app);
    await claim(a.token, { revision: 0, slots: 2 });
    const saved = await save(RUN, { scope: 'run', field: 'paused', value: true });
    const c = await enrolRunner(h.app);
    await claim(a.token, { revision: saved.body.configRevision, slots: 2 });
    expect(await paused()).toMatchObject({ state: 'applied' });
    expect((await paused()).waitingOn).toBeUndefined();
    void c;
  });

  it('a runner on an old build that polls but never acknowledges still reads as waiting for a runner update', async () => {
    const a = await enrolRunner(h.app);
    await claim(a.token, { revision: 0, slots: 2 });
    const old = await enrolRunner(h.app);
    await claim(old.token);
    const saved = await save(RUN, { scope: 'run', field: 'paused', value: true });
    await claim(a.token, { revision: saved.body.configRevision, slots: 2 });
    expect(await paused()).toMatchObject({ state: 'waiting_for_runner_update', waitingOn: [old.runnerId] });
  });
});

describe('N2: one task that cannot be cancelled does not stop the run cancel', () => {
  it('a task whose spec no longer reads is skipped with the server\'s reason, and the rest of the run is cancelled', async () => {
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    await t.db.execute(sql`UPDATE task_revisions SET spec = '{}'::jsonb WHERE task_id = 't1'`);
    const res = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'applied', cancelled: ['t2'], skipped: [{ taskId: 't1', reason: 'spec_unreadable' }] });
    expect((await t.db.execute(sql`SELECT lifecycle FROM runs`))[0]!['lifecycle']).toBe('cancelled');
    const [ev] = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'run.cancel_requested'`);
    expect(ev!['payload']).toMatchObject({ skipped: [{ taskId: 't1', reason: 'spec_unreadable' }] });
  });

  it('a status write at a revision that moved is a 409, not a 500', async () => {
    await seedTask(t.db, specFor('t1'));
    await expect(withTx(t.db, (tx) => bumpStatus(tx, { tenantId: 'tenant_a', projectId: PROJECT, taskId: 't1' }, 41, 'cancelled', h.clock.now()))).rejects.toMatchObject({ status: 409, code: 'stale_revision' });
  });
});

describe('N3: a committed budget save always answers', () => {
  it('a failing budget stop is logged and the save still answers 200', async () => {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { maxCostUsd: 5 }));
    await claim(a.token);
    await t.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION fail_now() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`));
    await t.db.execute(sql.raw(`CREATE TRIGGER fail_stop BEFORE INSERT ON task_commands FOR EACH ROW EXECUTE FUNCTION fail_now()`));
    const res = await save(RUN, { scope: 'run', field: 'budget_limit_usd', value: 1 });
    expect(res.status).toBe(200);
    expect((await t.db.execute(sql`SELECT budget FROM runs`))[0]!['budget']).toMatchObject({ limitUsd: 1 });
  });
});
