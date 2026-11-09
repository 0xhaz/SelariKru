import { VerificationRecordSchema, type VerificationRecord } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import type { Executor } from '@selarikru/persistence';

/** What the trusted verifier is right now. A record made under different hashes is no longer evidence. */
export interface TrustedVerifier { readonly checkManifestSha256: string; readonly verifierSha256: string }

/** Read access to the content-addressed store that holds record bytes. */
export interface RecordBytes { get(sha256: string): Promise<Uint8Array | null> }

/** The bar a record must meet right now. */
export interface RecordBar { readonly trusted: TrustedVerifier; readonly artifacts: RecordBytes }

export interface LatestAppliedRecord {
  readonly recordId: string;
  readonly sha256: string;
  readonly checkRunIds: readonly string[];
  /** Every one of its check runs is still live. Assembling or re-verifying invalidates them, and a record with none is not live either. */
  readonly live: boolean;
}

/**
 * The authoritative record of a candidate SHA: the latest one applied to task state. A later `error` or `skipped` record is history and never shadows it. `runId` narrows a
 * report to one run; the pull-request route compares the record's own run id instead.
 */
export async function loadLatestAppliedRecord(db: Executor, key: { readonly tenantId: string; readonly projectId: string; readonly sha: string; readonly runId?: string }): Promise<LatestAppliedRecord | null> {
  const rows = await db.execute(sql`
    SELECT a.artifact_id, a.sha256, a.locator,
      (SELECT count(*)::int FROM check_runs r WHERE r.tenant_id = a.tenant_id AND r.project_id = a.project_id AND r.candidate_sha = a.source_revision AND r.result <> 'invalidated' AND jsonb_exists(a.locator -> 'checkRunIds', r.check_run_id)) AS live
    FROM artifacts a WHERE a.tenant_id = ${key.tenantId} AND a.project_id = ${key.projectId} AND a.type = 'verification_record' AND a.source_revision = ${key.sha} AND a.locator ->> 'applied' = 'true'
      ${key.runId !== undefined ? sql`AND a.run_id = ${key.runId}` : sql``}
    ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const ids = (row['locator'] as { checkRunIds?: unknown }).checkRunIds;
  const checkRunIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  return { recordId: String(row['artifact_id']), sha256: String(row['sha256']), checkRunIds, live: checkRunIds.length > 0 && Number(row['live']) === checkRunIds.length };
}

/**
 * The one bar: a record counts only while it is live, its bytes are still in the store and intact, and it names this candidate under the current trusted hashes. Anything else
 * is null, so a wiped or corrupt store reads the same everywhere: not valid.
 */
export async function validRecordOf(latest: LatestAppliedRecord | null, sha: string, bar: { readonly artifacts: RecordBytes; readonly trusted: () => TrustedVerifier }): Promise<VerificationRecord | null> {
  if (!latest?.live) return null;
  const bytes = await bar.artifacts.get(latest.sha256).catch(() => null);
  if (!bytes) return null;
  const parsed = (() => { try { return VerificationRecordSchema.safeParse(JSON.parse(Buffer.from(bytes).toString())); } catch { return null; } })();
  if (!parsed?.success) return null;
  const record = parsed.data;
  const trusted = bar.trusted();
  return record.candidateSha === sha && record.checkManifestSha256 === trusted.checkManifestSha256 && record.verifierSha256 === trusted.verifierSha256 ? record : null;
}
