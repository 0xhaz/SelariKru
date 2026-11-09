import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@selarikru/domain';
import { evaluate, type Operation, type PolicyDecision, type Policy } from '@selarikru/policy';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq, isNull } from 'drizzle-orm';
import type { TaskKey } from './taskstate.ts';
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

/** A human grant for exactly this revision and scope that no attempt has used yet. */
export async function findUsableGrant(tx: Tx, key: TaskKey, revision: number, scopeHash: string): Promise<{ approvalId: string } | undefined> {
  const rows = await tx
    .select({ approvalId: schema.approvals.approvalId })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId),
      eq(schema.approvals.revision, revision), eq(schema.approvals.scopeHash, scopeHash), eq(schema.approvals.outcome, 'granted'), isNull(schema.approvals.consumedAt),
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
