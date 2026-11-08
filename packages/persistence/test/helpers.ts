import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, migrate, type Db } from '../src/index.ts';

/** Compose defaults live here, in test setup only. CI sets DATABASE_URL. */
export const TEST_DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test';

export interface TestDb {
  db: Db;
  schema: string;
  close(): Promise<void>;
}

/** Each test file gets its own throwaway schema, so files can run in parallel. */
export async function setupTestDb(max = 10): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const { db, close } = createDb(TEST_DATABASE_URL, { max, searchPath: schema });
  await migrate(db);
  return {
    db,
    schema,
    async close() {
      await close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export const TENANT = 'tenant_a';

/** Typed loosely on purpose: one test passes an invalid event type. */
export function envelope(over: Record<string, unknown> = {}): any {
  const n = Math.random().toString(36).slice(2);
  return {
    schemaVersion: 1,
    eventId: `evt_${n}`,
    projectId: 'proj_a',
    runId: 'run_a',
    taskId: 'task_a',
    attemptId: null,
    type: 'task.ready',
    sequence: 0,
    aggregateRevision: 1,
    actor: { kind: 'scheduler', id: 'sched' },
    occurredAt: '2026-11-08T06:00:00Z',
    receivedAt: '2026-11-08T06:00:01Z',
    causationId: null,
    traceId: 'trace_1',
    payload: {},
    ...over,
  };
}
