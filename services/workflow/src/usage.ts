import { randomUUID } from 'node:crypto';
import {
  appendUsage, correctUsage, loadUsageSummary, readUsageEntries, recordOperation, schema, TOKEN_METRICS, withTx,
  type CostBasis, type Executor, type TokenMetric, type Tx, type UsageFigure, type UsageFigures, type UsageMetric, type WorkerHost, type WorkerPhase,
} from '@selarikru/persistence';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hasCancelRequest } from './cancel.ts';
import { formatMicros, lockBudget, reservationIdFor, toMicros, type BudgetPosition, type RunScope } from './reserve.ts';
import { lockStatusRow, type AttemptRow, type TaskKey } from './taskstate.ts';
import type { PublishResult, ReportedUsage, SchedulerContext } from './types.ts';

/** Figures past these are not real usage. They read as unavailable and can neither overflow a column nor pollute a total. */
const MAX_REPORTED_TOKENS = 1e12;
const MAX_REPORTED_COST_USD = 1e9;

const reported = (value: number | null | undefined, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

/** A worker's number: estimated at best, whatever the worker claims about it. Null stays null. */
const selfReported = (quantity: string | null): UsageFigures =>
  quantity === null ? { quantity, provenance: 'unavailable', source: 'worker_report' } : { quantity, provenance: 'estimated', source: 'worker_report' };

const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);

const hostOf = (attempt: AttemptRow): WorkerHost => (attempt.detail?.['location'] === 'cloud' ? 'cloud' : 'local');

const TOKEN_FIELDS: Readonly<Record<TokenMetric, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>> = {
  input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_tokens: 'cacheReadTokens', cache_creation_tokens: 'cacheCreationTokens',
};

interface AttemptUsage {
  readonly scope: RunScope;
  readonly role: string;
  readonly attempt: AttemptRow;
  readonly now: Date;
}

function writer(tx: Tx, u: AttemptUsage) {
  const { attempt } = u;
  const base = { ...u.scope, taskId: attempt.taskId, revision: attempt.revision, attemptId: attempt.attemptId, role: u.role, recordedAt: u.now, detail: { attemptNumber: attempt.attemptNumber } };
  const metric = (m: UsageMetric, f: UsageFigures) => appendUsage(tx, { ...base, ...f, detail: { ...base.detail, ...f.detail }, metric: m, dedupeKey: `attempt:${attempt.attemptId}:${m}` });
  const time = (phase: WorkerPhase, f: UsageFigures) =>
    appendUsage(tx, { ...base, ...f, detail: base.detail, metric: 'worker_seconds', phase, host: hostOf(attempt), basis: 'measured', dedupeKey: `attempt:${attempt.attemptId}:worker_seconds:${phase}` });
  return { metric, time };
}

/**
 * Writes the attempt's ledger rows when its worker publishes. Tokens and cost come from the worker, so they are `estimated` or `unavailable`.
 * Elapsed time is the controller's own clock. A worker-reported split between phases only divides that time: it can never change the total.
 */
export async function recordAttemptUsage(tx: Tx, u: AttemptUsage, result: PublishResult): Promise<void> {
  const { metric, time } = writer(tx, u);
  const usage = result.reportedUsage ?? {};
  for (const m of TOKEN_METRICS) {
    const value = reported(usage[TOKEN_FIELDS[m]], MAX_REPORTED_TOKENS);
    await metric(m, selfReported(value === null ? null : String(Math.trunc(value))));
  }
  const cost = reported(result.reportedCostUsd, MAX_REPORTED_COST_USD);
  await metric('cost_usd', { ...selfReported(cost === null ? null : formatMicros(toMicros(cost))), ...(cost !== null && usage.costBasis ? { detail: { costBasis: usage.costBasis } } : {}) });

  if (u.attempt.startedAt === null) {
    await time('active', { quantity: null, provenance: 'unavailable', source: 'controller_clock' });
    return;
  }
  const totalMs = Math.max(0, u.now.getTime() - u.attempt.startedAt.getTime());
  const setupMs = (reported(usage.setupSeconds, Number.MAX_SAFE_INTEGER) ?? 0) * 1000;
  const idleMs = (reported(usage.idleSeconds, Number.MAX_SAFE_INTEGER) ?? 0) * 1000;
  const split = setupMs + idleMs > 0 && setupMs + idleMs <= totalMs;
  if (split && setupMs > 0) await time('setup', selfReported(seconds(setupMs)));
  if (split && idleMs > 0) await time('idle', selfReported(seconds(idleMs)));
  await time('active', split
    ? { quantity: seconds(totalMs - setupMs - idleMs), provenance: 'estimated', source: 'controller_clock' }
    : { quantity: seconds(totalMs), provenance: 'observed', source: 'controller_clock' });
}

/**
 * Writes the ledger rows of an attempt whose lease was reaped. The worker went silent, so its tokens and cost are unknown. Its instance
 * time is `estimated`: the controller saw the lease lapse, not the moment the instance actually stopped. It runs to the lease expiry as last
 * renewed or the attempt deadline, whichever came first, so a reaper that runs late cannot inflate it.
 */
export async function recordAbandonedAttempt(tx: Tx, u: AttemptUsage): Promise<void> {
  const { metric, time } = writer(tx, u);
  for (const m of [...TOKEN_METRICS, 'cost_usd'] as const) await metric(m, { quantity: null, provenance: 'unavailable', source: 'lease_reaper' });
  const stoppedAt = Math.min(...[u.now, u.attempt.leaseExpiresAt, u.attempt.deadlineAt].filter((d) => d !== null).map((d) => d.getTime()));
  await time('abandoned', u.attempt.startedAt === null
    ? { quantity: null, provenance: 'unavailable', source: 'lease_reaper' }
    : { quantity: seconds(stoppedAt - u.attempt.startedAt.getTime()), provenance: 'estimated', source: 'lease_reaper' });
}

const isOverrun = (p: BudgetPosition): boolean => p.limitMicros !== null && p.consumedMicros !== null && p.consumedMicros > p.limitMicros;

export interface ObservedCost extends RunScope {
  readonly attemptId: string;
  /** Exact decimal, from a provider response trusted code read directly. Never a worker's or harness's figure. */
  readonly costUsd: string;
  readonly operationId: string;
  /** Left out when the caller does not know it. The worker's own basis does not describe this figure. */
  readonly costBasis?: CostBasis | null;
  readonly rateCardVersion?: string | null;
}

export type ReconcileResult = { readonly reconciled: true; readonly amountUsd: string } | { readonly reconciled: false; readonly reason: 'reservation_not_settled' | 'no_ledger_entry' };

/**
 * Replaces an attempt's worst-case hold with a trusted observed cost, up or down, and corrects its ledger row. Only a `settled` reservation
 * qualifies: a running attempt can still spend, and a lost worker may have spent past what any bill shows yet, so an `expired` hold stays.
 * If the new figure puts the run over its limit, running attempts are asked to stop.
 */
export async function reconcileObservedCost(ctx: SchedulerContext, input: ObservedCost): Promise<ReconcileResult> {
  const { tenantId, projectId, runId, attemptId } = input;
  const scope: RunScope = { tenantId, projectId, runId };
  const reservationId = reservationIdFor(attemptId);
  const where = and(eq(schema.budgetReservations.tenantId, tenantId), eq(schema.budgetReservations.projectId, projectId), eq(schema.budgetReservations.reservationId, reservationId));
  const result = await withTx(ctx.db, async (tx): Promise<ReconcileResult> => {
    await lockBudget(tx, scope);
    const held = (await tx.select().from(schema.budgetReservations).where(where))[0];
    if (held?.state !== 'settled') return { reconciled: false, reason: 'reservation_not_settled' };
    const current = (await readUsageEntries(tx, scope)).find((e) => e.attemptId === attemptId && e.metric === 'cost_usd');
    if (!current) return { reconciled: false, reason: 'no_ledger_entry' };
    return recordOperation<ReconcileResult>(tx, { tenantId, projectId, key: `usage.reconcile:${attemptId}:${input.operationId}` }, async () => {
      const { costBasis: _workerBasis, ...kept } = current.detail;
      const figures: UsageFigures = { quantity: input.costUsd, provenance: 'observed', source: 'provider_response', rateCardVersion: input.rateCardVersion ?? null, detail: { ...kept, ...(input.costBasis ? { costBasis: input.costBasis } : {}) } };
      await correctUsage(tx, { tenantId, projectId, entryId: current.entryId }, `usage.reconcile:${attemptId}:${input.operationId}`, figures, ctx.now());
      const updated = await tx
        .update(schema.budgetReservations)
        .set({
          amountUsd: input.costUsd, amountProvenance: 'observed',
          // The first hold is kept; a second reconciliation must not overwrite it with the first bill.
          detail: sql`${schema.budgetReservations.detail} || jsonb_build_object('reservedUsd', coalesce(${schema.budgetReservations.detail} ->> 'reservedUsd', ${schema.budgetReservations.amountUsd}::text))`,
        })
        .where(where)
        .returning({ amountUsd: schema.budgetReservations.amountUsd });
      return { reconciled: true, amountUsd: updated[0]!.amountUsd! };
    });
  });
  if (result.reconciled) await stopForExhaustedBudget(ctx, scope);
  return result;
}

/**
 * Asks every running task of an overrun run to stop, through the existing cancel request: the runner sees it on its next heartbeat. Applies
 * only past the limit, because a budget merely used up by holds is what those running attempts were reserved against. Deletes and invalidates
 * nothing. Each task is handled in its own transaction, in the usual lock order (status row, then run row). Returns the tasks newly asked.
 *
 * `task.cancel_requested` is a human-only event, so this writes the command row without it. `task.cancelled` still records the end.
 */
export async function stopForExhaustedBudget(ctx: SchedulerContext, scope: RunScope): Promise<readonly string[]> {
  const running = await ctx.db
    .select({ taskId: schema.taskStatus.taskId })
    .from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
      eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
    ))
    .where(and(eq(schema.taskStatus.tenantId, scope.tenantId), eq(schema.taskStatus.projectId, scope.projectId), eq(schema.taskRevisions.runId, scope.runId), eq(schema.taskStatus.status, 'running')));

  const asked: string[] = [];
  for (const { taskId } of running) {
    const key: TaskKey = { tenantId: scope.tenantId, projectId: scope.projectId, taskId };
    const did = await withTx(ctx.db, async (tx) => {
      const statusRow = await lockStatusRow(tx, key);
      if (statusRow?.status !== 'running') return false;
      if (!isOverrun(await lockBudget(tx, scope))) return false;
      if (await hasCancelRequest(tx, key, statusRow.currentRevision)) return false;
      const open = await tx
        .select({ attemptId: schema.attempts.attemptId })
        .from(schema.attempts)
        .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, taskId), isNull(schema.attempts.endedAt)));
      await tx.insert(schema.taskCommands).values({
        tenantId: key.tenantId, projectId: key.projectId, operationId: `op_${randomUUID()}`, taskId, revision: statusRow.currentRevision,
        command: 'cancel', state: 'cancel_requested', requestedBy: 'budget_enforcer', requestedAt: ctx.now(),
        detail: { reason: 'budget_exhausted', attemptIds: open.map((a) => a.attemptId) },
      });
      return true;
    });
    if (did) asked.push(taskId);
  }
  return asked;
}

/** Same shape as the PR body's usage line. */
export interface RunUsageLine {
  readonly label: string;
  /** Exact decimal; null is printed as unavailable, never as zero. */
  readonly value: string | null;
  readonly unit: string;
  readonly provenance: UsageFigure['provenance'];
}

const TOKEN_LABELS: Readonly<Record<TokenMetric, string>> = { input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cache read', cache_creation_tokens: 'cache creation' };

const line = (label: string, f: UsageFigure, unit: string, value: string | null = f.value): RunUsageLine => ({ label: f.unavailableEntries > 0 && f.value !== null ? `${label} (${f.unavailableEntries} entries unavailable)` : label, value, unit, provenance: f.provenance });
const hours = (label: string, f: UsageFigure): RunUsageLine => line(label, f, 'hours', f.value === null ? null : (Number(f.value) / 3600).toFixed(4));

/** The run's usage for a PR body. Every total carries its provenance, and an empty ledger reads as unavailable rather than as nothing or zero. */
export async function runUsageLines(db: Executor, scope: RunScope): Promise<readonly RunUsageLine[]> {
  const s = await loadUsageSummary(db, scope);
  const lines: RunUsageLine[] = [];
  const roles = Object.keys(s.tokensByRole);
  if (roles.length === 0) lines.push(line('Tokens', { value: null, provenance: 'unavailable', unavailableEntries: 0 }, 'tokens'));
  for (const role of roles) for (const m of TOKEN_METRICS) lines.push(line(`Tokens (${role}, ${TOKEN_LABELS[m]})`, s.tokensByRole[role]![m], 'tokens'));
  const w = s.workerSeconds;
  const anyTime = w.total.measured.value !== null || w.total.measured.unavailableEntries > 0;
  if (!anyTime) lines.push(hours('Measured worker-hours', w.total.measured));
  else {
    for (const host of ['local', 'cloud'] as const) {
      const f = w.byHost[host].measured;
      if (f.value !== null || f.unavailableEntries > 0) lines.push(hours(`Measured worker-hours, ${host}`, f));
    }
    if (w.integrationSubtotal.value !== null) lines.push(hours('Measured worker-hours, of which integration (already in the host totals)', w.integrationSubtotal));
    if (w.verificationSubtotal.value !== null) lines.push(hours('Measured worker-hours, of which verification (already in the host totals)', w.verificationSubtotal));
  }
  lines.push(hours('Billed worker-hours', w.total.billed));
  lines.push(line(s.costBases.length > 0 ? `Cost (${s.costBases.join(', ')} basis)` : 'Cost', s.costUsd, 'USD'));
  return lines;
}
