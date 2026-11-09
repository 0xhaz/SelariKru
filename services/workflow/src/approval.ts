import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, LeaseGrantSchema, TaskSpecSchema, transition, WORKER_APPROVAL_OPERATIONS, type LeaseGrant, type TaskStatus } from '@selarikru/domain';
import { evaluate, type Operation, type PolicyDecision, type Policy } from '@selarikru/policy';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, asc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';
import type { SchedulerContext } from './types.ts';

/** How long a request stays approvable. An expired request can no longer be granted; it never becomes a grant by itself. */
export const APPROVAL_TTL_SECONDS = 86_400;

const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export interface ApprovalGate {
  readonly op: Operation;
  /** Who is asking: the runner for a worker request, `scheduler` for a placement or repair gate. */
  readonly requester: string;
  /** The human-readable request. Written to the event and the row, so a worker's text must already be redacted. */
  readonly reason: string;
  /** What exactly is being approved, beyond the operation kind: part of the scope hash, stored with the row. Non-secret values only. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface OpenedApproval {
  readonly approvalId: string;
  readonly scopeHash: string;
  readonly expiresAt: string;
  readonly actionHash: string;
}

/** Binds a gate to one task revision and policy version. A change to any of them is a different scope and a grant for the old one does not apply. */
export function approvalScopeHash(key: TaskKey, runId: string, revision: number, gate: ApprovalGate, policy: Policy | undefined): string {
  return hash({ v: 1, tenantId: key.tenantId, projectId: key.projectId, runId, taskId: key.taskId, revision, policyVersion: policy?.policyVersion ?? null, operation: gate.op.kind, detail: gate.detail });
}

/** A human grant for exactly this revision and scope, still within its expiry, that no attempt has used yet. */
export async function findUsableGrant(tx: Tx, key: TaskKey, revision: number, scopeHash: string, now: Date): Promise<{ approvalId: string } | undefined> {
  const rows = await tx
    .select({ approvalId: schema.approvals.approvalId })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId),
      eq(schema.approvals.revision, revision), eq(schema.approvals.scopeHash, scopeHash), eq(schema.approvals.outcome, 'granted'), isNull(schema.approvals.consumedAt),
      or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, now)),
    ))
    .limit(1);
  return rows[0];
}

/**
 * The one place an approval row is created. `evaluate` is the only authority: a row exists only for `require_approval`, so a deny (hard or
 * configured) and an operation policy simply allows leave nothing a person could approve. The caller holds the task's status lock.
 */
export async function openApproval(
  ctx: SchedulerContext, tx: Tx, key: TaskKey, runId: string, revision: number, gate: ApprovalGate, now: Date,
): Promise<{ decision: PolicyDecision; approval?: OpenedApproval }> {
  const decision = evaluate(gate.op, ctx.policy);
  if (decision.decision !== 'require_approval') return { decision };
  const scopeHash = approvalScopeHash(key, runId, revision, gate, ctx.policy);
  const actionHash = hash({ operation: gate.op.kind, reason: gate.reason, detail: gate.detail });
  const expiresAt = new Date(now.getTime() + (ctx.approvalTtlSeconds ?? APPROVAL_TTL_SECONDS) * 1000);
  const approvalId = `apr_${randomUUID()}`;
  const inserted = await tx
    .insert(schema.approvals)
    .values({
      tenantId: key.tenantId, projectId: key.projectId, approvalId, runId, taskId: key.taskId, revision, requester: gate.requester, actionHash, scopeHash,
      expectedRevisions: { [key.taskId]: revision }, expiresAt, policy: decision.policyVersion, outcome: 'pending',
      detail: { operation: gate.op.kind, reason: gate.reason, decisionReason: decision.reason, ...gate.detail },
    })
    .onConflictDoNothing()
    .returning({ approvalId: schema.approvals.approvalId, expiresAt: schema.approvals.expiresAt });
  if (inserted[0]) return { decision, approval: { approvalId, scopeHash, actionHash, expiresAt: expiresAt.toISOString() } };
  const existing = (await tx
    .select({ approvalId: schema.approvals.approvalId, expiresAt: schema.approvals.expiresAt })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId), eq(schema.approvals.revision, revision), eq(schema.approvals.scopeHash, scopeHash), eq(schema.approvals.outcome, 'pending'))))[0]!;
  return { decision, approval: { approvalId: existing.approvalId, scopeHash, actionHash, expiresAt: (existing.expiresAt ?? expiresAt).toISOString() } };
}

/** Grants a new attempt receives: every human grant for this task revision, not yet used, still within its expiry. Scheduler gates (cloud, repair) are decided at claim, not delivered. */
export async function loadWorkerGrants(tx: Tx, key: TaskKey, revision: number, now: Date): Promise<readonly LeaseGrant[]> {
  const rows = await tx
    .select({ approvalId: schema.approvals.approvalId, scopeHash: schema.approvals.scopeHash, expiresAt: schema.approvals.expiresAt, detail: schema.approvals.detail })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId),
      eq(schema.approvals.revision, revision), eq(schema.approvals.outcome, 'granted'), isNull(schema.approvals.consumedAt),
      or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, now)),
    ));
  const grants: LeaseGrant[] = [];
  for (const r of rows) {
    const destination = r.detail['destinationKind'] === 'network_host' && typeof r.detail['destination'] === 'string' ? { kind: 'network_host' as const, host: r.detail['destination'] } : null;
    const parsed = LeaseGrantSchema.safeParse({ approvalId: r.approvalId, scopeHash: r.scopeHash, operation: r.detail['operation'], destination, expiresAt: r.expiresAt?.toISOString() ?? null });
    // Not a worker operation (a scheduler gate) or an unrecognisable row: never delivered, so it can never widen what the attempt believes it holds.
    if (parsed.success && (WORKER_APPROVAL_OPERATIONS as readonly string[]).includes(parsed.data.operation)) grants.push(parsed.data);
  }
  return grants.sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1));
}

/** Marks every grant for this task revision as used by the attempt that just started, so a later attempt needs a fresh approval. */
export async function consumeGrants(tx: Tx, key: TaskKey, revision: number, attemptId: string, now: Date): Promise<void> {
  await tx
    .update(schema.approvals)
    .set({ consumedAt: now, consumedBy: attemptId })
    .where(and(
      eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId),
      eq(schema.approvals.revision, revision), eq(schema.approvals.outcome, 'granted'), isNull(schema.approvals.consumedAt),
    ));
}

/**
 * Closes every pending approval past its expiry: `outcome = expired`, and a task still waiting on it moves to `blocked` with `task.blocked` reason
 * `approval_expired`. Each row is its own transaction, status row before approval row, as the grant route locks them. A repeat finds nothing.
 */
export async function expireApprovals(ctx: SchedulerContext, now: Date): Promise<readonly string[]> {
  const due = await ctx.db
    .select({ tenantId: schema.approvals.tenantId, projectId: schema.approvals.projectId, approvalId: schema.approvals.approvalId, taskId: schema.approvals.taskId, runId: schema.approvals.runId, revision: schema.approvals.revision })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.outcome, 'pending'), isNotNull(schema.approvals.expiresAt), lte(schema.approvals.expiresAt, now)))
    .orderBy(asc(schema.approvals.expiresAt), asc(schema.approvals.approvalId));
  const expired: string[] = [];
  const failures: unknown[] = [];
  for (const row of due) {
    // One row's failure (a stored spec that no longer parses, a transient error) is that row's alone: the rest of the sweep still runs.
    const closed = await withTx(ctx.db, async (tx) => {
      const key: TaskKey | null = row.taskId ? { tenantId: row.tenantId, projectId: row.projectId, taskId: row.taskId } : null;
      const task = key ? await lockStatusRow(tx, key) : undefined;
      const where = and(eq(schema.approvals.tenantId, row.tenantId), eq(schema.approvals.projectId, row.projectId), eq(schema.approvals.approvalId, row.approvalId));
      const locked = (await tx.select().from(schema.approvals).where(where).for('update'))[0];
      // Recheck under the lock: a decision may have landed since the scan.
      if (!locked || locked.outcome !== 'pending' || !locked.expiresAt || locked.expiresAt.getTime() > now.getTime()) return false;
      await tx.update(schema.approvals).set({ outcome: 'expired' }).where(where);
      const payload = { reason: 'approval_expired', approvalId: locked.approvalId, scopeHash: locked.scopeHash, expiresAt: locked.expiresAt.toISOString() };
      if (key && task && task.status === 'awaiting_approval' && task.currentRevision === locked.revision) {
        const revision = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(
          eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, task.currentRevision)));
        const state = buildTaskState(TaskSpecSchema.parse(revision[0]!.spec), task.status as TaskStatus, await loadAttempts(tx, key, task.currentRevision));
        if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
        const moved = transition(state, { type: 'approval_expired' });
        if (!moved.ok) throw new Error(`illegal approval expiry: ${JSON.stringify(moved.error)}`);
        const aggregateRevision = await setStatus(tx, key, task.rowRevision, moved.value.status, now);
        await emit(tx, { projectId: key.projectId, runId: revision[0]!.runId, taskId: key.taskId, aggregateRevision }, now, { type: 'task.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload });
      } else if (!key && locked.runId) {
        await emit(tx, { projectId: locked.projectId, runId: locked.runId, taskId: locked.runId, aggregateRevision: 0 }, now, { type: 'task.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload });
      }
      return true;
    }).catch((e: unknown) => { failures.push(e); return false; });
    if (closed) expired.push(row.approvalId);
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} approval expiry row(s) failed (${expired.length} expired)`);
  return expired;
}
