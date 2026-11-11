import { TaskSpecSchema, transition, type Actor, type TaskState, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Db, type Tx } from '@selarikru/persistence';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { emit, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';
import type { TrustedVerifier } from './verification-record.ts';

export type VerificationVerdict = 'passed' | 'failed' | 'error' | 'skipped';

export interface VerificationApplication {
  /** True when the task changed state. False for a non-verdict (`error`, `skipped`) and for a task that is no longer `verifying`. */
  readonly applied: boolean;
  readonly taskStatus: string;
  readonly reason: string;
  readonly repair?: 'scheduled' | 'refused';
}

type ClaimScope = { readonly tenantId: string; readonly projectId: string };

/**
 * Serialises every change to a project's live claim rows made on behalf of a run's parts: a release that may hand a row to another part, and taking a row back. Row locks cannot do
 * this alone, because a part with no row yet has nothing to lock and would miss a row that is being handed to it.
 *
 * Lock order, across a whole transaction: candidate row, scheduler lock, run row (`runs`, which `lockBudget` takes), task status rows (ascending task id when there are several), this
 * lock, then `resource_claims` rows and the project's event sequence. Holding this lock, nothing waits for a status row or the scheduler lock, and a transaction that writes for several
 * parts takes it before its first event. The scheduler lock could not serve here: claiming takes it before status rows, and every caller of `releaseTaskClaims` already holds one.
 *
 * Who follows it. The verifier's verdict (`lockForVerdict` in services/verifier): candidate, run row, its parts' status rows, this lock, event sequence. An owner re-verify:
 * candidate, scheduler lock, run row, status rows, this lock (`lockBeforeRunRow`, `reverifyRun`). An owner replan: candidate if stale, scheduler lock, run row, the named tasks'
 * status rows, then the event sequence; a run in review leaves it there, on the run row it already holds (`leaveReviewForPlan`). A cancel: candidate and scheduler lock if
 * stale, the task's status row, this lock; only a stale exit takes the run row, last (below).
 *
 * The owner's settings and run controls (apps/control-api/src/settings.ts), each a path that takes the scheduler lock first:
 * - a run setting save: scheduler lock, run row (`lockBudget` re-takes it for a resume), the setting row, the runner config row, the run's status rows in task
 *   order (only for a narrowed or widened path or cloud grant, `requestPolicyStop` and `placement.cleared` included), then the event sequence. A worker setting save: scheduler lock,
 *   the setting row, the runner config row, the event sequence. A budget lowered below what is committed is stopped after the commit, by `stopForExhaustedBudget`.
 * - a task setting save (the route policy override, `route_override`): scheduler lock, the task's run row, the `task_settings` row, then the event sequence. The task's
 *   spec, its labels (project, spec, Brain sources) and the run default are read without a lock after the scheduler lock, and no status row is taken: a route policy
 *   is metadata the server serves to the browser adapter, so nothing queued or running changes. A run's default (`route_policy`) is a run setting save as above.
 * - a browser's route record (`POST /v1/tasks/:id/client-reports`, kind `route`): no scheduler lock and no run row. Its `operation_receipts` row first (the replay
 *   check), then the task's status row shared (`FOR SHARE`, so the revision the event carries cannot move under it), then it reads the task's route without a lock,
 *   inserts its `client_reports` row and appends to the event sequence last (`inference.reported`, the owner as actor). A replay inserts and appends nothing.
 * - a run cancel, and finishing one (`finishCancelledRuns`): scheduler lock, run row, the run's open tasks' status rows in task order, this lock, the event
 *   sequence, then the run's approval and reservation rows.
 * - a model assignment: its own advisory lock, the runner config row, the event sequence.
 * - a runner's config acknowledgement (`acknowledgeRunnerConfig`) and the periodic settle (`settlePendingSettings`): the runner row (acknowledgement only),
 *   then this runner's waiting `runner_settings` rows ordered by field, the waiting `run_settings` rows ordered by project, run and field, the waiting
 *   `model_assignments` rows ordered by project, scope kind, scope key and revision, every one locked before the first event, then the event sequence. Two
 *   of them lock in the same order, so they wait rather than cross. They take no scheduler lock, run row or status row. The claim poll reads settings rows
 *   after the scheduler lock without locking them, so a save is either committed before the claim's reads or waits for the claim to finish.
 * - the Project Brain (apps/control-api/src/brain.ts): every write takes the project's `brain_heads` row and nothing else, with no other lock held. A compile runs
 *   on change, never inside another path's transaction: an owner's note, revocation or kept conflict and a runner's manifest compile in their own transaction; a plan
 *   accepted, an approval resolved, reduced scope accepted, a reclassification decided or a project activated compile after that request's transaction committed (an
 *   `onSend` hook); a verifier's verdict or a merge is compiled by the periodic pass (`refreshBrains`, after the settings sweep) and by an owner's read, each only
 *   when the records' fingerprint moved. While the brain lock is held only brain tables are written and every other table is read without a lock; no event is
 *   appended. The context bundle built after a claim commits compiles nothing and takes no lock: it reads the last compilation and inserts the attempt's bundle row.
 *   So no brain path takes the scheduler lock, a run row, a status row or the event sequence, and no path above takes the brain lock.
 * - stack settings (apps/control-api/src/stack.ts): an owner's stack write and a runner's static detection each take the project's `project_stacks` row and
 *   nothing else, with no other lock held, and write only that row (an owner write moves `revision`, a detection only `detection_revision`); no event is appended and no runner command is issued. An owner's write is followed, after
 *   its transaction committed, by a Brain compile through the same `onSend` hook (its own transaction on the brain lock, as above); the Brain reads the stack row
 *   without a lock. A detection compiles nothing. So no stack path takes the scheduler lock, a run row, a status row, the event sequence or the brain lock.
 * - the skill library (apps/control-api/src/skills.ts): an owner's review, revoke and binding save each take the scheduler lock first, then only their own row (the staged
 *   version, the revocation, the project's binding row for that skill), then append to `skill_actions` (insert only) and, when the project has a run, the event sequence
 *   last (`settings.changed`). No status row and no Brain lock. An intake inserts its version, files and history row with no other lock and appends no event. A runner's
 *   delivery confirmation updates only its attempt's `skill_execution_records` row, with no other lock. The claim poll resolves packs after
 *   its scheduler lock, reading the stack, binding, staged-version and revocation rows without locking them, so a revoke or an unbind holds for every claim after its save
 *   commits; a refused pack is recorded through the claim's own `placement.blocked` on the status row it already holds, and the attempt's `skill_execution_records` row is
 *   inserted with its attempt row. An intake takes no lock (it inserts a version nothing can use until it is reviewed). Delivering pack content after a claim commits
 *   reads only.
 * - product-learning records (apps/control-api/src/product.ts): an owner's brief, outcome plan, release note or outcome review takes the project's `product_heads`
 *   row first, with no other lock held, inserts one immutable `product_records` revision (a brief started from a worker proposal deletes that `product_brief_proposals`
 *   row under the same lock), then appends to the event sequence last (`product.recorded`, the owner as actor), first appending, in log order, the events of any earlier
 *   record written while the project had no run. A worker's proposed brief takes its lease's `attempts` row first (`lockLease`: the lease is checked again under that lock,
 *   so a revoke or expiry that committed first wins) and the runner row read, then `product_heads`, then its `product_brief_proposals` rows (insert, drop past the cap),
 *   then the event sequence (`product.proposed`); it also records the proposal's digest in `product_proposal_audit` under the same locks. After an activation or a
 *   run create commits (an `onSend` hook), after the real-run seed commits, and on the periodic Brain pass (its own try per project), any deferred product events
 *   are appended in their own transaction: `product_heads`, then the event sequence. The plan, candidates, verification records, pull requests and Brain revisions are read without a lock, and nothing here
 *   writes a task, a run, a status row or a plan proposal: a review's follow-up is stored with the review as a proposal. An owner's write is followed, after its
 *   transaction committed, by a Brain compile through the same `onSend` hook; the Brain reads `product_records` without a lock, and the product view compiles (in
 *   its own transaction) only when the records' fingerprint moved. A path that holds an attempt row and wants `product_heads` is only the proposal, and nothing holds
 *   `product_heads` and wants an attempt row. So no product path takes the scheduler lock, a run row, a status row or the brain lock, and no path above takes
 *   `product_heads`.
 * - checkpoint continuation (services/workflow/src/handover.ts, apps/control-api/src/handover.ts): the owner's request (`requestHandover`) and the owner's answer to a restart
 *   offer (`decideHandover`) take the scheduler lock, the task's status row, the run row (`lockBudget`, the request only, to judge the successor's hold), then the
 *   task's `checkpoints` row (insert or update), the `task_commands` insert (the stop) and the event sequence: the claim poll's order (scheduler lock, status row, run
 *   row) with rows after it that no other path takes first. The runner's checkpoint upload (`recordCheckpoint`) takes the status row, then the `checkpoints` row, then the
 *   event sequence; it takes no run row. The fence runs inside a publish or a lease expiry, after `settle` took the run row: status row, run row, `checkpoints` row, the
 *   attempt row's revoke, then the event sequence (`fenceHandover`, from `confirmCancel`). A late publish by a fenced attempt takes the status row, then the `checkpoints`
 *   row and the event sequence (`recordLatePublish`). The successor's claim writes the `checkpoints` row after its attempt row and its first events, inside the claim's
 *   own order (`startSuccessor`): the one place the row follows the event sequence, which cannot cross the others because every writer of a task's `checkpoints` row
 *   holds that task's status row first, so two writers of one row are serialised there before either reaches it; its setup-complete heartbeat takes the status row then the `checkpoints` row (`markSuccessorRunning`); a successor that cannot apply its
 *   checkpoint, or is lost (lease expiry, a setup failure), or ends any other way, moves the row inside `closeLease`, after the run row, in its publish or its expiry
 *   (`successorEnded`: offered again at a new fence, offered to the owner, or closed). The owner's release, restart or decline (`decideHandover`): scheduler lock, the
 *   status row, the `checkpoints` row, the status row's placement block, then the event sequence. The periodic review of fenced rows (`reviewHandovers`, in the expiry
 *   driver's after-pass): the status row, then the run row and budget read without a lock (`readBudget`), the `checkpoints` row and the event sequence; no scheduler lock,
 *   so a claim holding the scheduler lock and waiting for that status row meets nothing this pass holds. A view's eligibility (`assessHandover`) is a plain read that locks
 *   nothing. A replan closes the replaced tasks' handovers (`closeHandovers`) after the status rows it holds and before its events; a run cancel (the route's immediate
 *   finish and `finishCancelledRuns`) and a task cancel close theirs after the status rows they hold. The successor's checkpoint fetch and the owner's diff read take no lock.
 *   A task blocked while a handover holds it (`refuseRepair` in the claim, a blocked publish, a timed-out attempt whose repairs ran out) offers the handover to the owner
 *   after its own status write, on the status row it holds (`heldTaskBlocked`). Every offer moves the status row's revision itself (`bumpRevision`, an increment of the
 *   stored value) and emits at that revision; `setStatus` increments the stored value too, so a later write in the same transaction never repeats or lowers it. None of
 *   these takes a lock the paths above do not already hold; the claim's mid-loop emissions are deferred until it has locked its last status row (below). So every handover path
 *   takes the status row before the `checkpoints` row and the run row (when it takes one) before it too, no path holds a `checkpoints` row and waits for a status row,
 *   the scheduler lock or a run row, and none takes the candidate row, the claim lock, the brain lock or `product_heads`. The verdict, re-verify and settle never touch
 *   a running task's handover, and a replan meets the request exactly as it meets the claim poll (the scheduler lock serialises them).
 * - accepted patch proposals (services/workflow/src/proposal.ts, H5): the owner's accept (`acceptProposal`, `POST /v1/projects/:id/tasks/:taskId/proposals/accept`)
 *   takes the scheduler lock, the task's status row, then the task's `accepted_proposals` rows (a waiting one superseded, the new one inserted), then the event sequence
 *   (`proposal.accepted`, the owner as actor). The claim reads the waiting row after it locked the status row and, when it starts the apply attempt, moves that row
 *   to `applying` right after its attempt row, inside its own order (`markApplying`), before its first event; the scheduler lock serialises it with an accept, and
 *   no other path writes the row. The runner's fetch (`fetchProposalForLease`) and the owner's context and change reads (`appliedProposalFor`) lock nothing. No
 *   proposal path takes a run row, the candidate row, this lock, the brain lock or `product_heads`. The owner's task context read (H5 fix round 4) inserts one
 *   `agent_contexts` row (insert, or on a repeat read raise its label to the stronger one; no other lock); an accept, an agent criteria revision and an agent PR
 *   body read it without a lock. The periodic pass prunes rows older than 7 days whose task has no accept waiting (`pruneAgentContexts`), a delete with no other lock.
 * - every path above that decides from a task's status reads it again after locking its row, and writes it at that locked revision (`bumpStatus` and
 *   `setBlock` refuse a row that moved), so a status changed by a path that held the row first is never written back.
 *
 * The claim poll and the event sequence (T7.5). `tryClaim` locks candidates' status rows one by one in one transaction, and a candidate it skips may still emit (a recorded
 * block or hold, a refused repair, an approval gate). Appending an event takes the project's event sequence, and three paths take a claimable task's status row and then the
 * sequence with no scheduler lock: the owner's immediate task cancel (routes-owner.ts, the `/v1/tasks/:id/commands` cancel of a ready or planned task), an approval resolve
 * (`/v1/approvals/:id/resolve`) and the handover sweep (`reviewHandovers`). A publish or a lease expiry never meets the claim here: it holds a running task's row, which the
 * claim never locks, since it locks only claimable candidates; so the claim defers every event it emits (`deferEvents`) and appends them, in emission order, only after its last status-row lock
 * (`flushEvents`, when it returns). Chosen over locking every candidate's row up front, which would hold rows of tasks it never claims and change which blocks it records.
 * The claim therefore never holds the event sequence while it waits for a status row.
 *
 * Paths that still disagree, all at the run row, and how the loser of each recovers:
 * - The claim poll (`tryClaim`) takes the scheduler lock, a claimable task's status row, then the run row (`lockBudget`). Replan and re-verify hold the scheduler lock before
 *   their run row, so they wait for it rather than cross it. The verdict takes no scheduler lock, but its parts are `verifying` and the poll only locks claimable rows, so the
 *   two never want the same status row. No cycle.
 * - A run setting save that touches status rows, and a run cancel, hold the scheduler lock and the run row and then want status rows, exactly as a replan does,
 *   so they meet the lease paths below the same way and recover the same way: the owner's request gets the retryable 503 `transaction_conflict` with nothing
 *   recorded; `finishCancelledRuns` is a background pass that logs the error and runs again on the next tick.
 * - The lease paths take a leased task's status row and then the run row with no scheduler lock: a runner's publish and the budget stop after a reconciled cost (`settle`,
 *   `lockBudget`), and lease expiry. Re-verify and the verdict lock only tasks with no live lease (verified, blocked, verifying), so they cannot meet these. A replan can: it
 *   locks the status row of any task it names, and a task whose attempt is still leased is one (it is refused, but only after the lock). Postgres breaks that cycle by rolling
 *   one side back:
 *     - the replan gets a 503 `transaction_conflict`, nothing was recorded, and the owner sends it again (the screen says retrying is safe);
 *     - a publish gets the same 503 on the runner route, and the runner retries it up to three times before letting the lease lapse to expiry;
 *     - lease expiry and the verifier are background loops: the pass that lost logs the error and the next tick does the work again, with no 503 anywhere. A verdict that loses
 *       releases its claim on the candidate, which stays assembled with its parts verifying, so a later tick claims it and judges it again.
 * - The merge reconcile (packages/integrations-github/src/reconcile.ts) takes the event sequence (`change.merged`) and the verified parts' status rows, then the run row last. An
 *   owner replan or re-verify of the same run holds the run row and then wants a status row or the event sequence, so the two can close a cycle while the run is still in review.
 *   Postgres rolls one back:
 *     - the replan or re-verify gets the retryable 503 `transaction_conflict`, nothing was recorded, and the owner sends it again;
 *     - the reconcile throws with nothing recorded: a webhook hint stays `received` with the error and is processed again, and the poller reads every open pull request again on
 *       its next pass. If instead the replan wins and commits first, the reconcile's last write matches no run in review, so it rolls itself back and decides again, as stale.
 *
 * Three more paths take status rows first and the run row last, and the verdict takes the run row before its parts' status rows:
 * - a cancel that retires a stale candidate: candidate, scheduler lock, the task's and the other parts' status rows, this lock, the event sequence, then the run row in `leaveReview`;
 * - a rebuild's invalidation (`invalidate` in services/verifier/src/integrate.ts): the candidate rows it invalidates, scheduler lock, their parts' status rows, this lock, the event
 *   sequence, then the run row as it reverts the run;
 * - a merge reconcile (packages/integrations-github/src/reconcile.ts): the change request row, the verified parts' status rows (`markTaskMerged`), the event sequence, then the run row
 *   as it marks the run merged.
 * None of them can meet a verdict on a live candidate, one whose parts are `verifying`. Each touches the run row only through an `UPDATE ... WHERE lifecycle = 'ready_for_review'`,
 * and a run with a part waiting for a verdict is never committed as `ready_for_review`: every path that sends a part to `verifying` or gives the run unfinished work (re-verify,
 * a stale exit, a rebuild, an accepted plan, `leaveReviewForPlan`) takes it out of review in the same transaction, and the verdict's own `ready_for_review` is written only at its
 * commit. Postgres tests that predicate against the committed row before it waits for a row lock, so the update skips the row the verdict holds rather than queueing behind it.
 * The verdict may wait for their status rows, but they never wait for anything it holds: the two candidate-first paths take the candidate row before anything else, as the verdict
 * does, so on the same candidate one simply goes first.
 */
const lockClaimRows = (tx: Tx, scope: ClaimScope) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.claim_rows:${scope.tenantId}:${scope.projectId}`}, 0))`);

/** For a transaction about to change claims for several tasks: their status rows in task order, then the claim lock, so no status row is waited for while claims are held. */
export async function lockPartsForClaims(tx: Tx, scope: ClaimScope, taskIds: readonly string[]): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (ids.length > 0) await tx.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, scope.tenantId), eq(schema.taskStatus.projectId, scope.projectId), inArray(schema.taskStatus.taskId, ids))).orderBy(asc(schema.taskStatus.taskId)).for('update');
  await lockClaimRows(tx, scope);
}

/**
 * Makes sure one of this run's parts holds `key` at least at `mode`. `own` is the set of tasks sharing that candidate; a live row on the key held by anyone else is left alone and does
 * not stand in for this run's own (the caller has established it does not conflict, so it can only be shared beside a shared want). Postgres allows one live exclusive row per key, so
 * a candidate's parts share one row: an existing row of theirs is kept, raised to exclusive if that is what is wanted, and never lowered.
 */
export async function holdClaim(tx: Tx, scope: ClaimScope, want: { readonly key: string; readonly mode: 'shared' | 'exclusive'; readonly taskId: string; readonly revision: number; readonly attemptId: string; readonly own: readonly string[] }, now: Date): Promise<void> {
  await lockClaimRows(tx, scope);
  const held = and(eq(schema.resourceClaims.tenantId, scope.tenantId), eq(schema.resourceClaims.projectId, scope.projectId), eq(schema.resourceClaims.resourceKey, want.key), isNull(schema.resourceClaims.releasedAt));
  const live = await tx.select({ claimId: schema.resourceClaims.claimId, mode: schema.resourceClaims.mode, taskId: schema.resourceClaims.taskId }).from(schema.resourceClaims).where(held).for('update');
  const rows = live.filter((r) => r.taskId !== null && want.own.includes(r.taskId));
  if (rows.length === 0) {
    await tx.insert(schema.resourceClaims).values({ tenantId: scope.tenantId, projectId: scope.projectId, claimId: `clm_${randomUUID()}`, taskId: want.taskId, revision: want.revision, resourceKey: want.key, mode: want.mode, attemptId: want.attemptId });
    return;
  }
  if (want.mode !== 'exclusive' || rows.some((r) => r.mode === 'exclusive')) return;
  const [keep, ...rest] = rows;
  // Shared rows of this run's other parts go first: the index would refuse an exclusive beside them only once, but a claim is one row from here on.
  if (rest.length > 0) await tx.update(schema.resourceClaims).set({ releasedAt: now }).where(and(held, inArray(schema.resourceClaims.claimId, rest.map((r) => r.claimId))));
  await tx.update(schema.resourceClaims).set({ mode: 'exclusive' }).where(and(held, eq(schema.resourceClaims.claimId, keep!.claimId)));
}

/**
 * Releases every claim a task revision still holds. Claims are held through verification and released on its outcome. A row this task holds for parts of its run that are still
 * waiting for a verdict passes to one of them, so a part leaving (cancelled, or judged first) cannot free a resource the others still rely on.
 *
 * Everything is read after the claim lock: a row handed to this task by another part leaving at the same moment is seen here, and a sibling that left is not an heir.
 */
export async function releaseTaskClaims(tx: Tx, key: TaskKey, revision: number, now: Date): Promise<void> {
  await lockClaimRows(tx, key);
  const mine = and(eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), eq(schema.resourceClaims.taskId, key.taskId), eq(schema.resourceClaims.revision, revision), isNull(schema.resourceClaims.releasedAt));
  const held = await tx.select({ claimId: schema.resourceClaims.claimId, resourceKey: schema.resourceClaims.resourceKey }).from(schema.resourceClaims).where(mine);
  if (held.length === 0) return;
  const siblings = await tx.execute(sql`
    SELECT s.task_id, s.current_revision, r.spec, (SELECT a.attempt_id FROM attempts a WHERE a.tenant_id = s.tenant_id AND a.project_id = s.project_id AND a.task_id = s.task_id AND a.revision = s.current_revision ORDER BY a.attempt_number DESC LIMIT 1) AS attempt_id
    FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
    WHERE s.tenant_id = ${key.tenantId} AND s.project_id = ${key.projectId} AND s.status = 'verifying' AND s.task_id <> ${key.taskId}
      AND r.run_id = (SELECT run_id FROM task_revisions x WHERE x.tenant_id = ${key.tenantId} AND x.project_id = ${key.projectId} AND x.task_id = ${key.taskId} AND x.revision = ${revision})
    ORDER BY s.task_id`);
  for (const row of held) {
    const claimsOf = (b: Record<string, unknown>) => TaskSpecSchema.parse(b['spec']).resourceClaims.filter((c) => c.key === row.resourceKey);
    const wanting = siblings.filter((b) => claimsOf(b).length > 0);
    const others = wanting.length === 0 ? [] : await tx.select({ id: schema.resourceClaims.claimId }).from(schema.resourceClaims).where(and(eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), eq(schema.resourceClaims.resourceKey, row.resourceKey), isNull(schema.resourceClaims.releasedAt), inArray(schema.resourceClaims.taskId, wanting.map((b) => String(b['task_id'])))));
    if (wanting.length === 0 || others.length > 0) {
      await tx.update(schema.resourceClaims).set({ releasedAt: now }).where(and(mine, eq(schema.resourceClaims.claimId, row.claimId)));
      continue;
    }
    const heir = wanting[0]!;
    const mode = wanting.some((b) => claimsOf(b).some((c) => c.mode === 'exclusive')) ? 'exclusive' : 'shared';
    await tx.update(schema.resourceClaims).set({ taskId: String(heir['task_id']), revision: Number(heir['current_revision']), mode, attemptId: heir['attempt_id'] === null ? null : String(heir['attempt_id']) }).where(and(mine, eq(schema.resourceClaims.claimId, row.claimId)));
  }
}

/**
 * Applies a verifier verdict to one task in the caller's transaction (or its own).
 *
 * Only a real `verifier` principal may call this; the event allowlist enforces it again at emission. A task that is no longer
 * `verifying` (cancelled, superseded, ...) keeps its state: the late verdict is history only. `error` and `skipped` are not
 * verdicts: the task stays `verifying` with its claims held until the verification driver's reaper closes it (`closeVerificationWithoutVerdict`).
 *
 * passed -> `verified`, claims released. (Readiness of the run is decided by `markRunReadyForReview`, which needs live evidence.)
 * failed -> `failed`, claims released, then a bounded repair through the retry transition (`ready`), or `blocked` when the
 *           attempt budget is spent. An attempt an owner sent back for re-verification goes straight to `blocked` (`reverification_failed`): finished work
 *           re-judged never starts a worker. That rule is read from the `reverify` command naming this attempt, so it survives the candidate being rebuilt.
 *           The trusted suite is never touched.
 */
export async function applyVerification(
  ctx: { readonly db: Db; readonly now: () => Date }, key: TaskKey,
  input: {
    readonly actor: Actor; readonly outcome: VerificationVerdict; readonly detail: Record<string, unknown>;
    /** The revision and attempt the verified candidate part carried. A verdict on anything else is stale and changes nothing. */
    readonly expect?: { readonly revision: number; readonly attemptId: string };
  }, tx?: Tx,
): Promise<VerificationApplication> {
  if (input.actor.kind !== 'verifier') throw new Error('only the verifier identity may apply a verification outcome');
  const run = async (t: Tx): Promise<VerificationApplication> => {
    const row = await lockStatusRow(t, key);
    if (!row) return { applied: false, taskStatus: 'unknown', reason: 'task_not_found' };
    if (row.status !== 'verifying') return { applied: false, taskStatus: row.status, reason: 'not_verifying' };
    if (input.expect) {
      const latest = (await loadAttempts(t, key, row.currentRevision)).at(-1);
      if (row.currentRevision !== input.expect.revision || latest?.attemptId !== input.expect.attemptId) return { applied: false, taskStatus: row.status, reason: 'stale_candidate' };
    }
    if (input.outcome === 'error' || input.outcome === 'skipped') return { applied: false, taskStatus: row.status, reason: `no_verdict:${input.outcome}` };

    const revisions = await t.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(
      eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
    const spec = TaskSpecSchema.parse(revisions[0]!.spec);
    const attempts = await loadAttempts(t, key, row.currentRevision);
    const initial = buildTaskState(spec, row.status as TaskStatus, attempts);
    if (!initial) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
    const attemptId = attempts[attempts.length - 1]?.attemptId ?? null;
    const now = ctx.now();
    const move = (state: TaskState, event: Parameters<typeof transition>[1]): TaskState => {
      const r = transition(state, event);
      if (!r.ok) throw new Error(`illegal verification transition: ${JSON.stringify(r.error)}`);
      return r.value;
    };

    let state: TaskState;
    let repair: 'scheduled' | 'refused' | undefined;
    let follow: { type: 'task.ready' | 'task.blocked'; reason: string } | undefined;
    if (input.outcome === 'passed') {
      state = move(initial, { type: 'verification_passed' });
    } else {
      const failed = move(initial, { type: 'verification_failed', reason: 'verification_failed' });
      const reverified = attemptId !== null && (await t.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(
        eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId), eq(schema.taskCommands.revision, row.currentRevision),
        eq(schema.taskCommands.command, 'reverify'), sql`${schema.taskCommands.detail} ->> 'attemptId' = ${attemptId}`)).limit(1)).length > 0;
      const retry = reverified ? null : transition(failed, { type: 'retry_requested' });
      if (retry?.ok) { state = retry.value; repair = 'scheduled'; follow = { type: 'task.ready', reason: 'repair_scheduled' }; }
      else {
        const reason = reverified ? 'reverification_failed' : 'repair_budget_exhausted';
        state = move(failed, { type: 'repair_refused', reason }); repair = 'refused'; follow = { type: 'task.blocked', reason };
      }
    }

    // The attempt that was verified gets its real outcome (it stayed `running` while it waited for the verdict).
    for (const rec of state.attempts) {
      const stored = attempts.find((a) => a.attemptId === rec.attemptId);
      if (stored && stored.outcome !== rec.outcome) {
        await t.update(schema.attempts).set({ outcome: rec.outcome }).where(and(
          eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, rec.attemptId)));
      }
    }
    await releaseTaskClaims(t, key, row.currentRevision, now);
    const aggregateRevision = await setStatus(t, key, row.rowRevision, state.status, now);
    const scope: EventScope = { projectId: key.projectId, runId: spec.runId, taskId: key.taskId, aggregateRevision };
    await emit(t, scope, now, {
      type: input.outcome === 'passed' ? 'verification.passed' : 'verification.failed', attemptId, actor: input.actor, payload: { ...input.detail },
    });
    if (follow) await emit(t, scope, now, { type: follow.type, attemptId, actor: SCHEDULER_ACTOR, payload: { reason: follow.reason } });
    return { applied: true, taskStatus: state.status, reason: input.outcome, ...(repair ? { repair } : {}) };
  };
  return tx ? run(tx) : withTx(ctx.db, run);
}

/**
 * Closes a task whose candidate got no verdict (`error`, `skipped`): it stops at `blocked` with its claims released, so nothing waits on it forever.
 * The attempt ends `interrupted`, so no repair is spent. The caller holds the candidate lock and passes the part's revision and attempt: a task that
 * moved on is left alone. Returns whether this task was closed.
 */
export async function closeVerificationWithoutVerdict(
  ctx: { readonly now: () => Date }, tx: Tx, key: TaskKey,
  input: { readonly reason: string; readonly candidateSha?: string; readonly expect: { readonly revision: number; readonly attemptId: string } },
): Promise<boolean> {
  const row = await lockStatusRow(tx, key);
  if (!row || row.status !== 'verifying' || row.currentRevision !== input.expect.revision) return false;
  const attempts = await loadAttempts(tx, key, row.currentRevision);
  if (attempts.at(-1)?.attemptId !== input.expect.attemptId) return false;
  const revisions = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(
    eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
  const spec = TaskSpecSchema.parse(revisions[0]!.spec);
  const state = buildTaskState(spec, 'verifying', attempts);
  if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
  const moved = transition(state, { type: 'verification_unavailable', reason: input.reason });
  if (!moved.ok) throw new Error(`illegal verification transition: ${JSON.stringify(moved.error)}`);
  const now = ctx.now();
  await tx.update(schema.attempts).set({ outcome: 'interrupted', exitReason: input.reason }).where(and(
    eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, input.expect.attemptId)));
  await releaseTaskClaims(tx, key, row.currentRevision, now);
  const aggregateRevision = await setStatus(tx, key, row.rowRevision, moved.value.status, now);
  await emit(tx, { projectId: key.projectId, runId: revisions[0]!.runId, taskId: key.taskId, aggregateRevision }, now, {
    type: 'task.blocked', attemptId: input.expect.attemptId, actor: SCHEDULER_ACTOR, payload: { reason: input.reason, ...(input.candidateSha !== undefined ? { candidateSha: input.candidateSha } : {}) },
  });
  return true;
}

/** Closes every part of a candidate without a verdict in one transaction. Status rows first and in order: closing one part and then waiting for the next would deadlock against that part's cancel. */
export async function closePartsWithoutVerdict(
  ctx: { readonly now: () => Date }, tx: Tx, scope: ClaimScope,
  parts: readonly { readonly taskId: string; readonly revision: number; readonly attemptId: string }[], input: { readonly reason: string; readonly candidateSha?: string },
): Promise<void> {
  await lockPartsForClaims(tx, scope, parts.map((p) => p.taskId));
  for (const p of parts) await closeVerificationWithoutVerdict(ctx, tx, { ...scope, taskId: p.taskId }, { ...input, expect: { revision: p.revision, attemptId: p.attemptId } });
}

/**
 * Owner-requested re-verifications per task revision and verifier build (see `reverifiesUsed`). Bounded, so a broken verifier cannot be retried for ever by hand either. A new
 * verifier is a new question about the same work, so it starts a new count. Under one build the bound can still be spent, and the exit then is cancel or replan.
 */
export const REVERIFY_LIMIT = 3;

/** What each `reverify` command records: the attempt sent back, which is what carries the no-repair rule, and the verifier build it was asked of, which keys the bound. */
const reverifyDetail = (attemptId: string, trusted: TrustedVerifier | null): Record<string, unknown> => ({ attemptId, ...(trusted ?? {}) });

/** Re-verifications of this task revision under this verifier build. No build known (no evidence wiring) counts the commands that named none. */
async function reverifiesUsed(tx: Tx, key: TaskKey, revision: number, trusted: TrustedVerifier | null): Promise<number> {
  const used = await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(
    eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId), eq(schema.taskCommands.command, 'reverify'), eq(schema.taskCommands.revision, revision),
    sql`${schema.taskCommands.detail} ->> 'checkManifestSha256' IS NOT DISTINCT FROM ${trusted?.checkManifestSha256 ?? null}::text`,
    sql`${schema.taskCommands.detail} ->> 'verifierSha256' IS NOT DISTINCT FROM ${trusted?.verifierSha256 ?? null}::text`));
  return used.length;
}

/** Why an owner may send a run's finished work back for another verdict: the verifier or the assembly failed, and nothing was concluded about the work. */
export const isReverifiableBlock = (reason: string | null): boolean => reason === 'verification_error' || (reason !== null && reason.startsWith('assembly_infrastructure:'));

export type ReverifyRefusal = 'nothing_to_reverify' | 'reverify_limit_reached' | 'resource_conflict';
export type ReverifyOutcome = { readonly ok: true; readonly reopened: readonly string[] } | { readonly ok: false; readonly reason: ReverifyRefusal; readonly taskId?: string };

/**
 * Sends a run's work that was blocked by a verifier or assembly failure back to `verifying`, with the worker's attempt waiting for a verdict again. No attempt
 * starts: the assembly driver picks the parts up, because they are verifying and in no live candidate, and the same commit is built and judged again. Claims go
 * back under the scheduler's lock. The caller holds the transaction and has recorded the owner's idempotency key.
 */
export async function reopenBlockedVerification(
  ctx: { readonly now: () => Date }, tx: Tx, run: { readonly tenantId: string; readonly projectId: string; readonly runId: string }, requestedBy: string, operationId: string, trusted: TrustedVerifier | null,
  /** `baseMoved`: main has moved since a rebuild failed its verdict, so `reverification_failed` is reopenable too. `unbounded`: the driver's own retry, one per move of main, spends no owner re-verification. */
  opts: { readonly baseMoved?: boolean; readonly unbounded?: boolean } = {},
): Promise<ReverifyOutcome> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`);
  const blocked = await tx.execute(sql`
    SELECT s.task_id, s.current_revision AS revision, s.row_revision, r.spec, e.reason, e.by_scheduler
    FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
    LEFT JOIN LATERAL (SELECT payload ->> 'reason' AS reason, (actor_kind = ${SCHEDULER_ACTOR.kind} AND actor_id = ${SCHEDULER_ACTOR.id} AND payload -> 'fence' IS NULL) AS by_scheduler FROM events x WHERE x.tenant_id = s.tenant_id AND x.project_id = s.project_id AND x.task_id = s.task_id AND x.type = 'task.blocked' ORDER BY sequence DESC LIMIT 1) e ON true
    WHERE s.tenant_id = ${run.tenantId} AND s.project_id = ${run.projectId} AND s.status = 'blocked' AND r.run_id = ${run.runId}
    ORDER BY s.task_id`);
  // The reason must come from the control plane's own verification close. A worker's reported `blocked` reason is free text (the scheduler records it
  // under its own actor, with the lease `fence` in the payload), so a worker that reports `verification_error` must not earn a re-verification.
  const eligible = blocked.filter((b) => b['by_scheduler'] === true && (isReverifiableBlock(b['reason'] as string | null) || (opts.baseMoved === true && b['reason'] === 'reverification_failed')));
  if (eligible.length === 0) return { ok: false, reason: 'nothing_to_reverify' };
  // Every part is planned before anything is written: a refusal for one part must leave all of them as they were, or a partial tree gets judged.
  interface Planned { readonly taskId: string; readonly revision: number; readonly key: TaskKey; readonly rowRevision: number; readonly attemptId: string; readonly status: TaskStatus; readonly want: ReadonlyMap<string, 'shared' | 'exclusive'> }
  const planned: Planned[] = [];
  for (const b of eligible) {
    const taskId = String(b['task_id']);
    const revision = Number(b['revision']);
    const key: TaskKey = { tenantId: run.tenantId, projectId: run.projectId, taskId };
    const row = await lockStatusRow(tx, key);
    if (!row || row.status !== 'blocked' || row.currentRevision !== revision) continue;
    if (opts.unbounded !== true && (await reverifiesUsed(tx, key, revision, trusted)) >= REVERIFY_LIMIT) return { ok: false, reason: 'reverify_limit_reached', taskId };

    const spec = TaskSpecSchema.parse(b['spec']);
    const attempts = await loadAttempts(tx, key, revision);
    const state = buildTaskState(spec, 'blocked', attempts);
    if (!state) throw new Error(`task ${taskId}: stored spec no longer valid`);
    const moved = transition(state, { type: 'reverify_requested', afterFailedVerdict: b['reason'] === 'reverification_failed' });
    if (!moved.ok) return { ok: false, reason: 'nothing_to_reverify', taskId };
    const want = new Map<string, 'shared' | 'exclusive'>();
    for (const c of spec.resourceClaims) if (want.get(c.key) !== 'exclusive') want.set(c.key, c.mode);
    planned.push({ taskId, revision, key, rowRevision: row.rowRevision, attemptId: moved.value.attempts.at(-1)!.attemptId, status: moved.value.status, want });
  }
  if (planned.length === 0) return { ok: false, reason: 'nothing_to_reverify' };

  // The parts coming back and this run's others waiting for a verdict go into one candidate, so their claims are not a conflict; anyone else's is, for all of them.
  const waiting = await tx.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus).innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId), eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, run.tenantId), eq(schema.taskStatus.projectId, run.projectId), eq(schema.taskRevisions.runId, run.runId), eq(schema.taskStatus.status, 'verifying')));
  const own = new Set([...planned.map((p) => p.taskId), ...waiting.map((w) => w.taskId)]);
  for (const p of planned) {
    if (p.want.size === 0) continue;
    const live = await tx.select({ key: schema.resourceClaims.resourceKey, mode: schema.resourceClaims.mode, taskId: schema.resourceClaims.taskId }).from(schema.resourceClaims).where(and(
      eq(schema.resourceClaims.tenantId, run.tenantId), eq(schema.resourceClaims.projectId, run.projectId), inArray(schema.resourceClaims.resourceKey, [...p.want.keys()]), isNull(schema.resourceClaims.releasedAt)));
    if ([...p.want].some(([k, m]) => live.some((h) => h.key === k && !own.has(h.taskId) && (m === 'exclusive' || h.mode === 'exclusive')))) return { ok: false, reason: 'resource_conflict', taskId: p.taskId };
  }

  const now = ctx.now();
  const reopened: string[] = [];
  await lockClaimRows(tx, run);
  for (const p of planned) {
    for (const [resourceKey, mode] of p.want) await holdClaim(tx, p.key, { key: resourceKey, mode, taskId: p.taskId, revision: p.revision, attemptId: p.attemptId, own: [...own] }, now);
    await tx.update(schema.attempts).set({ outcome: 'running', exitReason: null }).where(and(
      eq(schema.attempts.tenantId, p.key.tenantId), eq(schema.attempts.projectId, p.key.projectId), eq(schema.attempts.attemptId, p.attemptId)));
    const aggregateRevision = await setStatus(tx, p.key, p.rowRevision, p.status, now);
    await tx.insert(schema.taskCommands).values({ tenantId: p.key.tenantId, projectId: p.key.projectId, operationId: `${operationId}_${p.taskId}`, taskId: p.taskId, revision: p.revision, command: 'reverify', state: 'applied', requestedBy, requestedAt: now, detail: reverifyDetail(p.attemptId, trusted) });
    // The control plane acting for the owner, as with `plan.accepted`: `task.reopened` is not a human event, and the owner is named in the payload.
    await emit(tx, { projectId: run.projectId, runId: run.runId, taskId: p.taskId, aggregateRevision }, now, { type: 'task.reopened', attemptId: p.attemptId, actor: { kind: 'integration', id: 'reverify' }, payload: { reason: 'owner_reverify', status: 'verifying', requestedBy } });
    reopened.push(p.taskId);
  }
  return reopened.length > 0 ? { ok: true, reopened } : { ok: false, reason: 'nothing_to_reverify' };
}

/**
 * The locks an owner route takes before it locks `run`'s row, in the documented order: the stale candidate when `sha` names one (null when it moved on), then the scheduler
 * lock. The claim poll holds the scheduler lock and then takes a run row (`lockBudget`), so a route that locked the run row first could wait on it while it waits on the route.
 */
export async function lockBeforeRunRow(tx: Tx, run: RunScope, sha: string | null): Promise<StaleCandidate | null> {
  const candidate = sha === null ? null : await lockStaleCandidate(tx, run, sha);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`);
  return candidate;
}

/**
 * An owner's re-verify of a run: a current candidate whose record no longer stands, then work blocked by a verifier or assembly failure. The caller holds the locks from
 * `lockBeforeRunRow` and the run row, and has recorded the idempotency key. Refusals come back unwritten: a refused stale half stops before the blocked half is tried, and the
 * request is refused only when neither half had anything to send back.
 */
export async function reverifyRun(
  ctx: { readonly now: () => Date }, tx: Tx, run: RunScope,
  input: { readonly requestedBy: string; readonly staleSha: string | null; readonly trusted: TrustedVerifier | null; readonly baseMoved: boolean; readonly operationId: () => string },
): Promise<ReverifyOutcome> {
  // Every status row either half may move, before the stale half takes the claim lock: the blocked half locking its rows after that would wait, holding the claim lock, on a
  // cancel that holds one of them and wants the claim lock. Ascending task id, so two of these cannot cross either.
  await tx.execute(sql`
    SELECT s.task_id FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
    WHERE s.tenant_id = ${run.tenantId} AND s.project_id = ${run.projectId} AND r.run_id = ${run.runId} AND s.status IN ('verified', 'blocked')
    ORDER BY s.task_id FOR UPDATE OF s`);
  const stale: ReverifyOutcome = input.staleSha === null || input.trusted === null ? { ok: false, reason: 'nothing_to_reverify' } : await reopenStaleVerification(ctx, tx, run, input.requestedBy, input.operationId(), input.staleSha, input.trusted);
  if (!stale.ok && stale.reason !== 'nothing_to_reverify') return stale;
  const blocked = await reopenBlockedVerification(ctx, tx, run, input.requestedBy, input.operationId(), input.trusted, { baseMoved: input.baseMoved });
  if (!blocked.ok && (blocked.reason !== 'nothing_to_reverify' || !stale.ok)) return blocked;
  return { ok: true, reopened: [...(stale.ok ? stale.reopened : []), ...(blocked.ok ? blocked.reopened : [])] };
}

export interface StaleCandidate { readonly candidateId: string; readonly sha: string; readonly parts: readonly { readonly taskId: string; readonly revision: number; readonly attemptId: string }[] }
interface RunScope { readonly tenantId: string; readonly projectId: string; readonly runId: string }

/**
 * Locks the run's current candidate if it is still the assembled one the caller found stale (`sha`, read before the transaction because loading a record takes its own connection),
 * then takes the scheduler lock: the order assembly uses. Null when the candidate moved on. Take it before any task lock, so this cannot deadlock against a verdict being written.
 */
export async function lockStaleCandidate(tx: Tx, run: RunScope, sha: string): Promise<StaleCandidate | null> {
  const [candidate] = await tx.execute(sql`
    SELECT candidate_id, sha, status, parts FROM candidates WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND sha IS NOT NULL AND status IN ('assembled', 'rejected')
    ORDER BY created_at DESC, candidate_id DESC LIMIT 1 FOR UPDATE`);
  if (!candidate || candidate['status'] !== 'assembled' || candidate['sha'] !== sha) return null;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`);
  return { candidateId: String(candidate['candidate_id']), sha, parts: (candidate['parts'] as StaleCandidate['parts'] | null) ?? [] };
}

interface Reopen {
  readonly key: TaskKey; readonly part: StaleCandidate['parts'][number]; readonly rowRevision: number; readonly state: TaskState;
  readonly attempts: Awaited<ReturnType<typeof loadAttempts>>; readonly want: ReadonlyMap<string, 'shared' | 'exclusive'>; readonly conflict: string | undefined; readonly partIds: readonly string[];
}

/** Works out sending one verified part back to `verifying`, writing nothing. Null when its stored task cannot make that move. Another part of the candidate holding a claim is no conflict. */
async function planReopen(tx: Tx, key: TaskKey, rowRevision: number, part: StaleCandidate['parts'][number], partIds: readonly string[]): Promise<Reopen | null> {
  const [rev] = await tx.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, part.taskId), eq(schema.taskRevisions.revision, part.revision)));
  if (!rev) return null;
  const spec = TaskSpecSchema.parse(rev.spec);
  const attempts = await loadAttempts(tx, key, part.revision);
  const state = buildTaskState(spec, 'verified', attempts);
  if (!state) throw new Error(`task ${part.taskId}: stored spec no longer valid`);
  const want = new Map<string, 'shared' | 'exclusive'>();
  for (const c of spec.resourceClaims) if (want.get(c.key) !== 'exclusive') want.set(c.key, c.mode);
  let conflict: string | undefined;
  if (want.size > 0) {
    const live = await tx.select({ key: schema.resourceClaims.resourceKey, mode: schema.resourceClaims.mode, taskId: schema.resourceClaims.taskId }).from(schema.resourceClaims).where(and(
      eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), inArray(schema.resourceClaims.resourceKey, [...want.keys()]), isNull(schema.resourceClaims.releasedAt)));
    conflict = [...want].find(([k, m]) => live.some((h) => !partIds.includes(h.taskId ?? '') && h.key === k && (m === 'exclusive' || h.mode === 'exclusive')))?.[0];
  }
  const moved = transition(state, { type: 'verification_invalidated', ...(conflict !== undefined ? { blockedReason: `resource_conflict:${conflict}` } : {}) });
  if (!moved.ok) return null;
  return { key, part, rowRevision, state: moved.value, attempts, want, conflict, partIds };
}

/** Writes one planned move and its `task.reopened`. A part that hit a claim conflict is `blocked` with that reason, and takes no claims. */
async function applyReopen(tx: Tx, now: Date, run: RunScope, r: Reopen, payload: Record<string, unknown>): Promise<void> {
  for (const rec of r.state.attempts) {
    const stored = r.attempts.find((a) => a.attemptId === rec.attemptId);
    if (stored && stored.outcome !== rec.outcome) await tx.update(schema.attempts).set({ outcome: rec.outcome }).where(and(eq(schema.attempts.tenantId, r.key.tenantId), eq(schema.attempts.projectId, r.key.projectId), eq(schema.attempts.attemptId, rec.attemptId)));
  }
  if (r.conflict === undefined) {
    for (const [resourceKey, mode] of r.want) await holdClaim(tx, r.key, { key: resourceKey, mode, taskId: r.part.taskId, revision: r.part.revision, attemptId: r.part.attemptId, own: r.partIds }, now);
  }
  const aggregateRevision = await setStatus(tx, r.key, r.rowRevision, r.state.status, now);
  const scope = { projectId: run.projectId, runId: run.runId, taskId: r.part.taskId, aggregateRevision };
  await emit(tx, scope, now, { type: 'task.reopened', attemptId: r.part.attemptId, actor: REVERIFY_ACTOR, payload: { ...payload, status: r.state.status, ...(r.conflict !== undefined ? { blocked: `resource_conflict:${r.conflict}` } : {}) } });
  if (r.conflict !== undefined) await emit(tx, scope, now, { type: 'task.blocked', attemptId: r.part.attemptId, actor: SCHEDULER_ACTOR, payload: { reason: `resource_conflict:${r.conflict}` } });
}

const REVERIFY_ACTOR = { kind: 'integration', id: 'reverify' } as const;

/** The stale record's check runs go, so it can never read as valid again, even if the verifier hashes come back. */
const invalidateCheckRuns = (tx: Tx, run: RunScope, sha: string) => tx.execute(sql`UPDATE check_runs SET result = 'invalidated' WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_sha = ${sha} AND result <> 'invalidated'`);

async function leaveReview(tx: Tx, now: Date, run: RunScope, reason: string, candidateId: string, reopened: readonly string[]): Promise<void> {
  await revertRun(tx, now, run, REVERIFY_ACTOR, { reason, candidateIds: [candidateId], reopenedTasks: reopened });
}

/**
 * Takes a run out of `ready_for_review` and records `run.reverted`, or does nothing if it is not in review. Only a run in review is touched, so a caller whose run is already
 * `running` neither writes nor waits for the row. Returns whether it moved.
 */
async function revertRun(tx: Tx, now: Date, run: RunScope, actor: Actor, payload: Record<string, unknown>): Promise<boolean> {
  const reverted = await tx.execute(sql`UPDATE runs SET lifecycle = 'running' WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND lifecycle = 'ready_for_review' RETURNING run_id`);
  if (reverted.length > 0) await emit(tx, { projectId: run.projectId, runId: run.runId, taskId: run.runId, aggregateRevision: 0 }, now, { type: 'run.reverted', attemptId: null, actor, payload });
  return reverted.length > 0;
}

/**
 * An accepted plan revision put `taskIds` back to `planned` or added them, so the run has unfinished work and is not ready for review, whatever its record says. It leaves review
 * here, as it does when its evidence is invalidated. A pull request already open stays as it is: the pull-request route refuses a run that is not in review, and a merge of it
 * reconciles as `stale_candidate`. The caller holds the run row.
 */
export async function leaveReviewForPlan(tx: Tx, now: Date, run: RunScope, actor: Actor, planRevision: number, taskIds: readonly string[]): Promise<boolean> {
  return revertRun(tx, now, run, actor, { reason: 'owner_replanned', planRevision, taskIds });
}

/**
 * Re-runs verification for a run's current candidate whose record no longer stands (verifier, suite, lockfile or stored bytes changed). Status during a re-verify: every part goes
 * `verified` -> `verifying` with its attempt waiting for a verdict again and its claims back, the candidate's check runs are invalidated so the old record cannot read as valid, and the
 * run leaves review. A new valid record promotes it again; a failed verdict blocks it (`reverification_failed`) with no repair worker; a verifier that keeps erroring is closed by the
 * reaper as any other. No attempt starts. Every check runs before the first write, so a refusal has changed nothing: the tasks stay `verified`, reported as no longer valid.
 * The bound is `REVERIFY_LIMIT` per task revision and verifier build, shared with `reopenBlockedVerification`.
 */
export async function reopenStaleVerification(
  ctx: { readonly now: () => Date }, tx: Tx, run: RunScope, requestedBy: string, operationId: string, sha: string, trusted: TrustedVerifier,
): Promise<ReverifyOutcome> {
  const candidate = await lockStaleCandidate(tx, run, sha);
  if (!candidate || candidate.parts.length === 0) return { ok: false, reason: 'nothing_to_reverify' };
  const [lifecycle] = await tx.select({ lifecycle: schema.runs.lifecycle }).from(schema.runs).where(and(eq(schema.runs.tenantId, run.tenantId), eq(schema.runs.projectId, run.projectId), eq(schema.runs.runId, run.runId)));
  if (!lifecycle || !['running', 'blocked', 'ready_for_review'].includes(lifecycle.lifecycle)) return { ok: false, reason: 'nothing_to_reverify' };
  const partIds = candidate.parts.map((p) => p.taskId);
  const planned: Reopen[] = [];
  for (const part of [...candidate.parts].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    const key: TaskKey = { tenantId: run.tenantId, projectId: run.projectId, taskId: part.taskId };
    const row = await lockStatusRow(tx, key);
    if (!row || row.status !== 'verified' || row.currentRevision !== part.revision) return { ok: false, reason: 'nothing_to_reverify' };
    if ((await reverifiesUsed(tx, key, part.revision, trusted)) >= REVERIFY_LIMIT) return { ok: false, reason: 'reverify_limit_reached', taskId: part.taskId };
    const plan = await planReopen(tx, key, row.rowRevision, part, partIds);
    if (!plan) return { ok: false, reason: 'nothing_to_reverify' };
    if (plan.conflict !== undefined) return { ok: false, reason: 'resource_conflict', taskId: part.taskId };
    planned.push(plan);
  }
  const now = ctx.now();
  await lockClaimRows(tx, run);
  for (const plan of planned) {
    await tx.insert(schema.taskCommands).values({ tenantId: plan.key.tenantId, projectId: plan.key.projectId, operationId: `${operationId}_${plan.part.taskId}`, taskId: plan.part.taskId, revision: plan.part.revision, command: 'reverify', state: 'applied', requestedBy, requestedAt: now, detail: reverifyDetail(plan.part.attemptId, trusted) });
    await applyReopen(tx, now, run, plan, { reason: 'owner_reverify_stale_record', requestedBy, candidateIds: [candidate.candidateId] });
  }
  await invalidateCheckRuns(tx, run, sha);
  // Infrastructure retries are counted per verdict attempt, so this request starts with a full set.
  await tx.execute(sql`UPDATE candidates SET detail = detail - 'verificationRetry', updated_at = ${now.toISOString()}::timestamptz WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_id = ${candidate.candidateId}`);
  const reopened = planned.map((p) => p.part.taskId);
  await leaveReview(tx, now, run, 'owner_reverify_stale_record', candidate.candidateId, reopened);
  return { ok: true, reopened };
}

/**
 * The exit when re-verifying is not the answer: the owner cancelled or replanned `leaving`, verified tasks of a candidate whose record no longer stands. The candidate holds work no
 * longer wanted, so it is retired along with its check runs and cannot reach a pull request even if the hashes come back. Its other verified parts go back to `verifying` (or `blocked`
 * on a claim conflict) for a verdict on a candidate without that work, and the run leaves review. The caller holds the lock from `lockStaleCandidate`.
 */
export async function retireStaleCandidate(ctx: { readonly now: () => Date }, tx: Tx, run: RunScope, candidate: StaleCandidate, leaving: readonly string[], reason: string): Promise<void> {
  const now = ctx.now();
  const partIds = candidate.parts.map((p) => p.taskId);
  const reopened: string[] = [];
  await lockPartsForClaims(tx, run, partIds.filter((id) => !leaving.includes(id)));
  for (const part of [...candidate.parts].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    if (leaving.includes(part.taskId)) continue;
    const key: TaskKey = { tenantId: run.tenantId, projectId: run.projectId, taskId: part.taskId };
    const row = await lockStatusRow(tx, key);
    if (!row || row.status !== 'verified' || row.currentRevision !== part.revision) continue;
    const plan = await planReopen(tx, key, row.rowRevision, part, partIds);
    if (!plan) throw new Error(`task ${part.taskId}: cannot be sent back for verification`);
    await applyReopen(tx, now, run, plan, { reason, candidateIds: [candidate.candidateId] });
    reopened.push(part.taskId);
  }
  await invalidateCheckRuns(tx, run, candidate.sha);
  await tx.execute(sql`UPDATE candidates SET status = 'invalidated', reason = ${reason}, updated_at = ${now.toISOString()}::timestamptz WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_id = ${candidate.candidateId}`);
  await emit(tx, { projectId: run.projectId, runId: run.runId, taskId: run.runId, aggregateRevision: 0 }, now, { type: 'candidate.failed', attemptId: null, actor: REVERIFY_ACTOR, payload: { candidateId: candidate.candidateId, reason, sha: candidate.sha } });
  await leaveReview(tx, now, run, reason, candidate.candidateId, reopened);
}

/**
 * Sets the run `ready_for_review` only when the tasks covered by one live passing verdict are exactly the run's live tasks (current
 * revisions that are not cancelled or superseded) and every one of them is verified or merged. Returns whether the run is ready.
 *
 * It writes the run row last, after the claim lock and the event sequence, so the caller must already hold that row: the verdict takes it with the candidate
 * (`lockForVerdict`). Locked here for the first time, it would close a cycle with an owner replan or re-verify that holds the run row and wants the event sequence.
 */
export async function markRunReadyForReview(tx: Tx, key: TaskKey, runId: string, coveredTaskIds: readonly string[]): Promise<boolean> {
  const tasks = await tx
    .select({ taskId: schema.taskStatus.taskId, status: schema.taskStatus.status })
    .from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
      eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskRevisions.runId, runId),
      ne(schema.taskStatus.status, 'cancelled'), ne(schema.taskStatus.status, 'superseded')));
  const covered = new Set(coveredTaskIds);
  const exact = tasks.length > 0 && tasks.length === covered.size && tasks.every((t) => covered.has(t.taskId) && (t.status === 'verified' || t.status === 'merged'));
  if (!exact) return false;
  await tx.update(schema.runs).set({ lifecycle: 'ready_for_review' }).where(and(
    eq(schema.runs.tenantId, key.tenantId), eq(schema.runs.projectId, key.projectId), eq(schema.runs.runId, runId), inArray(schema.runs.lifecycle, ['running', 'blocked'])));
  return true;
}
