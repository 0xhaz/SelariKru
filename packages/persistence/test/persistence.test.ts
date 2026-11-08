import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  advanceCursor, appendEvent, claimOutbox, markDelivered, readCursor, readEventsAfter, recordOperation, schema, withTx,
} from '../src/index.ts';
import { envelope, setupTestDb, TENANT, type TestDb } from './helpers.ts';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

async function seedProject(projectId: string, tenantId = TENANT, runId = 'run_a') {
  await t.db.insert(schema.projects).values({ tenantId, projectId, repository: 'r', defaultBranch: 'main', classification: 'internal' });
  await t.db.insert(schema.runs).values({ tenantId, projectId, runId, lifecycle: 'planning' });
}

beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE projects, project_sequences, runs, task_revisions, task_status, dependencies, attempts, resource_claims, budget_reservations, artifacts, check_runs, approvals, decisions, knowledge_nodes, knowledge_edges, events, outbox, consumer_cursors, integration_deliveries, operation_receipts CASCADE`);
  await seedProject('proj_a');
});

const isFkViolation = (e: unknown) => {
  const c = (e as { cause?: { code?: string }; code?: string }) ;
  return (c.cause?.code ?? c.code) === '23503';
};
const count = async (table: string) => Number((await t.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!['n']);

describe('events and outbox', () => {
  it('state and outbox commit atomically', async () => {
    const e = await withTx(t.db, async (tx) => {
      await tx.update(schema.runs).set({ lifecycle: 'running' });
      return appendEvent(tx, envelope({ sequence: 999 }));
    });
    expect(e.sequence).toBe(1); // caller-supplied sequence ignored
    expect(await count('events')).toBe(1);
    expect(await count('outbox')).toBe(1);
    const [run] = await t.db.select().from(schema.runs);
    expect(run!.lifecycle).toBe('running');
  });

  it('rolls back event, outbox row and consumed sequence on failure', async () => {
    await expect(
      withTx(t.db, async (tx) => {
        await tx.update(schema.runs).set({ lifecycle: 'running' });
        await appendEvent(tx, envelope());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count('events')).toBe(0);
    expect(await count('outbox')).toBe(0);
    const [run] = await t.db.select().from(schema.runs);
    expect(run!.lifecycle).toBe('planning');
    const next = await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    expect(next.sequence).toBe(1); // no gap
  });

  it('rejects an invalid envelope and an unknown project', async () => {
    await expect(withTx(t.db, (tx) => appendEvent(tx, envelope({ type: 'nope' })))).rejects.toThrow();
    await expect(withTx(t.db, (tx) => appendEvent(tx, envelope({ projectId: 'ghost' })))).rejects.toThrow(/unknown project/);
    expect(await count('project_sequences')).toBe(0);
  });

  it('sequence has no gaps under concurrent writers', async () => {
    const writers = 8;
    const perWriter = 10;
    await Promise.all(
      Array.from({ length: writers }, () =>
        (async () => {
          for (let i = 0; i < perWriter; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
        })(),
      ),
    );
    const rows = await t.db.execute(sql`SELECT sequence FROM events WHERE project_id = 'proj_a' ORDER BY sequence`);
    const seqs = rows.map((r) => Number(r['sequence']));
    expect(seqs).toEqual(Array.from({ length: writers * perWriter }, (_, i) => i + 1));
  });

  it('sequences are independent per project and survive interleaved rollbacks', async () => {
    await seedProject('proj_b');
    const bEvents = (extra = {}) => envelope({ projectId: 'proj_b', ...extra });
    await Promise.all([
      ...Array.from({ length: 12 }, (_, i) =>
        withTx(t.db, async (tx) => {
          await appendEvent(tx, envelope());
          if (i % 3 === 0) throw new Error('rollback');
        }).catch(() => undefined),
      ),
      ...Array.from({ length: 5 }, () => withTx(t.db, (tx) => appendEvent(tx, bEvents()))),
    ]);
    const a = (await t.db.execute(sql`SELECT sequence FROM events WHERE project_id='proj_a' ORDER BY sequence`)).map((r) => Number(r['sequence']));
    const b = (await t.db.execute(sql`SELECT sequence FROM events WHERE project_id='proj_b' ORDER BY sequence`)).map((r) => Number(r['sequence']));
    expect(a).toEqual(Array.from({ length: 8 }, (_, i) => i + 1));
    expect(b).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('outbox delivery and cursors', () => {
  it('claims in sequence order, hides claimed rows, and redelivers after lease expiry', async () => {
    for (let i = 0; i < 5; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    const first = await claimOutbox(t.db, 'c1', 3);
    expect(first.map((e) => e.sequence)).toEqual([1, 2, 3]);
    const second = await claimOutbox(t.db, 'c2', 10);
    expect(second.map((e) => e.sequence)).toEqual([]); // 4,5 held back behind c1's live claims (per-project order)
    expect(await markDelivered(t.db, 'c1', first.map((e) => e.eventId))).toBe(3);
    expect((await claimOutbox(t.db, 'c2', 10)).map((e) => e.sequence)).toEqual([4, 5]);
    // c2 crashes without marking: lease expiry makes rows claimable again (at-least-once)
    await t.db.execute(sql`UPDATE outbox SET claim_expires_at = now() - interval '1 second' WHERE delivered_at IS NULL`);
    const again = await claimOutbox(t.db, 'c3', 10);
    expect(again.map((e) => e.sequence)).toEqual([4, 5]);
    expect(await markDelivered(t.db, 'c2', again.map((e) => e.eventId))).toBe(0); // not the current holder
  });

  it('consumer resumes from cursor', async () => {
    for (let i = 0; i < 6; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    expect(await readCursor(t.db, 'proj', TENANT, 'proj_a')).toBe(0);
    const batch1 = await readEventsAfter(t.db, TENANT, 'proj_a', 0, 4);
    expect(batch1.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    await advanceCursor(t.db, 'proj', TENANT, 'proj_a', 4);
    await advanceCursor(t.db, 'proj', TENANT, 'proj_a', 2); // never moves backwards
    const cursor = await readCursor(t.db, 'proj', TENANT, 'proj_a');
    expect(cursor).toBe(4);
    const batch2 = await readEventsAfter(t.db, TENANT, 'proj_a', cursor, 10);
    expect(batch2.map((e) => e.sequence)).toEqual([5, 6]);
    expect(batch2[0]!.eventId).not.toBe(batch1[3]!.eventId);
  });
});

describe('operation receipts', () => {
  const key = { tenantId: TENANT, projectId: 'proj_a', key: 'op-1' };

  it('duplicate operation key returns the original receipt', async () => {
    let runs = 0;
    const fn = async () => { runs++; return { id: runs }; };
    const r1 = await withTx(t.db, (tx) => recordOperation(tx, key, fn));
    const r2 = await withTx(t.db, (tx) => recordOperation(tx, key, fn));
    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 1 });
    expect(runs).toBe(1);
  });

  it('runs fn once under concurrent duplicates', async () => {
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTx(t.db, (tx) => recordOperation(tx, { ...key, key: 'op-race' }, async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 50));
          return { winner: runs };
        })),
      ),
    );
    expect(runs).toBe(1);
    for (const r of results) expect(r).toEqual({ winner: 1 });
  });

  it('a failed first attempt leaves no receipt, so a retry runs', async () => {
    await expect(withTx(t.db, (tx) => recordOperation(tx, { ...key, key: 'op-fail' }, async () => { throw new Error('x'); }))).rejects.toThrow('x');
    const r = await withTx(t.db, (tx) => recordOperation(tx, { ...key, key: 'op-fail' }, async () => 'ok'));
    expect(r).toBe('ok');
  });

  it('scopes keys per project', async () => {
    await seedProject('proj_b');
    await withTx(t.db, (tx) => recordOperation(tx, key, async () => 'a'));
    const b = await withTx(t.db, (tx) => recordOperation(tx, { ...key, projectId: 'proj_b' }, async () => 'b'));
    expect(b).toBe('b');
  });
});

describe('cross-project integrity', () => {
  it('composite FK rejects cross-project reference', async () => {
    await seedProject('proj_b', TENANT, 'run_b');
    // task revision in proj_b may not point at proj_a's run
    await expect(
      t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: 'proj_b', runId: 'run_a', taskId: 'task_x', revision: 1, boardId: 'b', spec: {} }),
    ).rejects.toSatisfy(isFkViolation);
    // events may not use another project's run
    await expect(withTx(t.db, (tx) => appendEvent(tx, envelope({ projectId: 'proj_b', runId: 'run_a' })))).rejects.toSatisfy(isFkViolation);
    // dependency edge across projects
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: 'proj_a', runId: 'run_a', taskId: 't1', revision: 1, boardId: 'b', spec: {} });
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: 'proj_b', runId: 'run_b', taskId: 't2', revision: 1, boardId: 'b', spec: {} });
    await expect(
      t.db.insert(schema.dependencies).values({ tenantId: TENANT, projectId: 'proj_b', taskId: 't2', revision: 1, dependsOnTaskId: 't1', dependsOnRevision: 1, condition: 'candidate_verified' }),
    ).rejects.toSatisfy(isFkViolation);
    // same project works
    await t.db.insert(schema.dependencies).values({ tenantId: TENANT, projectId: 'proj_a', taskId: 't1', revision: 1, dependsOnTaskId: 't1', dependsOnRevision: 1, condition: 'candidate_verified' });
  });

  it('rejects a tenant mismatch on the same project id', async () => {
    await expect(
      t.db.insert(schema.runs).values({ tenantId: 'other_tenant', projectId: 'proj_a', runId: 'run_z', lifecycle: 'x' }),
    ).rejects.toSatisfy(isFkViolation);
  });
});
