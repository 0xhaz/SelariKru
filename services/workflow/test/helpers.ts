import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { TaskSpecSchema, type HarnessCatalog, type TaskSpec } from '@selarikru/domain';
import { createDb, migrate, schema, type Db } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import type { Policy } from '@selarikru/policy';
import { createScheduler, type Caps, type Runner, type Scheduler } from '../src/index.ts';

/** Compose defaults live here, in test setup only. CI sets DATABASE_URL. */
export const TEST_DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test';

export const TENANT = 'tenant_a';
export const PROJECT = 'proj_a';
export const RUN = 'run_a';

export interface TestDb {
  db: Db;
  schema: string;
  close(): Promise<void>;
}

/** Each test file gets its own throwaway schema, same approach as packages/persistence. */
export async function setupTestDb(max = 25): Promise<TestDb> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${name}`);
  const { db, close } = createDb(TEST_DATABASE_URL, { max, searchPath: name });
  await migrate(db);
  return {
    db,
    schema: name,
    async close() {
      await close();
      await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await admin.end();
    },
  };
}

export async function resetDb(db: Db, budget: Record<string, unknown> = { limitUsd: 1000 }): Promise<void> {
  await db.execute(sql`TRUNCATE model_assignments, projects, project_sequences, runs, task_revisions, task_status, dependencies, attempts, resource_claims, budget_reservations, artifacts, check_runs, approvals, decisions, knowledge_nodes, knowledge_edges, events, outbox, consumer_cursors, integration_deliveries, operation_receipts CASCADE`);
  await db.insert(schema.projects).values({ tenantId: TENANT, projectId: PROJECT, repository: 'r', defaultBranch: 'main', classification: 'internal' });
  await db.insert(schema.runs).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, lifecycle: 'running', budget });
}

export function specFor(taskId: string, over: Partial<TaskSpec> & { maxAttempts?: number; maxCostUsd?: number; timeoutSeconds?: number } = {}): TaskSpec {
  const { maxAttempts = 3, maxCostUsd = 1, timeoutSeconds = 1800, ...rest } = over;
  return TaskSpecSchema.parse({
    schemaVersion: 1, tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId, boardId: 'b1', revision: 1,
    role: 'backend', title: taskId, baseSha: 'abc', requirementIds: [], dependencies: [], contractRefs: [], allowedPaths: [],
    resourceClaims: [], acceptanceCheckIds: [], classification: 'internal', policyVersion: 'v1', execution: 'eligible_any',
    inferencePolicyId: 'p1', limits: { maxAttempts, timeoutSeconds, maxCostUsd }, ...rest,
  });
}

export async function seedTask(db: Db, spec: TaskSpec, status = 'ready'): Promise<void> {
  await db.insert(schema.taskRevisions).values({
    tenantId: TENANT, projectId: PROJECT, runId: spec.runId, taskId: spec.taskId, revision: spec.revision, boardId: spec.boardId, spec,
  });
  await db.insert(schema.taskStatus).values({ tenantId: TENANT, projectId: PROJECT, taskId: spec.taskId, currentRevision: spec.revision, status });
  for (const d of spec.dependencies) {
    await db.insert(schema.dependencies).values({
      tenantId: TENANT, projectId: PROJECT, taskId: spec.taskId, revision: spec.revision,
      dependsOnTaskId: d.taskId, dependsOnRevision: d.revision, condition: d.condition,
    });
  }
}

export interface TestClock {
  now(): Date;
  advance(seconds: number): void;
}

export function testClock(start = '2026-11-08T06:00:00.000Z'): TestClock {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (s) => { t += s * 1000; } };
}

export const TEST_MODELS = { allowed: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-opus-5-5' }], default: { provider: 'anthropic', model: 'claude-sonnet-5-5' } };
/** A fixed catalog for tests. Real availability is read by the adapter; tests must not depend on what this machine has installed. */
export const TEST_CATALOG: HarnessCatalog = {
  status: 'detected', detail: null,
  providers: [{
    provider: 'anthropic', label: 'Claude', harnessVersion: '2.1.316', modelSelection: 'supported',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', route: 'cloud', rate: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, source: 'test-table' } },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', route: 'cloud', rate: { inputUsdPerMTok: 4, outputUsdPerMTok: 20, source: 'test-table' } },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', route: 'cloud', rate: null },
    ],
  }],
};
export const POLICY = { policyVersion: 'test.1', models: TEST_MODELS, limits: { repairAttempts: 2 } } as const satisfies Policy;
/** Policy that lets a cloud worker start for internal data from the default repository source. */
export const CLOUD_POLICY = {
  policyVersion: 'test.cloud.1', models: TEST_MODELS, limits: { repairAttempts: 2, maxConcurrentTotal: 2 }, selectedSources: [`repo:${PROJECT}`],
  destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'execution', classifications: ['public', 'internal'] }],
} as const satisfies Policy;
export const runner = (id: string, location: Runner['location'] = 'local'): Runner => ({ runnerId: id, tenantId: TENANT, location });
export const CAPS = { maxConcurrentTotal: 2, attemptTimeoutSeconds: 1800, maxInfraRetries: 3, infraRetryBackoffSeconds: 10, infraRetryBackoffMaxSeconds: 40 } satisfies Caps;
export const capsWith = (maxConcurrentTotal: number) => ({ ...CAPS, maxConcurrentTotal });

export const makeScheduler = (db: Db, clock: TestClock): Scheduler => createScheduler({ db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG });

export async function statusOf(db: Db, taskId: string): Promise<{ status: string; revision: number; rowRevision: number }> {
  const rows = await db.execute(sql`SELECT status, current_revision, row_revision FROM task_status WHERE task_id = ${taskId}`);
  const r = rows[0]!;
  return { status: String(r['status']), revision: Number(r['current_revision']), rowRevision: Number(r['row_revision']) };
}

export const countRows = async (db: Db, table: string, where = 'true'): Promise<number> =>
  Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)))[0]!['n']);

export async function eventTypes(db: Db): Promise<string[]> {
  return (await db.execute(sql`SELECT type FROM events ORDER BY sequence`)).map((r) => String(r['type']));
}

export async function reservedTotal(db: Db): Promise<number> {
  const rows = await db.execute(sql`SELECT coalesce(sum(amount_usd::numeric), 0)::float AS total FROM budget_reservations`);
  return Number(rows[0]!['total']);
}
