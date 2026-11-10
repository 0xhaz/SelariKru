import type { ArtifactStore } from '@selarikru/artifacts';
import { FEEDBACK_CRITERIA } from '@selarikru/view-protocol';
import { sql, type Db } from '@selarikru/persistence';
import { loadValidRecord } from '../../../../services/verifier/src/service.ts';
import type { RawRecord } from '../report.ts';

/**
 * Reads what one trial's product stack recorded: its events, attempts, usage ledger, candidate and verification record.
 * Every interval is a difference of two times the same server clock stamped (the trial's monotonic clock), taken in
 * event order; if that order ever disagrees with the times, the intervals are withheld rather than guessed.
 */

export interface TrialEvidence {
  readonly acceptedAt: number | null;
  readonly verdict: { readonly at: number; readonly outcome: 'passed' | 'failed' } | null;
  readonly timings: Pick<RawRecord['timings'], 'endToEndVerifiedMs' | 'queueMs' | 'startupMs' | 'implementationMs' | 'integrationMs' | 'verificationMs'>;
  /** False when event order and event times disagree: the timings above are then all null. */
  readonly clockConsistent: boolean;
  readonly attempts: readonly AttemptRow[];
  readonly candidateSha: string | null;
  readonly criteria: RawRecord['quality']['criteria'];
  readonly usage: RawRecord['resources']['providerUsageByRole'];
  readonly usageCoverage: RawRecord['resources']['usageCoverage'];
  readonly workerHours: { readonly local: number | null; readonly cloud: number | null; readonly integrationAndVerification: number | null; readonly provenance: 'observed' | 'estimated' | 'unavailable' };
  readonly cost: { readonly actual: number | null; readonly estimated: number | null; readonly rateCardVersion: string | null };
  readonly taskStatuses: readonly { readonly taskId: string; readonly status: string; readonly blockedReason: string | null }[];
  readonly deniedActions: number;
  readonly humanIntervened: boolean;
  readonly approvalsRaised: number;
  /** What the trial can have spent at most: each started attempt's reported cost, or its worst-case hold when none was reported. Null when neither is known for some attempt. */
  readonly spendBoundUsd: number | null;
  /** Started attempts with no reported cost. */
  readonly unreportedAttempts: number;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly taskId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly setupCompletedAt: number | null;
  readonly outcome: string | null;
  readonly exitReason: string | null;
  /** Where the attempt's model calls went, as recorded at claim: `device`, `cloud` or `unknown`. */
  readonly modelRoute: string | null;
}

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const between = (from: number | null | undefined, to: number | null | undefined): number | null =>
  from === null || from === undefined || to === null || to === undefined || to < from ? null : to - from;

interface EventRow { readonly sequence: number; readonly type: string; readonly at: number; readonly taskId: string; readonly payload: Record<string, unknown> }

export async function collectTrial(db: Db, artifacts: ArtifactStore, scope: { tenantId: string; projectId: string; runId: string }): Promise<TrialEvidence> {
  const { tenantId, projectId, runId } = scope;
  const events: EventRow[] = (await db.execute(sql`SELECT sequence, type, occurred_at, task_id, payload FROM events WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} ORDER BY sequence`))
    .map((r) => ({ sequence: Number(r['sequence']), type: String(r['type']), at: ms(r['occurred_at'])!, taskId: String(r['task_id']), payload: (r['payload'] ?? {}) as Record<string, unknown> }));
  const clockConsistent = events.every((e, i) => i === 0 || e.at >= events[i - 1]!.at);
  const first = (type: string) => events.find((e) => e.type === type)?.at ?? null;
  const last = (type: string) => events.filter((e) => e.type === type).at(-1)?.at ?? null;

  const attempts: AttemptRow[] = (await db.execute(sql`SELECT attempt_id, task_id, started_at, ended_at, outcome, exit_reason, detail, model_route FROM attempts WHERE tenant_id = ${tenantId} AND project_id = ${projectId} ORDER BY started_at NULLS LAST, attempt_id`))
    .map((r) => ({
      attemptId: String(r['attempt_id']), taskId: String(r['task_id']), startedAt: ms(r['started_at']), endedAt: ms(r['ended_at']),
      setupCompletedAt: ms((r['detail'] as { setupCompletedAt?: unknown } | null)?.setupCompletedAt), outcome: (r['outcome'] as string | null) ?? null, exitReason: (r['exit_reason'] as string | null) ?? null, modelRoute: (r['model_route'] as string | null) ?? null,
    }));

  const acceptedAt = first('plan.accepted');
  const verdictEvent = events.filter((e) => e.type === 'verification.passed' || e.type === 'verification.failed').at(-1) ?? null;
  const verdict = verdictEvent ? { at: verdictEvent.at, outcome: verdictEvent.type === 'verification.passed' ? 'passed' as const : 'failed' as const } : null;
  const firstStart = first('attempt.started');
  const firstAttempt = attempts.find((a) => a.startedAt !== null) ?? null;
  const active = attempts.map((a) => between(a.setupCompletedAt, a.endedAt)).filter((x): x is number => x !== null);
  const timings = clockConsistent ? {
    endToEndVerifiedMs: verdict ? between(acceptedAt, verdict.at) : null,
    queueMs: between(acceptedAt, firstStart),
    // The server's own mark: setup is done when the runner's acknowledged setup-complete landed (the runner launches no worker before it).
    startupMs: firstAttempt ? between(firstAttempt.startedAt, firstAttempt.setupCompletedAt) : null,
    implementationMs: active.length > 0 ? active.reduce((a, b) => a + b, 0) : null,
    integrationMs: between(last('attempt.completed'), first('candidate.assembled')),
    verificationMs: verdict ? between(events.filter((e) => e.type === 'verification.started' && e.at <= verdict.at).at(-1)?.at, verdict.at) : null,
  } : { endToEndVerifiedMs: null, queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null };

  const [candidate] = await db.execute(sql`SELECT sha FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND sha IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  const candidateSha = candidate ? String(candidate['sha']) : null;
  const record = candidateSha ? await loadValidRecord(db, artifacts, { tenantId, projectId, sha: candidateSha }).catch(() => null) : null;
  const criteria = FEEDBACK_CRITERIA.map((id) => {
    const r = record?.results.find((x) => x.checkId === id);
    const status = r === undefined ? 'not_run' as const : r.status;
    return { id, status, evidenceReferences: status === 'passed' && candidateSha ? [`#/evidence?run=${encodeURIComponent(runId)}&candidate=${candidateSha}&check=${id}`] : [] };
  });

  const usageRows = await db.execute(sql`SELECT role, metric, quantity, provenance, source, host, rate_card_version, attempt_id FROM usage_entries WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND corrects_entry_id IS NULL`);
  const roles = [...new Set(usageRows.filter((r) => r['metric'] !== 'worker_seconds' && r['metric'] !== 'cost_usd').map((r) => String(r['role'])))];
  const usage = roles.map((role) => {
    const of = (metric: string) => usageRows.filter((r) => r['role'] === role && r['metric'] === metric);
    const total = (metric: string): number | null => { const rows = of(metric); return rows.length === 0 || rows.some((r) => r['quantity'] === null) ? null : rows.reduce((a, r) => a + Number(r['quantity']), 0); };
    const tokenRows = [...of('input_tokens'), ...of('output_tokens')];
    const known = tokenRows.length > 0 && tokenRows.every((r) => r['quantity'] !== null);
    const cache = [total('cache_read_tokens'), total('cache_creation_tokens')];
    return {
      role, inputTokens: known ? total('input_tokens') : null, outputTokens: known ? total('output_tokens') : null, cacheTokens: known && cache.every((c) => c !== null) ? cache[0]! + cache[1]! : null,
      provenance: !known ? 'unavailable' as const : tokenRows.every((r) => r['provenance'] === 'observed') ? 'observed' as const : 'estimated' as const,
      source: known ? [...new Set(tokenRows.map((r) => String(r['source'])))].join('+') : null,
    };
  });
  const usageCoverage = usage.length === 0 ? 'none' as const : usage.every((u) => u.provenance !== 'unavailable') ? 'complete' as const : usage.some((u) => u.provenance !== 'unavailable') ? 'partial' as const : 'none' as const;

  const seconds = usageRows.filter((r) => r['metric'] === 'worker_seconds');
  const hours = (pick: (r: Record<string, unknown>) => boolean): number | null => {
    const rows = seconds.filter(pick);
    return rows.length === 0 || rows.some((r) => r['quantity'] === null) ? null : rows.reduce((a, r) => a + Number(r['quantity']), 0) / 3600;
  };
  const coding = (r: Record<string, unknown>) => r['role'] !== 'integration' && r['role'] !== 'verification';
  const local = hours((r) => r['host'] === 'local');
  const cloud = seconds.some((r) => r['host'] === 'cloud') ? hours((r) => r['host'] === 'cloud') : null;
  const integration = seconds.some((r) => !coding(r)) ? hours((r) => !coding(r)) : null;
  const known = seconds.filter((r) => r['quantity'] !== null);
  const workerHours = {
    local, cloud, integrationAndVerification: integration,
    provenance: local === null && cloud === null ? 'unavailable' as const : known.every((r) => r['provenance'] === 'observed') ? 'observed' as const : 'estimated' as const,
  };

  const costRows = usageRows.filter((r) => r['metric'] === 'cost_usd');
  const costSum = (prov: string): number | null => {
    const rows = costRows.filter((r) => r['provenance'] === prov);
    return rows.length === 0 ? null : rows.reduce((a, r) => a + Number(r['quantity']), 0);
  };
  const unknownCost = costRows.length === 0 || costRows.some((r) => r['quantity'] === null);
  const cost = {
    actual: unknownCost ? null : costSum('observed'),
    estimated: unknownCost ? null : costSum('estimated'),
    rateCardVersion: (costRows.find((r) => r['rate_card_version'] !== null)?.['rate_card_version'] as string | undefined) ?? null,
  };

  const blockedReason = (taskId: string): string | null => {
    const e = events.filter((x) => x.type === 'task.blocked' && x.taskId === taskId).at(-1);
    return typeof e?.payload['reason'] === 'string' ? e.payload['reason'] : null;
  };
  const taskStatuses = (await db.execute(sql`SELECT task_id, status FROM task_status WHERE tenant_id = ${tenantId} AND project_id = ${projectId} ORDER BY task_id`))
    .map((r) => ({ taskId: String(r['task_id']), status: String(r['status']), blockedReason: blockedReason(String(r['task_id'])) }));
  const deniedActions = events.filter((e) => e.type === 'approval.denied').length;
  const holds = await db.execute(sql`SELECT amount_usd, detail FROM budget_reservations WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId}`);
  let spendBoundUsd: number | null = 0;
  let unreportedAttempts = 0;
  for (const a of attempts.filter((x) => x.startedAt !== null)) {
    const reportedCost = costRows.find((r) => r['attempt_id'] === a.attemptId && r['quantity'] !== null);
    if (reportedCost) { spendBoundUsd = spendBoundUsd === null ? null : spendBoundUsd + Number(reportedCost['quantity']); continue; }
    unreportedAttempts += 1;
    const hold = holds.find((h) => (h['detail'] as { attemptId?: unknown } | null)?.attemptId === a.attemptId && h['amount_usd'] !== null);
    spendBoundUsd = hold && spendBoundUsd !== null ? spendBoundUsd + Number(hold['amount_usd']) : null;
  }
  return {
    acceptedAt, verdict, timings, clockConsistent, attempts, candidateSha, criteria, usage, usageCoverage, workerHours, cost, taskStatuses, deniedActions,
    humanIntervened: events.some((e) => e.type === 'attempt.human_intervened'),
    approvalsRaised: events.filter((e) => e.type === 'approval.requested').length,
    spendBoundUsd, unreportedAttempts,
  };
}
