import { newTaskStateFromSpec, type AttemptRecord, type TaskSpec, type TaskState, type TaskStatus } from '@selarikru/domain';
import { schema, type Tx } from '@selarikru/persistence';
import { and, asc, eq } from 'drizzle-orm';

export type AttemptRow = typeof schema.attempts.$inferSelect;

/** Scope and revision of one task's current status row. */
export interface TaskKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly taskId: string;
}

export async function lockStatusRow(tx: Tx, key: TaskKey) {
  const rows = await tx
    .select()
    .from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)))
    .for('update');
  return rows[0];
}

export async function loadAttempts(tx: Tx, key: TaskKey, revision: number): Promise<AttemptRow[]> {
  return tx
    .select()
    .from(schema.attempts)
    .where(and(
      eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId),
      eq(schema.attempts.taskId, key.taskId), eq(schema.attempts.revision, revision),
    ))
    .orderBy(asc(schema.attempts.attemptNumber));
}

/** An attempt with no recorded outcome is treated as `failed` once ended, so an unknown outcome consumes budget. */
function toRecord(a: AttemptRow): AttemptRecord {
  const outcome = (a.outcome ?? (a.endedAt === null ? 'running' : 'failed')) as AttemptRecord['outcome'];
  return { attemptId: a.attemptId, number: a.attemptNumber, outcome };
}

/** Rebuilds domain state from database rows; `kind` only affects merge transitions, which the scheduler never makes. */
export function buildTaskState(spec: TaskSpec, status: TaskStatus, attempts: readonly AttemptRow[]): TaskState | null {
  const init = newTaskStateFromSpec(spec, 'repository');
  if (!init.ok) return null;
  return { ...init.value, status, attempts: attempts.map(toRecord) };
}

export async function setStatus(tx: Tx, key: TaskKey, rowRevision: number, status: TaskStatus, now: Date): Promise<number> {
  const next = rowRevision + 1;
  await tx
    .update(schema.taskStatus)
    .set({ status, rowRevision: next, updatedAt: now })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  return next;
}
