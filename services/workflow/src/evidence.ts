import { deriveRunEvidence, type CheckStatus, type CriterionObservation, type EvidenceTask } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import type { Executor } from '@selarikru/persistence';

const STATUSES: readonly string[] = ['passed', 'failed', 'skipped', 'error'];
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export interface RunEvidence {
  readonly criteria: { readonly verified: number; readonly total: number };
  readonly evidence: {
    readonly candidate: {
      readonly sha: string; readonly status: string; readonly live: boolean; readonly baseSha: string; readonly treeSha: string | null; readonly target: string; readonly recordedAt: string;
      readonly recordId: string | null; readonly verifierHost: string | null; readonly checkManifestSha256: string | null; readonly verifierSha256: string | null; readonly flaky: readonly string[];
    } | null;
    readonly criteria: ReturnType<typeof deriveRunEvidence> extends infer R ? R extends { criteria: infer C } ? C : never : never;
  };
}

/**
 * Per-requirement evidence for one run: the requirement ids of its current tasks, judged against the run's latest candidate. The data is the verifier's own `check_runs`, one
 * row per FB-ID. Only a candidate still `assembled` can verify anything; a rejected one is shown for what it said, and an invalidated one is not read at all.
 * Null when no task names a requirement: criteria are then unknown, and a task count must never stand in for them.
 */
export async function loadRunEvidence(db: Executor, scope: { readonly tenantId: string; readonly projectId: string; readonly runId: string }, tasks: readonly EvidenceTask[]): Promise<RunEvidence | null> {
  const { tenantId, projectId, runId } = scope;
  const candidates = await db.execute(sql`
    SELECT sha, status, base_sha, tree_sha, target, updated_at FROM candidates
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND sha IS NOT NULL AND status IN ('assembled', 'rejected')
    ORDER BY created_at DESC, candidate_id DESC LIMIT 1`);
  const row = candidates[0];
  const sha = row ? String(row['sha']) : null;
  const observations: CriterionObservation[] = [];
  if (sha !== null) {
    const rows = await db.execute(sql`
      SELECT check_run_id, check_id, check_version, task_id, revision, attempt_id, candidate_sha, result, log_refs, created_at FROM check_runs
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND candidate_sha = ${sha} AND result <> 'invalidated'`);
    for (const r of rows) {
      if (!STATUSES.includes(String(r['result']))) continue;
      const ref = (Array.isArray(r['log_refs']) ? r['log_refs'][0] : null) as { recordId?: unknown; attempt?: unknown } | null;
      observations.push({
        checkRunId: String(r['check_run_id']), checkId: String(r['check_id']), checkVersion: String(r['check_version']), taskId: String(r['task_id']), revision: Number(r['revision']),
        attemptId: str(r['attempt_id']), recordId: str(ref?.recordId), verificationAttempt: typeof ref?.attempt === 'number' ? ref.attempt : 1, candidateSha: String(r['candidate_sha']), result: r['result'] as CheckStatus, at: iso(r['created_at']),
      });
    }
  }
  const derived = deriveRunEvidence({ tasks, observations, candidateSha: sha, candidateLive: row?.['status'] === 'assembled' });
  if (derived === null) return null;
  let verdict: Record<string, unknown> = {};
  if (sha !== null) {
    const events = await db.execute(sql`
      SELECT payload FROM events WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND type IN ('verification.passed', 'verification.failed') AND payload ->> 'candidateSha' = ${sha}
      ORDER BY sequence DESC LIMIT 1`);
    verdict = (events[0]?.['payload'] as Record<string, unknown> | undefined) ?? {};
  }
  return {
    criteria: { verified: derived.verified, total: derived.total },
    evidence: {
      candidate: row && sha !== null ? {
        sha, status: String(row['status']), live: row['status'] === 'assembled', baseSha: String(row['base_sha']), treeSha: str(row['tree_sha']), target: String(row['target']), recordedAt: iso(row['updated_at']),
        recordId: str(verdict['recordId']), verifierHost: str(verdict['host']), checkManifestSha256: str(verdict['checkManifestSha256']), verifierSha256: str(verdict['verifierSha256']),
        flaky: Array.isArray(verdict['flaky']) ? (verdict['flaky'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      } : null,
      criteria: derived.criteria,
    },
  };
}
