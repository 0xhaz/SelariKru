import type { VerificationRecord } from '@selarikru/domain';
import { recordOperation, schema, sql, withTx, type Db } from '@selarikru/persistence';
import { and, desc, eq } from 'drizzle-orm';
import { buildPrBody, type UsageLine } from './body.ts';
import { emitIntegration } from './events.ts';
import type { GitHubPort, PullRequestInfo } from './port.ts';


export type PrRefusal = 'project_missing' | 'run_missing' | 'run_not_ready' | 'no_candidate' | 'no_valid_record' | 'record_not_passing' | 'branch_is_default' | 'unsafe_branch' | 'pr_not_open';

export class PrNotAllowed extends Error {
  constructor(readonly reason: PrRefusal, message: string) {
    super(message);
    this.name = 'PrNotAllowed';
  }
}

export interface OpenPrRun {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  /** Local source repository holding the candidate commit (`refs/selarikru/candidates/<sha>`). */
  readonly repoPath: string;
}

export interface OpenPrDeps {
  readonly db: Db;
  readonly port: GitHubPort;
  /** The authoritative live record for a candidate SHA. Wire this to the verifier's `loadValidRecord`; null means no live evidence. */
  readonly loadRecord: (sha: string) => Promise<VerificationRecord | null>;
  /** Recorded usage for the run, with provenance. Absent: the body says no usage was recorded. */
  readonly loadUsage?: (runId: string) => Promise<readonly UsageLine[]>;
  /** Recorded limitations beyond those derived from the verification record. */
  readonly limitations?: readonly string[];
  readonly now?: () => Date;
}

export type OpenPrResult =
  | { readonly status: 'skipped'; readonly reason: 'trial' }
  | { readonly status: 'opened'; readonly number: number; readonly url: string; readonly branch: string; readonly candidateSha: string; readonly adopted: boolean };

const SAFE_BRANCH = /^[A-Za-z0-9._-]{1,100}$/;

/** The branch a run's candidate is pushed to. Derived from the run id only. */
export function branchForRun(runId: string): string {
  return `selarikru/${runId}`;
}

/**
 * Pushes the run's exact verified candidate to `selarikru/<runId>` and opens a DRAFT pull request into the project's default branch.
 *
 * - Needs a run in `ready_for_review`, an assembled candidate, and a live passing record for that candidate SHA (`loadRecord`).
 * - The repository and base branch come from the project row, never from the caller.
 * - Idempotent through `recordOperation`. If a create's response was lost, the retry queries the repository for a PR on the branch
 *   and adopts it, so there is never a duplicate. A completed operation replays its receipt without touching GitHub.
 * - A run flagged `trial` never reaches GitHub.
 */
export async function openReviewablePr(run: OpenPrRun, deps: OpenPrDeps): Promise<OpenPrResult> {
  const now = deps.now ?? (() => new Date());
  const { db, port } = deps;
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.tenantId, run.tenantId), eq(schema.projects.projectId, run.projectId)));
  const project = projects[0];
  if (!project) throw new PrNotAllowed('project_missing', 'unknown project');
  const runs = await db.select().from(schema.runs).where(and(eq(schema.runs.tenantId, run.tenantId), eq(schema.runs.projectId, run.projectId), eq(schema.runs.runId, run.runId)));
  const row = runs[0];
  if (!row) throw new PrNotAllowed('run_missing', 'unknown run');
  if (row.trial) return { status: 'skipped', reason: 'trial' };
  if (row.lifecycle !== 'ready_for_review') throw new PrNotAllowed('run_not_ready', `run is ${row.lifecycle}, not ready_for_review`);

  const cands = await db.select().from(schema.candidates).where(and(
    eq(schema.candidates.tenantId, run.tenantId), eq(schema.candidates.projectId, run.projectId), eq(schema.candidates.runId, run.runId), eq(schema.candidates.status, 'assembled')))
    .orderBy(desc(schema.candidates.createdAt));
  const candidate = cands[0];
  if (!candidate?.sha) throw new PrNotAllowed('no_candidate', 'the run has no assembled candidate');
  const sha = candidate.sha;

  const record = await deps.loadRecord(sha);
  if (!record || record.candidateSha !== sha || record.runId !== run.runId) throw new PrNotAllowed('no_valid_record', 'no live verification record for the run candidate');
  if (record.result !== 'passed' || record.results.length === 0 || record.results.some((r) => r.status !== 'passed')) {
    throw new PrNotAllowed('record_not_passing', 'the verification record is not a full pass');
  }

  const branch = branchForRun(run.runId);
  if (!SAFE_BRANCH.test(run.runId)) throw new PrNotAllowed('unsafe_branch', 'run id cannot form a branch name');
  if (branch === project.defaultBranch || project.defaultBranch === `refs/heads/${branch}`) throw new PrNotAllowed('branch_is_default', 'refusing to push to the default branch');
  const repository = project.repository;

  const usage = deps.loadUsage ? await deps.loadUsage(run.runId) : [];
  const body = buildPrBody({ runId: run.runId, candidateSha: sha, baseSha: record.baseSha, record, limitations: deps.limitations ?? [], usage });
  const title = `SelariKru: ${run.runId} (candidate ${sha.slice(0, 12)})`;

  return withTx(db, (tx) =>
    recordOperation<Extract<OpenPrResult, { status: 'opened' }>>(tx, { tenantId: run.tenantId, projectId: run.projectId, key: `github.pr:${run.runId}:${sha}` }, async () => {
      // Pushing the same commit again is a no-op, so this is safe on every retry. Never forced.
      await port.pushBranch({ repository, repoPath: run.repoPath, sha, branch });
      // Query before creating: a previous attempt may have created the PR and lost the response.
      const existing = await port.findPullRequest(repository, branch);
      let pr: PullRequestInfo;
      let adopted = false;
      if (existing) {
        if (existing.state !== 'open') throw new PrNotAllowed('pr_not_open', `the pull request on ${branch} is ${existing.state}`);
        pr = existing;
        adopted = true;
      } else {
        pr = await port.createDraftPullRequest({ repository, branch, base: project.defaultBranch, title, body });
      }
      await tx.execute(sql`
        INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, pr_number, url, status, observed_head_sha, observed_at)
        VALUES (${run.tenantId}, ${run.projectId}, ${run.runId}, ${repository}, ${sha}, ${branch}, ${pr.number}, ${pr.url}, 'open', ${pr.headSha || null}, ${now().toISOString()}::timestamptz)
        ON CONFLICT (tenant_id, project_id, run_id) DO NOTHING`);
      await emitIntegration(tx, { projectId: run.projectId, runId: run.runId }, now(), 'change.proposed', { prNumber: pr.number, url: pr.url, branch, candidateSha: sha, draft: true, adopted });
      return { status: 'opened' as const, number: pr.number, url: pr.url, branch, candidateSha: sha, adopted };
    }),
  );
}
