import { newTaskStateFromSpec, type AttemptRecord, type TaskSpec, type TaskState, type TaskStatus } from '@selarikru/domain';
import { schema, type Tx } from '@selarikru/persistence';
import { and, asc, eq, sql } from 'drizzle-orm';

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

/**
 * Sets the status and moves the row's revision by one from what is stored, and returns it. The caller holds the row; `rowRevision` is what it read, and is also what an earlier
 * write in the same transaction may already have moved (`bumpRevision`), so the stored value, not the read one, is the base: a revision never repeats or goes back.
 */
export async function setStatus(tx: Tx, key: TaskKey, rowRevision: number, status: TaskStatus, now: Date): Promise<number> {
  void rowRevision;
  const [row] = await tx
    .update(schema.taskStatus)
    .set({ status, rowRevision: sql`${schema.taskStatus.rowRevision} + 1`, updatedAt: now })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)))
    .returning({ rowRevision: schema.taskStatus.rowRevision });
  return row!.rowRevision;
}

/** Moves the row's revision by one without changing its status, for an event about the task that a client following snapshot and cursor must see. The caller holds the row. */
export async function bumpRevision(tx: Tx, key: TaskKey): Promise<number> {
  const [row] = await tx
    .update(schema.taskStatus)
    .set({ rowRevision: sql`${schema.taskStatus.rowRevision} + 1` })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)))
    .returning({ rowRevision: schema.taskStatus.rowRevision });
  return row!.rowRevision;
}
