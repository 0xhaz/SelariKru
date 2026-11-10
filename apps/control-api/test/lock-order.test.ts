/**
 * Owner routes against the scheduler's lock order, with the interleaving forced: a competing transaction takes the locks the claim poll or a stale replan takes, waits until
 * the route is queued behind it, then asks for the lock the route would already hold if it took them in the wrong order. A wrong order is a real Postgres deadlock here.
 */
import { sql } from 'drizzle-orm';
import { withTx, type Tx } from '@selarikru/persistence';
import { lockStaleCandidate, markRunReadyForReview, type TrustedVerifier } from '@selarikru/workflow';
import { lockForVerdict } from '../../../services/verifier/src/service.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, RUN, TENANT, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;
const SHA = 'c'.repeat(40);
const TRUSTED: TrustedVerifier = { checkManifestSha256: 'a'.repeat(64), verifierSha256: 'b'.repeat(64) };

beforeAll(async () => {
  t = await setupTestDb();
  // A record store that has nothing: every assembled candidate reads as stale, which is what sends reverify and replan through the candidate lock.
  h = makeHarness(t, {}, undefined, { evidence: { trusted: () => TRUSTED, artifacts: { read: async () => null } as never, loadRecord: async () => null } });
  await h.app.ready();
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE candidates CASCADE`);
});

const schedulerLock = (tx: Tx) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${TENANT}`}, 0))`);
/** What `lockBudget` takes. */
const runRow = (tx: Tx) => tx.execute(sql`SELECT 1 FROM runs WHERE tenant_id = ${TENANT} AND project_id = ${PROJECT} AND run_id = ${RUN} FOR UPDATE`);
const statusRow = (tx: Tx, taskId: string) => tx.execute(sql`SELECT 1 FROM task_status WHERE tenant_id = ${TENANT} AND project_id = ${PROJECT} AND task_id = ${taskId} FOR UPDATE`);

/** Resolves once some other backend is waiting on a lock this one holds. */
async function queuedBehind(tx: Tx): Promise<void> {
  const [me] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  const pid = Number(me!['pid']);
  for (let i = 0; i < 500; i++) {
    const [row] = await t.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`);
    if (Number(row!['n']) > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the route never queued behind the competing transaction');
}

/**
 * Runs `route` while a transaction holds `first`, then takes `second` once the route is waiting. The competitor gets a long deadlock timeout, so if there is a cycle
 * the route is the one Postgres aborts and the test sees it.
 */
async function race<T>(first: (tx: Tx) => Promise<unknown>, second: (tx: Tx) => Promise<unknown>, route: () => Promise<T>): Promise<T> {
  let started!: () => void;
  const holding = new Promise<void>((r) => { started = r; });
  let pending: Promise<T> | undefined;
  const competitor = withTx(t.db, async (tx) => {
    await tx.execute(sql`SET LOCAL deadlock_timeout = '20s'`);
    await first(tx);
    started();
    await queuedBehind(tx);
    await second(tx);
  });
  await holding;
  pending = route();
  await competitor;
  return pending;
}

const seedStaleCandidate = () => t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, parts, status) VALUES (${TENANT}, ${PROJECT}, 'cand_1', ${RUN}, 'main', ${SHA}, ${'0'.repeat(40)}, '[]'::jsonb, 'assembled')`);
const reverify = () => post(h.app, `/v1/runs/${RUN}/reverify`, { expectedPlanRevision: 0, idempotencyKey: 'rv1' });

describe('reverify lock order', () => {
  it('does not deadlock against the claim poll (scheduler lock, then the run row)', async () => {
    const res = await race(schedulerLock, runRow, reverify);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
  });

  it('does not deadlock against a stale replan (candidate, scheduler lock, then the run row)', async () => {
    await seedStaleCandidate();
    const res = await race((tx) => lockStaleCandidate(tx, { tenantId: TENANT, projectId: PROJECT, runId: RUN }, SHA), runRow, reverify);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
  });
});

describe('replan lock order', () => {
  it('does not deadlock against the claim poll (scheduler lock, a status row, then the run row)', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const res = await race(async (tx) => { await schedulerLock(tx); await statusRow(tx, 't1'); }, runRow, () => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('t1', { revision: 2 })] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // A run that was not in review has nothing to leave.
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'run.reverted'`)).toHaveLength(0);
  });
});

describe('a verdict against a replan of the same run', () => {
  // Adapted from the probe in the T7.4a review. The verdict takes the verifier's real locks (`lockForVerdict`), then what `applyVerification` takes after them (a status
  // write, the claim lock, the event sequence), then the real `markRunReadyForReview`. The replan is the real route, adding a task to the run.
  it('neither side deadlocks: the verdict marks the run ready and the replan goes through after it', async () => {
    await seedTask(t.db, specFor('a'), 'verifying');
    await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, parts, status) VALUES (${TENANT}, ${PROJECT}, 'cand_v', ${RUN}, 'main', ${SHA}, ${'0'.repeat(40)}, '[{"taskId":"a","revision":1}]'::jsonb, 'assembled')`);
    await t.db.execute(sql`INSERT INTO project_sequences (tenant_id, project_id, last_sequence) VALUES (${TENANT}, ${PROJECT}, 0) ON CONFLICT DO NOTHING`);
    let ready: boolean | undefined;
    const res = await race(
      async (tx) => {
        await lockForVerdict(tx, { tenantId: TENANT, projectId: PROJECT, runId: RUN, sha: SHA }, [{ taskId: 'a', revision: 1 }]);
        await tx.execute(sql`UPDATE task_status SET status = 'verified' WHERE tenant_id = ${TENANT} AND project_id = ${PROJECT} AND task_id = 'a'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.claim_rows:${TENANT}:${PROJECT}`}, 0))`);
        await tx.execute(sql`UPDATE project_sequences SET last_sequence = last_sequence + 1 WHERE tenant_id = ${TENANT} AND project_id = ${PROJECT}`);
      },
      async (tx) => { ready = await markRunReadyForReview(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 'a' }, RUN, ['a']); },
      () => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('b')] }),
    );
    expect(ready).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The replan landed on a run in review and gave it unfinished work: it is out of review again.
    expect((await t.db.execute(sql`SELECT lifecycle FROM runs WHERE run_id = ${RUN}`))[0]!['lifecycle']).toBe('running');
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'run.reverted'`)).toHaveLength(1);
  });
});

describe('a deadlock on an owner route', () => {
  it('is a retryable 503 with a typed code, and nothing is recorded', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    // A lease path's order (status row, then run row) against a replan that already holds the run row and wants the status row: a genuine cycle.
    const res = await race((tx) => statusRow(tx, 't1'), runRow, () => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('t1', { revision: 2 })] }));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('transaction_conflict');
    expect(res.body.error.message).not.toMatch(/deadlock|40P01|task_status|runs/);
    expect(await t.db.execute(sql`SELECT 1 FROM task_revisions WHERE task_id = 't1' AND revision = 2`)).toHaveLength(0);
    // The same request again goes through.
    expect((await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('t1', { revision: 2 })] })).status).toBe(201);
  });

  it.each([['40P01', 'deadlock_detected'], ['40001', 'serialization_failure']])('maps a wrapped %s (%s) to the same 503', async (code) => {
    const local = makeHarness(t);
    local.app.post('/v1/test-only/conflict', { onRequest: [] }, async () => { throw Object.assign(new Error('Failed query: SELECT secret'), { cause: Object.assign(new Error('could not serialize'), { code }) }); });
    await local.app.ready();
    const res = await post(local.app, '/v1/test-only/conflict', {});
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({ code: 'transaction_conflict', message: expect.stringMatching(/try again/) });
    await local.app.close();
  });
});
