import { APPLY_MODEL, APPLY_PROVIDER, TaskSpecSchema, checkAcceptedProposal, err, isApplyInputReason, ok, transition, type AcceptedProposal, type RecordedAssignment, type Result, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';
import type { Lease, SchedulerContext } from './types.ts';

/**
 * Accepted patch proposals (H5). The owner accepts a proposal the browser's patch agent produced and checked; the server checks it again against the stored task and keeps
 * it for the no-model apply worker. A claim of the task then starts an attempt that applies it, and nothing else: under `codingWorkers: 'off'` that is the only worker a
 * task is dispatched to.
 *
 * Lock order (listed in verification.ts): the scheduler lock, the task's status row, the task's `accepted_proposals` rows, then the event sequence: the claim's own order,
 * so an accept and a claim serialise on the scheduler lock and neither waits for the other's row.
 */

/** The assignment an apply attempt records: no model, so route `none`. */
export const APPLY_ASSIGNMENT: RecordedAssignment = { provider: APPLY_PROVIDER, model: APPLY_MODEL, source: 'proposal', route: 'none' };

/** Statuses a task may take an accepted proposal in: waiting to start, as the claim reads it. */
const ACCEPTING_STATUSES = ['planned', 'ready'];

export const PROPOSAL_STATES = ['accepted', 'applying', 'applied', 'failed', 'superseded'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** The proposal as it is now. An accept with a key already used for it reads this; it never replays an older receipt. */
export interface AcceptReceipt {
  readonly proposalId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly digest: string;
  readonly fileCount: number;
  readonly state: ProposalState;
  /** How many times it was queued for an apply attempt. */
  readonly round: number;
  /** Why the last apply attempt did not stand, when `state` is `failed`. */
  readonly lastFailure: string | null;
}
export interface AcceptRefusal {
  readonly reason: string;
  readonly status: 404 | 409 | 422;
  /** For `proposal_already_accepted`: where the proposal is now. */
  readonly state?: ProposalState;
}

export interface AcceptInput {
  readonly proposal: AcceptedProposal;
  readonly acceptedBy: string;
  /** The accept request's key. The same key again reads the proposal's current state; a new key re-queues one whose apply failed. */
  readonly idempotencyKey: string;
}

const rowKey = (k: TaskKey) => and(eq(schema.acceptedProposals.tenantId, k.tenantId), eq(schema.acceptedProposals.projectId, k.projectId), eq(schema.acceptedProposals.taskId, k.taskId));
type Row = typeof schema.acceptedProposals.$inferSelect;
const receiptOf = (r: Row): AcceptReceipt => ({
  proposalId: r.proposalId, taskId: r.taskId, revision: r.revision, digest: r.digest, fileCount: r.fileCount, state: r.state as ProposalState, round: r.round, lastFailure: r.state === 'failed' ? r.failureReason : null,
});

/**
 * Records an accepted proposal for the task's current revision, after the same checks the browser ran, against the stored spec, and queues it for an apply attempt.
 * Replaces one still waiting. A proposal whose last apply failed (or that was replaced) may be accepted again with a new key: it is queued again, one round higher.
 * A task blocked by an apply input error (the proposal, not the project) is made ready again by the accept, since the owner has proposed again.
 */
export async function acceptProposal(ctx: Pick<SchedulerContext, 'db' | 'now'>, key: TaskKey, input: AcceptInput, outer?: Tx): Promise<Result<AcceptReceipt, AcceptRefusal>> {
  const run = async (tx: Tx): Promise<Result<AcceptReceipt, AcceptRefusal>> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${key.tenantId}`}, 0))`);
    const now = ctx.now();
    const status = await lockStatusRow(tx, key);
    if (!status) return err({ reason: 'task_not_found', status: 404 });
    const p = input.proposal;
    const [existing] = await tx.select().from(schema.acceptedProposals)
      .where(and(eq(schema.acceptedProposals.tenantId, key.tenantId), eq(schema.acceptedProposals.projectId, key.projectId), eq(schema.acceptedProposals.proposalId, p.proposalId)));
    if (existing && existing.taskId !== key.taskId) return err({ reason: 'task_mismatch', status: 422 });
    // The same request again: the proposal as it is now, never the receipt it got then.
    if (existing && existing.acceptKey === input.idempotencyKey) return ok(receiptOf(existing));
    if (existing && !['failed', 'superseded'].includes(existing.state)) return err({ reason: 'proposal_already_accepted', status: 409, state: existing.state as ProposalState });
    const attempts = await loadAttempts(tx, key, status.currentRevision);
    const last = attempts[attempts.length - 1];
    const unblock = status.status === 'blocked' && last !== undefined && isApplyInputReason(last.exitReason);
    if (!ACCEPTING_STATUSES.includes(status.status) && !unblock) return err({ reason: 'task_not_applicable', status: 409 });
    const open = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts)
      .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId), isNull(schema.attempts.endedAt))).limit(1);
    if (open.length > 0) return err({ reason: 'task_not_applicable', status: 409 });
    const [rev] = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, status.currentRevision)));
    const spec = TaskSpecSchema.safeParse(rev?.spec);
    if (!rev || !spec.success) return err({ reason: 'task_spec_unreadable', status: 409 });
    const checked = checkAcceptedProposal(p, { taskId: key.taskId, revision: spec.data.revision, baseSha: spec.data.baseSha, allowedPaths: spec.data.allowedPaths });
    if (!checked.ok) return err({ reason: checked.code, status: checked.code === 'stale_revision' || checked.code === 'base_mismatch' ? 409 : 422 });
    // Accepted again: the very same change, or nothing.
    if (existing && existing.digest !== checked.digest) return err({ reason: 'proposal_changed', status: 409 });
    let rowRevision = status.rowRevision;
    if (unblock) {
      const state = buildTaskState(spec.data, status.status as TaskStatus, attempts);
      const moved = state ? transition(state, { type: 'unblocked' }) : null;
      if (!moved?.ok) return err({ reason: 'task_not_applicable', status: 409 });
      rowRevision = await setStatus(tx, key, status.rowRevision, moved.value.status, now);
      await emit(tx, { projectId: key.projectId, runId: rev.runId, taskId: key.taskId, aggregateRevision: rowRevision }, now, {
        type: 'task.ready', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: 'proposal_accepted', requestedBy: input.acceptedBy },
      });
    }
    await tx.update(schema.acceptedProposals).set({ state: 'superseded', updatedAt: now })
      .where(and(rowKey(key), eq(schema.acceptedProposals.state, 'accepted'), ne(schema.acceptedProposals.proposalId, p.proposalId)));
    let saved: Row;
    if (existing) {
      [saved] = await tx.update(schema.acceptedProposals).set({
        state: 'accepted', attemptId: null, failureReason: null, acceptKey: input.idempotencyKey, round: existing.round + 1, revision: spec.data.revision, routeRecordId: p.routeRecordId, acceptedBy: input.acceptedBy, acceptedAt: now, updatedAt: now,
      }).where(and(eq(schema.acceptedProposals.tenantId, key.tenantId), eq(schema.acceptedProposals.projectId, key.projectId), eq(schema.acceptedProposals.proposalId, p.proposalId))).returning() as [Row];
    } else {
      [saved] = await tx.insert(schema.acceptedProposals).values({
        tenantId: key.tenantId, projectId: key.projectId, proposalId: p.proposalId, taskId: key.taskId, revision: spec.data.revision, runId: rev.runId, baseSha: p.baseSha,
        routeRecordId: p.routeRecordId, digest: checked.digest, fileCount: p.results.length, results: p.results.map((r) => ({ path: r.path, sha256: r.sha256, content: r.content })),
        diff: p.diff, state: 'accepted', attemptId: null, acceptKey: input.idempotencyKey, round: 1, acceptedBy: input.acceptedBy, acceptedAt: now, updatedAt: now,
      }).returning() as [Row];
    }
    await emit(tx, { projectId: key.projectId, runId: rev.runId, taskId: key.taskId, aggregateRevision: rowRevision }, now, {
      type: 'proposal.accepted', attemptId: null, actor: { kind: 'human', id: input.acceptedBy },
      payload: { proposalId: p.proposalId, routeRecordId: p.routeRecordId, revision: spec.data.revision, baseSha: p.baseSha, digest: checked.digest, fileCount: p.results.length, round: saved.round },
    });
    return ok(receiptOf(saved));
  };
  return outer ? run(outer) : withTx(ctx.db, run);
}

/** An apply attempt ended (closeLease): its proposal is `applied` when it completed, else `failed` with the attempt's reason, so the owner can accept it again. */
export async function proposalAttemptEnded(tx: Tx, key: TaskKey, attemptId: string, exitReason: string, now: Date): Promise<void> {
  const completed = exitReason === 'completed';
  await tx.update(schema.acceptedProposals).set({ state: completed ? 'applied' : 'failed', failureReason: completed ? null : exitReason.slice(0, 500), updatedAt: now })
    .where(and(rowKey(key), eq(schema.acceptedProposals.attemptId, attemptId), eq(schema.acceptedProposals.state, 'applying')));
}

/** The latest proposal for this task revision, as it is now, for the owner's view. Null when none was accepted. */
export async function proposalStateFor(db: Executor, key: TaskKey, revision: number): Promise<AcceptReceipt | null> {
  const [row] = await db.select().from(schema.acceptedProposals).where(and(rowKey(key), eq(schema.acceptedProposals.revision, revision))).orderBy(desc(schema.acceptedProposals.updatedAt)).limit(1);
  return row ? receiptOf(row) : null;
}

/** The proposal waiting for an apply attempt on this revision and base, if any. Read after the claim locked the task's status row. */
export async function pendingProposal(tx: Executor, key: TaskKey, revision: number, baseSha: string) {
  const [row] = await tx.select({ proposalId: schema.acceptedProposals.proposalId, digest: schema.acceptedProposals.digest, fileCount: schema.acceptedProposals.fileCount, baseSha: schema.acceptedProposals.baseSha })
    .from(schema.acceptedProposals)
    .where(and(rowKey(key), eq(schema.acceptedProposals.state, 'accepted'), eq(schema.acceptedProposals.revision, revision), eq(schema.acceptedProposals.baseSha, baseSha)))
    .limit(1);
  return row ?? null;
}

/** The claim hands the proposal to its attempt, inside the claim's transaction. */
export async function markApplying(tx: Tx, key: TaskKey, proposalId: string, attemptId: string, now: Date): Promise<void> {
  await tx.update(schema.acceptedProposals).set({ state: 'applying', attemptId, updatedAt: now })
    .where(and(rowKey(key), eq(schema.acceptedProposals.proposalId, proposalId), eq(schema.acceptedProposals.state, 'accepted')));
}

/** What the apply attempt fetches: its proposal, for the current lease only. The runner checks every hash and the base again before it writes anything. */
export async function fetchProposalForLease(ctx: Pick<SchedulerContext, 'db' | 'now'>, lease: Pick<Lease, 'tenantId' | 'projectId' | 'attemptId' | 'fence' | 'leaseToken'>): Promise<Result<AcceptedProposal, { reason: 'stale_fence' | 'no_proposal'; status: 404 | 409 }>> {
  const now = ctx.now();
  const [a] = await ctx.db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
  if (!a || a.leaseFence !== lease.fence || a.leaseToken !== lease.leaseToken || a.endedAt !== null || a.leaseExpiresAt === null || a.leaseExpiresAt.getTime() <= now.getTime()) return err({ reason: 'stale_fence', status: 409 });
  const [row] = await ctx.db.select().from(schema.acceptedProposals)
    .where(and(eq(schema.acceptedProposals.tenantId, lease.tenantId), eq(schema.acceptedProposals.projectId, lease.projectId), eq(schema.acceptedProposals.attemptId, lease.attemptId), eq(schema.acceptedProposals.state, 'applying')));
  if (!row) return err({ reason: 'no_proposal', status: 404 });
  return ok({ proposalId: row.proposalId, taskId: row.taskId, taskRevision: row.revision, baseSha: row.baseSha, routeRecordId: row.routeRecordId, diff: row.diff, results: row.results });
}

/**
 * The latest proposal an apply attempt took for this task revision, with that attempt's outcome and change manifest: the change a review or a PR description reads.
 * Null when no apply attempt took one.
 */
export async function appliedProposalFor(db: Executor, key: TaskKey, revision: number) {
  const [row] = await db.select({
    proposalId: schema.acceptedProposals.proposalId, diff: schema.acceptedProposals.diff, results: schema.acceptedProposals.results, attemptId: schema.acceptedProposals.attemptId,
    outcome: schema.attempts.outcome, endedAt: schema.attempts.endedAt, detail: schema.attempts.detail,
  }).from(schema.acceptedProposals)
    .leftJoin(schema.attempts, and(eq(schema.attempts.tenantId, schema.acceptedProposals.tenantId), eq(schema.attempts.projectId, schema.acceptedProposals.projectId), eq(schema.attempts.attemptId, schema.acceptedProposals.attemptId)))
    .where(and(rowKey(key), inArray(schema.acceptedProposals.state, ['applying', 'applied']), eq(schema.acceptedProposals.revision, revision)))
    .orderBy(desc(schema.acceptedProposals.updatedAt)).limit(1);
  if (!row) return null;
  const manifest = (row.detail as { changeManifestSha256?: unknown } | null)?.changeManifestSha256;
  return { proposalId: row.proposalId, diff: row.diff, paths: row.results.map((r) => r.path), attemptId: row.attemptId, outcome: row.outcome, ended: row.endedAt !== null, changeManifestSha256: typeof manifest === 'string' ? manifest : null };
}
