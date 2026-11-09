import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceCursor, appendEvent, claimOutbox, createDb, markDelivered, migrate, MIGRATIONS_DIR, readCursor, readEventsAfter, recordOperation, schema, withTx,
} from '../src/index.ts';
import postgres from 'postgres';
import { envelope, setupTestDb, TEST_DATABASE_URL, TENANT, type TestDb } from './helpers.ts';

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

describe('outbox ordering under concurrent and restarted claimers', () => {
  it('a claim held open by another connection blocks later rows for that project', async () => {
    for (let i = 0; i < 5; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let claimedSignal!: () => void;
    const claimed = new Promise<void>((r) => (claimedSignal = r));
    let c1: number[] = [];
    const tx1 = withTx(t.db, async (tx) => {
      c1 = (await claimOutbox(tx, 'c1', 3)).map((e) => e.sequence);
      claimedSignal();
      await held;
    });
    await claimed;
    const c2 = (await claimOutbox(t.db, 'c2', 10)).map((e) => e.sequence);
    release();
    await tx1;
    expect(c1).toEqual([1, 2, 3]);
    expect(c2).toEqual([]);
  });

  it('a restarted consumer with the same name cannot claim past its own live lease', async () => {
    for (let i = 0; i < 5; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    const first = await claimOutbox(t.db, 'worker', 3); // crashes before delivering
    expect(first.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(await claimOutbox(t.db, 'worker', 10)).toEqual([]);
    await t.db.execute(sql`UPDATE outbox SET claim_expires_at = now() - interval '1 second' WHERE delivered_at IS NULL`);
    expect((await claimOutbox(t.db, 'worker', 10)).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('outbox claim vs in-flight ack', () => {
  it('a claim waits for an uncommitted ack and never claims a later row first', async () => {
    for (let i = 0; i < 3; i++) await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    const first = await claimOutbox(t.db, 'c1', 3);
    await t.db.execute(sql`UPDATE outbox SET claim_expires_at = now() - interval '1 second' WHERE delivered_at IS NULL`);
    let ackedSignal!: () => void;
    const acked = new Promise<void>((r) => (ackedSignal = r));
    let finish!: (rollback: boolean) => void;
    const decision = new Promise<boolean>((r) => (finish = r));
    const ackTx = withTx(t.db, async (tx) => {
      expect(await markDelivered(tx, 'c1', [first[0]!.eventId])).toBe(1);
      ackedSignal();
      if (await decision) throw new Error('rollback ack');
    }).catch(() => undefined);
    await acked;
    let resolved = false;
    const claim = claimOutbox(t.db, 'c2', 10).then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    const blockedWhileAckInFlight = !resolved;
    finish(true); // always release the ack, so a failing run cannot hang
    await ackTx;
    const got = (await claim).map((e) => e.sequence);
    expect({ blockedWhileAckInFlight, got }).toEqual({ blockedWhileAckInFlight: true, got: [1, 2, 3] });
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

  it('a caught fn failure inside the tx leaves no receipt', async () => {
    let runs = 0;
    await withTx(t.db, async (tx) => {
      await recordOperation(tx, { ...key, key: 'op-caught' }, async () => { runs++; throw new Error('inner'); }).catch(() => undefined);
    });
    expect(await count('operation_receipts')).toBe(0);
    const r = await withTx(t.db, (tx) => recordOperation(tx, { ...key, key: 'op-caught' }, async () => { runs++; return 'second'; }));
    expect(r).toBe('second');
    expect(runs).toBe(2);
  });

  it('a non-serialisable receipt leaves no receipt when caught', async () => {
    await withTx(t.db, async (tx) => {
      await recordOperation(tx, { ...key, key: 'op-big' }, async () => 10n).catch(() => undefined);
    });
    expect(await count('operation_receipts')).toBe(0);
  });

  it('scopes keys per project', async () => {
    await seedProject('proj_b');
    await withTx(t.db, (tx) => recordOperation(tx, key, async () => 'a'));
    const b = await withTx(t.db, (tx) => recordOperation(tx, { ...key, projectId: 'proj_b' }, async () => 'b'));
    expect(b).toBe('b');
  });
});

describe('appendEvent transaction typing', () => {
  it('rejects a plain db handle at compile time', async () => {
    await withTx(t.db, async (tx) => {
      // @ts-expect-error appendEvent requires a transaction
      const f: () => Promise<unknown> = () => appendEvent(t.db, envelope());
      expect(typeof f).toBe('function');
      await appendEvent(tx, envelope());
    });
  });

  it('a duplicate eventId fails the tx and consumes no sequence', async () => {
    const e = envelope();
    await withTx(t.db, (tx) => appendEvent(tx, e));
    await expect(withTx(t.db, (tx) => appendEvent(tx, { ...e }))).rejects.toThrow();
    const next = await withTx(t.db, (tx) => appendEvent(tx, envelope()));
    expect(next.sequence).toBe(2);
  });
});

describe('cross-project integrity (task, approval, budget, attempt refs)', () => {
  beforeEach(async () => {
    await seedProject('proj_b', TENANT, 'run_b');
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: 'proj_a', runId: 'run_a', taskId: 't1', revision: 1, boardId: 'b', spec: {} });
    await t.db.insert(schema.attempts).values({ tenantId: TENANT, projectId: 'proj_a', attemptId: 'att1', taskId: 't1', revision: 1, attemptNumber: 1 });
  });

  it('budget_reservations rejects a task from another project, accepts own', async () => {
    const row = (projectId: string, runId: string) => ({ tenantId: TENANT, projectId, reservationId: `r_${projectId}`, runId, taskId: 't1', revision: 1, state: 'held' });
    await expect(t.db.insert(schema.budgetReservations).values(row('proj_b', 'run_b'))).rejects.toSatisfy(isFkViolation);
    await t.db.insert(schema.budgetReservations).values(row('proj_a', 'run_a'));
  });

  it('approvals rejects a task from another project, accepts own', async () => {
    const row = (projectId: string, runId: string) => ({ tenantId: TENANT, projectId, approvalId: `a_${projectId}`, runId, taskId: 't1', revision: 1, requester: 'u', actionHash: 'h', scopeHash: 's', outcome: 'pending' });
    await expect(t.db.insert(schema.approvals).values(row('proj_b', 'run_b'))).rejects.toSatisfy(isFkViolation);
    await t.db.insert(schema.approvals).values(row('proj_a', 'run_a'));
  });

  it('events rejects a nonexistent or foreign attempt, accepts own', async () => {
    await expect(withTx(t.db, (tx) => appendEvent(tx, envelope({ attemptId: 'ghost' })))).rejects.toSatisfy(isFkViolation);
    await expect(withTx(t.db, (tx) => appendEvent(tx, envelope({ projectId: 'proj_b', runId: 'run_b', attemptId: 'att1' })))).rejects.toSatisfy(isFkViolation);
    const e = await withTx(t.db, (tx) => appendEvent(tx, envelope({ attemptId: 'att1' })));
    expect(e.attemptId).toBe('att1');
  });
});

describe('NULL revision cannot bypass task FKs', () => {
  beforeEach(async () => {
    await seedProject('proj_b', TENANT, 'run_b');
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: 'proj_a', runId: 'run_a', taskId: 't1', revision: 1, boardId: 'b', spec: {} });
  });
  const isCheck = (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code) === '23514';

  it('budget_reservations rejects task_id with NULL revision, and revision without task_id', async () => {
    const base = { tenantId: TENANT, projectId: 'proj_b', reservationId: 'rb', runId: 'run_b', state: 'held' };
    await expect(t.db.insert(schema.budgetReservations).values({ ...base, taskId: 't1' })).rejects.toSatisfy(isCheck);
    await expect(t.db.insert(schema.budgetReservations).values({ ...base, revision: 1 })).rejects.toSatisfy(isCheck);
    await t.db.insert(schema.budgetReservations).values(base); // run-level reservation is fine
  });

  it('approvals rejects task_id with NULL revision, and revision without task_id', async () => {
    const base = { tenantId: TENANT, projectId: 'proj_b', approvalId: 'ab', runId: 'run_b', requester: 'u', actionHash: 'h', scopeHash: 's', outcome: 'pending' };
    await expect(t.db.insert(schema.approvals).values({ ...base, taskId: 't1' })).rejects.toSatisfy(isCheck);
    await expect(t.db.insert(schema.approvals).values({ ...base, revision: 1 })).rejects.toSatisfy(isCheck);
    await t.db.insert(schema.approvals).values(base);
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

describe('migration 0009', () => {
  it('turns stored amounts into numeric with provenance; a malformed amount becomes unknown', async () => {
    const name = 't_mig_0009';
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${name}`);
    const { db, close } = createDb(TEST_DATABASE_URL, { max: 2, searchPath: name });
    const before = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n < '0009')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
      await migrate(db, before);
      await db.execute(sql`INSERT INTO projects (tenant_id, project_id, repository, default_branch, classification) VALUES ('t', 'p', 'r', 'main', 'internal')`);
      await db.execute(sql`INSERT INTO runs (tenant_id, project_id, run_id, lifecycle) VALUES ('t', 'p', 'r1', 'running')`);
      const put = (id: string, amount: string | null) => db.execute(sql`INSERT INTO budget_reservations (tenant_id, project_id, reservation_id, run_id, amount_usd, state) VALUES ('t', 'p', ${id}, 'r1', ${amount}, 'settled')`);
      await put('a', '1.250000');
      await put('b', 'lots');
      await put('c', null);
      await migrate(db);
      const rows = await db.execute(sql`SELECT reservation_id, amount_usd, amount_provenance FROM budget_reservations ORDER BY reservation_id`);
      expect(rows.map((r) => [r['reservation_id'], r['amount_usd'], r['amount_provenance']])).toEqual([
        ['a', '1.250000', 'estimated'], ['b', null, 'unavailable'], ['c', null, 'unavailable'],
      ]);
    } finally {
      await close();
      await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await admin.end();
      rmSync(before, { recursive: true, force: true });
    }
  });
});
