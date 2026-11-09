import type { VerificationRecord } from '@selarikru/domain';
import { recordOperation, schema, sql, withTx, type Db, type Tx } from '@selarikru/persistence';
import { acceptanceCovers, assessRunScope, loadAcceptedReducedScope, type AcceptedReducedScope } from '@selarikru/workflow';
import { and, desc, eq } from 'drizzle-orm';
import { buildPrBody, type UsageLine } from './body.ts';
import { emitIntegration } from './events.ts';
import { PushRejectedError, type GitHubPort, type PullRequestInfo } from './port.ts';


export type PrRefusal = 'reduced_scope_not_accepted' | 'project_missing' | 'run_missing' | 'run_not_ready' | 'no_candidate' | 'no_valid_record' | 'record_not_passing' | 'branch_is_default' | 'unsafe_branch' | 'pr_not_open' | 'candidate_changed' | 'foreign_pr' | 'target_mismatch' | 'run_already_merged' | 'push_rejected';

export class PrNotAllowed extends Error {
  constructor(readonly reason: PrRefusal, message: string, /** Reason-specific facts, e.g. the open PR to close for `candidate_changed`. */ readonly detail: Readonly<Record<string, unknown>> = {}) {
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

/** The branch a candidate is pushed to: per run and per candidate, so a rebuilt candidate never moves or reuses an earlier PR's branch. */
export function branchForCandidate(runId: string, sha: string): string {
  return `selarikru/${runId}/${sha.slice(0, 12)}`;
}

type Reader = Db | Tx;

/** What the open depends on, read from `q`: the project and the run's current assembled candidate. `skip` for a trial run. */
async function readState(q: Reader, run: OpenPrRun, lock: boolean): Promise<{ skip: true } | { skip: false; project: typeof schema.projects.$inferSelect; sha: string; accepted: AcceptedReducedScope | null; notDelivered: AcceptedReducedScope['notDelivered'] }> {
  const runQuery = q.select().from(schema.runs).where(and(eq(schema.runs.tenantId, run.tenantId), eq(schema.runs.projectId, run.projectId), eq(schema.runs.runId, run.runId)));
  const row = (await (lock ? runQuery.for('no key update') : runQuery))[0];
  if (!row) throw new PrNotAllowed('run_missing', 'unknown run');
  const project = (await q.select().from(schema.projects).where(and(eq(schema.projects.tenantId, run.tenantId), eq(schema.projects.projectId, run.projectId))))[0];
  if (!project) throw new PrNotAllowed('project_missing', 'unknown project');
  if (row.trial) return { skip: true };
  if (row.lifecycle !== 'ready_for_review') throw new PrNotAllowed('run_not_ready', `run is ${row.lifecycle}, not ready_for_review`);
  // Work the budget stopped must be accepted by the owner before a review can present what is left as the run's result.
  const assessed = await assessRunScope(q, run);
  const stoppedIds = [...assessed.stopped.map((t) => t.taskId), ...assessed.stopping];
  const decision = stoppedIds.length > 0 ? await loadAcceptedReducedScope(q, run) : null;
  if (stoppedIds.length > 0 && (assessed.stopping.length > 0 || !acceptanceCovers(decision, assessed.stopped))) {
    throw new PrNotAllowed('reduced_scope_not_accepted', 'budget-stopped work has no accepted reduced-scope decision', { taskIds: stoppedIds });
  }
  const candidate = (await q.select().from(schema.candidates).where(and(
    eq(schema.candidates.tenantId, run.tenantId), eq(schema.candidates.projectId, run.projectId), eq(schema.candidates.runId, run.runId), eq(schema.candidates.status, 'assembled')))
    .orderBy(desc(schema.candidates.createdAt)))[0];
  if (!candidate?.sha) throw new PrNotAllowed('no_candidate', 'the run has no assembled candidate');
  if (candidate.target !== project.defaultBranch) throw new PrNotAllowed('target_mismatch', `the candidate was built for ${candidate.target}, not the default branch ${project.defaultBranch}`);
  return { skip: false, project, sha: candidate.sha, accepted: decision, notDelivered: assessed.notDelivered };
}

const MAX_ATTEMPTS = 3;

/**
 * Pushes the run's exact verified candidate to `selarikru/<runId>/<sha12>` and opens a DRAFT pull request into the project's default branch.
 *
 * - Needs a run in `ready_for_review`, an assembled candidate, and a live passing record for that candidate SHA (`loadRecord`).
 * - The repository and base branch come from the project row, never from the caller.
 * - The record is loaded before the transaction (the store takes a database handle, not `tx`). Then the run row is locked and the candidate and the
 *   run's recorded PR are read again under that lock; a candidate that moved meanwhile restarts the attempt, so concurrent opens for different
 *   candidates cannot both reach the push.
 * - One PR row per run. A different candidate while the recorded PR is `open` is refused (`candidate_changed`, naming the PR to close);
 *   after it is `closed` or `stale_candidate` the new candidate opens its own PR on its own branch and replaces the row; after a merge it is refused.
 * - Idempotent through `recordOperation`. If a create's response was lost, the retry queries the repository for a PR on the branch
 *   and adopts it only if it is ours. A completed operation replays its receipt without touching GitHub.
 * - A run flagged `trial` never reaches GitHub.
 */
export async function openReviewablePr(run: OpenPrRun, deps: OpenPrDeps): Promise<OpenPrResult> {
  const now = deps.now ?? (() => new Date());
  const { db, port } = deps;
  // The record is loaded before the transaction: the verifier's `loadValidRecord` takes a database handle, not a transaction, so loading it inside
  // would hold one pool connection while taking a second, which can wedge the pool under concurrent opens. Under the run lock the candidate is
  // read again; if it moved while the record was loading, the whole attempt starts over with the new candidate.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pre = await readState(db, run, false);
    if (pre.skip) return { status: 'skipped', reason: 'trial' };
    const record = await deps.loadRecord(pre.sha);
    if (!record || record.candidateSha !== pre.sha || record.runId !== run.runId) throw new PrNotAllowed('no_valid_record', 'no live verification record for the run candidate');
    if (record.result !== 'passed' || record.results.length === 0 || record.results.some((r) => r.status !== 'passed')) {
      throw new PrNotAllowed('record_not_passing', 'the verification record is not a full pass');
    }
    // Loaded before the transaction for the same reason as the record. The figures are descriptive, so reading them a moment early is harmless.
    const usage = deps.loadUsage ? await deps.loadUsage(run.runId) : [];
    const outcome = await openUnderLock(run, deps, now, port, pre.sha, record, usage);
    if (outcome !== 'retry') return outcome;
  }
  throw new PrNotAllowed('candidate_changed', 'the run candidate kept changing while the pull request was being opened');
}

async function openUnderLock(run: OpenPrRun, deps: OpenPrDeps, now: () => Date, port: GitHubPort, loadedSha: string, record: VerificationRecord, usage: readonly UsageLine[]): Promise<OpenPrResult | 'retry'> {
  return withTx(deps.db, async (tx): Promise<OpenPrResult | 'retry'> => {
    const state = await readState(tx, run, true);
    if (state.skip) return { status: 'skipped', reason: 'trial' };
    if (state.sha !== loadedSha) return 'retry';
    const { project, sha } = state;

    if (!SAFE_BRANCH.test(run.runId)) throw new PrNotAllowed('unsafe_branch', 'run id cannot form a branch name');
    const branch = branchForCandidate(run.runId, sha);
    if (branch === project.defaultBranch || project.defaultBranch === `refs/heads/${branch}`) throw new PrNotAllowed('branch_is_default', 'refusing to push to the default branch');
    const repository = project.repository;

    const prior = (await tx.select().from(schema.changeRequests).where(and(
      eq(schema.changeRequests.tenantId, run.tenantId), eq(schema.changeRequests.projectId, run.projectId), eq(schema.changeRequests.runId, run.runId))))[0];
    if (prior && prior.candidateSha !== sha) {
      if (prior.status === 'open') throw new PrNotAllowed('candidate_changed', `pull request #${prior.prNumber} is still open for candidate ${prior.candidateSha}; close it to open one for the rebuilt candidate`, { prNumber: prior.prNumber, url: prior.url, candidateSha: prior.candidateSha });
      if (prior.status !== 'closed' && prior.status !== 'stale_candidate') throw new PrNotAllowed('run_already_merged', `pull request #${prior.prNumber} for this run is ${prior.status}`, { prNumber: prior.prNumber });
    }

    const granted = await tx.select({ taskId: schema.approvals.taskId, approver: schema.approvals.approver, detail: schema.approvals.detail }).from(schema.approvals).where(and(
      eq(schema.approvals.tenantId, run.tenantId), eq(schema.approvals.projectId, run.projectId), eq(schema.approvals.runId, run.runId), eq(schema.approvals.outcome, 'granted'))).orderBy(schema.approvals.createdAt, schema.approvals.approvalId);
    const grants = granted.flatMap((a) => (typeof a.detail['operation'] === 'string' ? [{ operation: a.detail['operation'], taskId: a.taskId, approver: a.approver }] : []));
    const body = buildPrBody({ runId: run.runId, candidateSha: sha, baseSha: record.baseSha, record, limitations: deps.limitations ?? [], usage, grants, ...(state.accepted ? { notDelivered: state.notDelivered } : {}) });
    const title = `SelariKru: ${run.runId} (candidate ${sha.slice(0, 12)})`;

    const result = await recordOperation<Extract<OpenPrResult, { status: 'opened' }>>(tx, { tenantId: run.tenantId, projectId: run.projectId, key: `github.pr:${run.runId}:${sha}` }, async () => {
      // Pushing the same commit again is a no-op, so this is safe on every retry. Never forced.
      try {
        await port.pushBranch({ repository, repoPath: run.repoPath, sha, branch });
      } catch (e) {
        if (e instanceof PushRejectedError) throw new PrNotAllowed('push_rejected', `the remote branch ${branch} already holds other commits`);
        throw e;
      }
      // Query before creating: a previous attempt may have created the PR and lost the response.
      const found = await port.findPullRequests(repository, branch);
      let pr: PullRequestInfo;
      let adopted = false;
      if (found.length > 0) {
        const open = found.filter((f) => f.state === 'open');
        if (open.length === 0) throw new PrNotAllowed('pr_not_open', `the pull request on ${branch} is ${found[0]!.state}`);
        // Adopt only our own PR: same repository, exactly the candidate at its head, into the project's default branch.
        const ours = open.find((f) => !f.isCrossRepository && f.headSha === sha && f.baseRef === project.defaultBranch);
        if (!ours) throw new PrNotAllowed('foreign_pr', `a pull request on ${branch} is not the one opened for this candidate`);
        pr = ours;
        adopted = true;
      } else {
        pr = await port.createDraftPullRequest({ repository, branch, base: project.defaultBranch, title, body });
      }
      // Inserts the row, or replaces a closed or stale one that belonged to a different candidate (guarded above).
      await tx.execute(sql`
        INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, base_ref, pr_number, url, status, observed_head_sha, merge_commit_sha, observed_at)
        VALUES (${run.tenantId}, ${run.projectId}, ${run.runId}, ${repository}, ${sha}, ${branch}, ${project.defaultBranch}, ${pr.number}, ${pr.url}, 'open', ${pr.headSha || null}, NULL, ${now().toISOString()}::timestamptz)
        ON CONFLICT (tenant_id, project_id, run_id) DO UPDATE SET
          repository = EXCLUDED.repository, candidate_sha = EXCLUDED.candidate_sha, branch = EXCLUDED.branch, base_ref = EXCLUDED.base_ref, pr_number = EXCLUDED.pr_number,
          url = EXCLUDED.url, status = 'open', observed_head_sha = EXCLUDED.observed_head_sha, merge_commit_sha = NULL, observed_at = EXCLUDED.observed_at
          WHERE change_requests.candidate_sha <> EXCLUDED.candidate_sha`);
      await emitIntegration(tx, { projectId: run.projectId, runId: run.runId }, now(), 'change.proposed', { prNumber: pr.number, url: pr.url, branch, candidateSha: sha, draft: true, adopted });
      return { status: 'opened' as const, number: pr.number, url: pr.url, branch, candidateSha: sha, adopted };
    });
    // A receipt from an earlier open of this same candidate must still describe the run's current PR.
    const current = (await tx.select().from(schema.changeRequests).where(and(
      eq(schema.changeRequests.tenantId, run.tenantId), eq(schema.changeRequests.projectId, run.projectId), eq(schema.changeRequests.runId, run.runId))))[0];
    if (!current || current.candidateSha !== sha) throw new PrNotAllowed('candidate_changed', 'the run now has a pull request for another candidate', { prNumber: current?.prNumber ?? null });
    return result;
  });
}
