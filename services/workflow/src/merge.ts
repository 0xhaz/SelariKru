import { TaskSpecSchema, transition, type Actor, type TaskStatus } from '@selarikru/domain';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import { emit } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';

/**
 * Moves one `verified` repository task to `merged` through the domain state machine and emits `change.merged` for it.
 * Only the integration actor may emit that event (checked by `emit`). Callers must have confirmed the merge by an authoritative
 * read of the provider first. Returns false when the task is not `verified` (already merged, or its evidence was reopened).
 */
export async function markTaskMerged(tx: Tx, key: TaskKey, now: Date, actor: Actor, payload: Record<string, unknown>): Promise<boolean> {
  const row = await lockStatusRow(tx, key);
  if (!row || row.status !== 'verified') return false;
  const revisions = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(
    eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
  const rev = revisions[0];
  if (!rev) return false;
  const spec = TaskSpecSchema.parse(rev.spec);
  const attempts = await loadAttempts(tx, key, row.currentRevision);
  const state = buildTaskState(spec, row.status as TaskStatus, attempts);
  if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
  const next = transition(state, { type: 'change_merged' });
  if (!next.ok) return false;
  const aggregateRevision = await setStatus(tx, key, row.rowRevision, next.value.status, now);
  await emit(tx, { projectId: key.projectId, runId: rev.runId, taskId: key.taskId, aggregateRevision }, now, {
    type: 'change.merged', attemptId: attempts.at(-1)?.attemptId ?? null, actor, payload,
  });
  return true;
}
