import { RUNNER_RECENT_SECONDS, TaskSpecSchema, budgetUsed, checkDelegation, workerRoleOf, type DelegationCheck } from '@selarikru/domain';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { emit } from './events.ts';
import { bumpRevision, loadAttempts, lockStatusRow } from './taskstate.ts';
import type { SchedulerContext } from './types.ts';

/**
 * H11: the Project Manager's delegation, applied by the server inside the owner's accepted plan and nowhere else.
 *
 * - Only the run's accepted plan revision authorises it. Only that plan's tasks, to enabled workers whose role is the task's role (`checkDelegation`). No path, budget,
 *   role or new task can be named: such a proposal is refused whole.
 * - An agent's delegation applies only while the run's `auto_delegate` setting is on (the default). Off, nothing is applied and everything goes to the owner.
 * - Reassigning a failed task is a retry, and only while a repair is left.
 * - Each applied assignment records `task.delegated` with its actor (`agent:pm` or the owner) and the plan revision that authorised it.
 *
 * Lock order (listed in verification.ts): the scheduler lock, then each task's status row (in task id order), then its `task_delegations` row, then the event sequence:
 * the claim's own order, so a delegation and a claim serialise on the scheduler lock.
 */
export interface DelegationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly planRevision: number;
  readonly assignments: readonly Record<string, unknown>[];
  readonly actor: { readonly kind: 'agent'; readonly id: 'pm' } | { readonly kind: 'human'; readonly id: string };
}

export type DelegationResult = DelegationCheck & { readonly autoDelegate: boolean };

export const PM_ACTOR = { kind: 'agent', id: 'pm' } as const;

export async function applyDelegation(ctx: Pick<SchedulerContext, 'db' | 'now'>, input: DelegationInput, outer?: Tx): Promise<DelegationResult | null> {
  const run = async (tx: Tx): Promise<DelegationResult | null> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${input.tenantId}`}, 0))`);
    const now = ctx.now();
    const [runRow] = await tx.select({ planRevision: schema.runs.planRevision }).from(schema.runs)
      .where(and(eq(schema.runs.tenantId, input.tenantId), eq(schema.runs.projectId, input.projectId), eq(schema.runs.runId, input.runId)));
    if (!runRow) return null;
    const [setting] = await tx.select({ desired: schema.runSettings.desired }).from(schema.runSettings)
      .where(and(eq(schema.runSettings.tenantId, input.tenantId), eq(schema.runSettings.projectId, input.projectId), eq(schema.runSettings.runId, input.runId), eq(schema.runSettings.field, 'auto_delegate')));
    // On unless the owner saved an explicit false.
    const autoDelegate = setting === undefined ? true : setting.desired !== false;
    const all = input.assignments.map((a) => ({ taskId: String(a['taskId'] ?? ''), workerId: String(a['workerId'] ?? '') }));
    if (input.actor.kind === 'agent' && !autoDelegate) return { apply: [], refuse: all.map((a) => ({ ...a, reason: 'auto_delegate_off' as const })), autoDelegate };

    // The accepted plan's tasks: the run's tasks at their current revision, in task id order (the lock order).
    const revs = await tx.select({ taskId: schema.taskRevisions.taskId, revision: schema.taskRevisions.revision, spec: schema.taskRevisions.spec }).from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, input.tenantId), eq(schema.taskRevisions.projectId, input.projectId), eq(schema.taskRevisions.runId, input.runId)));
    const wanted = [...new Set(all.map((a) => a.taskId))].sort();
    const tasks: { taskId: string; role: string; status: string; attemptsUsed: number; maxAttempts: number; revision: number }[] = [];
    for (const taskId of wanted) {
      const key = { tenantId: input.tenantId, projectId: input.projectId, taskId };
      const status = await lockStatusRow(tx, key);
      const rev = revs.find((r) => r.taskId === taskId && status && r.revision === status.currentRevision);
      const spec = rev ? TaskSpecSchema.safeParse(rev.spec) : null;
      if (!status || !spec?.success) continue;
      const attempts = await loadAttempts(tx, key, status.currentRevision);
      // Counted as the claim counts the attempt budget, against the task's own limit.
      tasks.push({ taskId, role: spec.data.role, status: status.status, attemptsUsed: budgetUsed(attempts as unknown as Parameters<typeof budgetUsed>[0]), maxAttempts: spec.data.limits.maxAttempts, revision: status.currentRevision });
    }
    const runnerIds = [...new Set(all.map((a) => a.workerId))];
    const workerRows = runnerIds.length === 0 ? [] : await tx.select({ runnerId: schema.runnerSettings.runnerId, field: schema.runnerSettings.field, desired: schema.runnerSettings.desired }).from(schema.runnerSettings)
      .where(and(eq(schema.runnerSettings.tenantId, input.tenantId), inArray(schema.runnerSettings.runnerId, runnerIds)));
    const known = runnerIds.length === 0 ? [] : await tx.select({ runnerId: schema.runners.runnerId, revoked: sql<boolean>`${schema.runners.revokedAt} IS NOT NULL` }).from(schema.runners)
      .where(and(eq(schema.runners.tenantId, input.tenantId), inArray(schema.runners.runnerId, runnerIds)));
    const history = await claimHistory(tx, input.tenantId, input.projectId, runnerIds);
    const settings = workerRows.map((r) => ({ workerId: r.runnerId, field: r.field, value: r.desired }));
    const workers = known.map((k) => {
      const enabled = workerRows.find((r) => r.runnerId === k.runnerId && r.field === 'enabled')?.desired;
      // The same role rule the browser and the demo use (`workerRoleOf`): a saved role, else the role of the task it last claimed.
      return { workerId: k.runnerId, role: workerRoleOf(k.runnerId, settings, history), enabled: (enabled === undefined ? true : enabled === true) && !k.revoked };
    });
    const checked = checkDelegation(
      { planRevision: runRow.planRevision ?? -1, tasks, workers },
      { planRevision: input.planRevision, assignments: input.assignments as never },
    );
    for (const a of checked.apply) {
      const t = tasks.find((x) => x.taskId === a.taskId)!;
      const values = {
        tenantId: input.tenantId, projectId: input.projectId, taskId: a.taskId, revision: t.revision, runId: input.runId, workerId: a.workerId,
        planRevision: input.planRevision, actorKind: input.actor.kind, actorId: input.actor.id, assignedAt: now,
      };
      await tx.insert(schema.taskDelegations).values(values).onConflictDoUpdate({
        target: [schema.taskDelegations.tenantId, schema.taskDelegations.projectId, schema.taskDelegations.taskId, schema.taskDelegations.revision],
        set: { workerId: a.workerId, planRevision: input.planRevision, actorKind: input.actor.kind, actorId: input.actor.id, assignedAt: now },
      });
      // A client following snapshot and cursor must see the delegation: the row's revision moves with it.
      const rowRevision = await bumpRevision(tx, { tenantId: input.tenantId, projectId: input.projectId, taskId: a.taskId });
      await emit(tx, { projectId: input.projectId, runId: input.runId, taskId: a.taskId, aggregateRevision: rowRevision }, now, {
        type: 'task.delegated', attemptId: null, actor: input.actor, payload: { workerId: a.workerId, planRevision: input.planRevision, revision: t.revision },
      });
    }
    return { ...checked, autoDelegate };
  };
  return outer ? run(outer) : withTx(ctx.db, run);
}

/** Each worker's claims in this project, with the claimed task's role and when: what `workerRoleOf` reads when no role is saved. */
export async function claimHistory(tx: Tx, tenantId: string, projectId: string, runnerIds: readonly string[]): Promise<{ workerId: string; role: string | null; at: Date | null }[]> {
  if (runnerIds.length === 0) return [];
  const rows = await tx.select({ runner: schema.attempts.runner, startedAt: schema.attempts.startedAt, spec: schema.taskRevisions.spec }).from(schema.attempts)
    .innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.attempts.tenantId), eq(schema.taskRevisions.projectId, schema.attempts.projectId), eq(schema.taskRevisions.taskId, schema.attempts.taskId), eq(schema.taskRevisions.revision, schema.attempts.revision)))
    .where(and(eq(schema.attempts.tenantId, tenantId), eq(schema.attempts.projectId, projectId), inArray(schema.attempts.runner, [...runnerIds])));
  return rows.flatMap((r) => (r.runner ? [{ workerId: r.runner, role: typeof (r.spec as { role?: unknown }).role === 'string' ? (r.spec as { role: string }).role : null, at: r.startedAt }] : []));
}

/** How recently a delegated worker must have polled or been seen to keep its delegation. */
export const DELEGATED_WORKER_FRESH_SECONDS = RUNNER_RECENT_SECONDS;
export const RELEASE_ACTOR = { kind: 'system', id: 'scheduler' } as const;

export type ReleaseReason = 'disabled' | 'revoked' | 'not_polling' | 'role_changed' | 'unknown_worker';

/**
 * Whether a delegated worker can still take its task (H11 fix round 1, I6), and if not, why. Read under the scheduler lock, as the claim reads everything else. The
 * role is resolved by the same rule as the delegation (`workerRoleOf`).
 */
export async function delegationStale(tx: Tx, key: { tenantId: string; projectId: string }, workerId: string, taskRole: string | null, now: Date): Promise<ReleaseReason | null> {
  const [r] = await tx.select({ revokedAt: schema.runners.revokedAt, lastSeenAt: schema.runners.lastSeenAt, lastPolledAt: schema.runners.lastPolledAt }).from(schema.runners)
    .where(and(eq(schema.runners.tenantId, key.tenantId), eq(schema.runners.runnerId, workerId)));
  if (!r) return 'unknown_worker';
  if (r.revokedAt !== null) return 'revoked';
  const rows = await tx.select({ field: schema.runnerSettings.field, desired: schema.runnerSettings.desired }).from(schema.runnerSettings)
    .where(and(eq(schema.runnerSettings.tenantId, key.tenantId), eq(schema.runnerSettings.runnerId, workerId)));
  if (rows.some((x) => x.field === 'enabled' && x.desired === false)) return 'disabled';
  const since = now.getTime() - DELEGATED_WORKER_FRESH_SECONDS * 1000;
  const seen = Math.max(r.lastSeenAt?.getTime() ?? -Infinity, r.lastPolledAt?.getTime() ?? -Infinity);
  if (seen < since) return 'not_polling';
  const role = workerRoleOf(workerId, rows.map((x) => ({ workerId, field: x.field, value: x.desired })), await claimHistory(tx, key.tenantId, key.projectId, [workerId]));
  if (taskRole !== null && role !== null && role !== taskRole) return 'role_changed';
  return null;
}

/** Releases a stale delegation: the row goes, and `task.undelegated` by the system names the worker and why. The task is then claimed as usual. */
export async function releaseDelegation(tx: Tx, key: { tenantId: string; projectId: string; taskId: string }, runId: string, revision: number, workerId: string, reason: ReleaseReason, now: Date): Promise<void> {
  await tx.delete(schema.taskDelegations).where(and(eq(schema.taskDelegations.tenantId, key.tenantId), eq(schema.taskDelegations.projectId, key.projectId), eq(schema.taskDelegations.taskId, key.taskId), eq(schema.taskDelegations.revision, revision)));
  const rowRevision = await bumpRevision(tx, key);
  await emit(tx, { projectId: key.projectId, runId, taskId: key.taskId, aggregateRevision: rowRevision }, now, { type: 'task.undelegated', attemptId: null, actor: RELEASE_ACTOR, payload: { workerId, reason, revision } });
}

/** The worker a task revision is delegated to, if any: only that worker may claim it. */
export async function delegatedWorker(tx: Tx, key: { tenantId: string; projectId: string; taskId: string }, revision: number): Promise<string | null> {
  const [row] = await tx.select({ workerId: schema.taskDelegations.workerId }).from(schema.taskDelegations)
    .where(and(eq(schema.taskDelegations.tenantId, key.tenantId), eq(schema.taskDelegations.projectId, key.projectId), eq(schema.taskDelegations.taskId, key.taskId), eq(schema.taskDelegations.revision, revision)));
  return row?.workerId ?? null;
}
