import { schema, sql, withTx, type Db } from '@selarikru/persistence';
import { markTaskMerged } from '@selarikru/workflow';
import { and, eq } from 'drizzle-orm';
import { emitIntegration, INTEGRATION_ACTOR } from './events.ts';
import type { GitHubPort } from './port.ts';
import { INTEGRATION } from './webhook.ts';

export interface ReconcileDeps {
  readonly db: Db;
  readonly port: GitHubPort;
  readonly now: () => Date;
}

export interface RunKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
}

export type ReconcileOutcome = { readonly status: 'merged' | 'open' | 'closed' | 'sha_mismatch' | 'unchanged' | 'unknown' };

/**
 * Brings a run's recorded change state in line with GitHub. The merged state comes only from `port.getPullRequest` (state and exact head
 * SHA); a webhook body is never consulted. A merge is recorded only when the merged head is exactly the verified candidate SHA: then
 * `change.merged` is emitted by the integration actor, repository tasks that are `verified` become `merged`, and the run becomes `merged`.
 * A read failure throws and changes nothing. Re-running after success does nothing.
 */
export async function reconcileRun(key: RunKey, deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const where = and(eq(schema.changeRequests.tenantId, key.tenantId), eq(schema.changeRequests.projectId, key.projectId), eq(schema.changeRequests.runId, key.runId));
  const row = (await deps.db.select().from(schema.changeRequests).where(where))[0];
  if (!row) return { status: 'unknown' };
  if (row.status === 'merged') return { status: 'unchanged' };
  const pr = await deps.port.getPullRequest(row.repository, row.prNumber);
  if (!pr) return { status: 'unknown' };
  const now = deps.now();
  return withTx(deps.db, async (tx): Promise<ReconcileOutcome> => {
    const locked = (await tx.select().from(schema.changeRequests).where(where).for('update'))[0];
    if (!locked || locked.status === 'merged') return { status: 'unchanged' };
    const observed = { observedHeadSha: pr.headSha, observedAt: now };
    if (pr.state === 'open') { await tx.update(schema.changeRequests).set({ ...observed, status: 'open' }).where(where); return { status: 'open' }; }
    if (pr.state === 'closed') { await tx.update(schema.changeRequests).set({ ...observed, status: 'closed' }).where(where); return { status: 'closed' }; }
    if (pr.headSha !== locked.candidateSha) {
      await tx.update(schema.changeRequests).set({ ...observed, status: 'merged_sha_mismatch', mergeCommitSha: pr.mergeCommitSha }).where(where);
      return { status: 'sha_mismatch' };
    }
    await tx.update(schema.changeRequests).set({ ...observed, status: 'merged', mergeCommitSha: pr.mergeCommitSha }).where(where);
    const payload = { prNumber: pr.number, url: pr.url, candidateSha: locked.candidateSha, mergeCommitSha: pr.mergeCommitSha };
    await emitIntegration(tx, key, now, 'change.merged', payload);
    const tasks = await tx.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus)
      .innerJoin(schema.taskRevisions, and(
        eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
        eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
      .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskRevisions.runId, key.runId), eq(schema.taskStatus.status, 'verified')))
      .orderBy(schema.taskStatus.taskId);
    for (const t of tasks) await markTaskMerged(tx, { tenantId: key.tenantId, projectId: key.projectId, taskId: t.taskId }, now, INTEGRATION_ACTOR, payload);
    await tx.update(schema.runs).set({ lifecycle: 'merged' }).where(and(
      eq(schema.runs.tenantId, key.tenantId), eq(schema.runs.projectId, key.projectId), eq(schema.runs.runId, key.runId), eq(schema.runs.lifecycle, 'ready_for_review')));
    return { status: 'merged' };
  });
}

export interface PassResult {
  readonly processed: number;
  readonly ignored: number;
  readonly polled: number;
  readonly failed: number;
}

/**
 * Works through webhook hints (`received` deliveries): each triggers an authoritative reconcile of the PR it names. A hint for a PR we
 * did not open is marked `ignored`. A failed read keeps the hint `received` with its error, to be retried.
 */
export async function processPendingDeliveries(deps: ReconcileDeps): Promise<Pick<PassResult, 'processed' | 'ignored' | 'failed'>> {
  const rows = await deps.db.select().from(schema.integrationDeliveries).where(and(eq(schema.integrationDeliveries.integration, INTEGRATION), eq(schema.integrationDeliveries.status, 'received')))
    .orderBy(schema.integrationDeliveries.updatedAt, schema.integrationDeliveries.deliveryId);
  const out = { processed: 0, ignored: 0, failed: 0 };
  const mark = (r: (typeof rows)[number], status: string, error: string | null) =>
    deps.db.update(schema.integrationDeliveries).set({ status, lastError: error, attempts: r.attempts + 1, updatedAt: deps.now() }).where(and(
      eq(schema.integrationDeliveries.tenantId, r.tenantId), eq(schema.integrationDeliveries.projectId, r.projectId), eq(schema.integrationDeliveries.deliveryId, r.deliveryId)));
  for (const r of rows) {
    const prNumber = (r.detail as { prNumber?: unknown }).prNumber;
    const cr = typeof prNumber === 'number'
      ? (await deps.db.select().from(schema.changeRequests).where(and(eq(schema.changeRequests.tenantId, r.tenantId), eq(schema.changeRequests.projectId, r.projectId), eq(schema.changeRequests.prNumber, prNumber))))[0]
      : undefined;
    if (!cr) { await mark(r, 'ignored', null); out.ignored += 1; continue; }
    try {
      await reconcileRun({ tenantId: r.tenantId, projectId: r.projectId, runId: cr.runId }, deps);
      await mark(r, 'processed', null);
      out.processed += 1;
    } catch (e) {
      await mark(r, 'received', String((e as Error).message).slice(0, 500));
      out.failed += 1;
    }
  }
  return out;
}

/** Reads every open PR once. This is the local path (GitHub cannot reach localhost) and also catches missed or delayed webhooks. */
export async function pollOpenChangeRequests(deps: ReconcileDeps): Promise<Pick<PassResult, 'polled' | 'failed'>> {
  const open = await deps.db.select().from(schema.changeRequests).where(eq(schema.changeRequests.status, 'open'));
  let failed = 0;
  for (const cr of open) {
    try { await reconcileRun({ tenantId: cr.tenantId, projectId: cr.projectId, runId: cr.runId }, deps); } catch { failed += 1; }
  }
  return { polled: open.length, failed };
}

export interface ReconcilerDriver {
  /** Runs one pass now: pending hints, then a poll of open PRs. */
  tick(): Promise<PassResult>;
  ticks(): number;
  stop(): Promise<void>;
}

/** Interval driver on the injected clock. Passes never overlap; a failing pass is reported and retried on the next interval. */
export function startReconciler(options: ReconcileDeps & { intervalMs: number; onError?: (error: unknown) => void }): ReconcilerDriver {
  let stopped = false;
  let count = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = async (): Promise<PassResult> => {
    try {
      const a = await processPendingDeliveries(options);
      const b = await pollOpenChangeRequests(options);
      return { ...a, polled: b.polled, failed: a.failed + b.failed };
    } finally { count += 1; }
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { inFlight = tick().catch((e: unknown) => options.onError?.(e)).finally(schedule); }, options.intervalMs);
  };
  schedule();
  return { tick, ticks: () => count, async stop() { stopped = true; if (timer) clearTimeout(timer); await inFlight; } };
}
