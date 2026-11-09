import { WORKER_APPROVAL_OPERATIONS } from '@selarikru/domain';
import { approvalStateAt, effectiveWorkerHealth, isBudgetStopped, isReverifiableReason, type ApprovalView, type CheckView, type ProjectViewSnapshot, type RunView, type TaskView } from '@selarikru/view-protocol';
import { formatAge } from '@selarikru/ui';

/**
 * Design section 4, highest first, with `blocked` added just above information for block reasons outside the design's list. The view never
 * reorders this; reordering changes the meaning of the queue.
 */
export const ATTENTION_ORDER = ['policy_incident', 'failed_gate', 'decision', 'worker_lost', 'budget_resource', 'blocked', 'information'] as const;
export type AttentionKind = (typeof ATTENTION_ORDER)[number];

export interface AttentionItem {
  readonly id: string;
  readonly kind: AttentionKind;
  /** Refines `decision`: a live request, an expired one, or a run waiting on a human review. */
  readonly status: 'open' | 'expired' | 'review' | null;
  readonly title: string;
  readonly detail: string;
  /** The stable reason code, shown in details. Null when the source gave none. */
  readonly code: string | null;
  /** When this began. */
  readonly since: string;
  readonly affectedTaskIds: readonly string[];
  readonly owner: string;
  /** What happens if nobody acts. */
  readonly consequence: string;
  readonly nextAction: string;
  /** True only when a person has to act. Scheduler-owned waits, closed tasks and updates stay visible but are not counted. */
  readonly needsOperator: boolean;
  /** True when this was evaluated at the last confirmed time because liveness is stale now. */
  readonly asOfLastConfirmed: boolean;
  /** A record about work that has already stopped. It may still need a decision, but it is not blocking anything now. */
  readonly closedRecord: boolean;
  /** The Decisions card a person can act on this from, or null when there is no such card. */
  readonly decisionId: string | null;
}

const CLOSED: readonly TaskView['status'][] = ['superseded', 'cancelled', 'merged', 'verified'];
/** Work that has stopped. A placement block or a stored reason on it says nothing about what is holding anything now. */
export const isClosedTask = (t: Pick<TaskView, 'status'>): boolean => CLOSED.includes(t.status);
export const latestCheckOf = (snapshot: ProjectViewSnapshot, taskId: string): CheckView | undefined => Object.values(snapshot.checks).filter((c) => c.taskId === taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
/** A failed verdict is released back to `ready` for a repair, so a queued task whose latest check failed is still a failed gate. */
export const atFailedGate = (t: Pick<TaskView, 'status'>, latest: CheckView | undefined): boolean => t.status === 'failed' || (t.status === 'ready' && latest?.state === 'failed');
const titleOf = (t: TaskView): string => t.title ?? t.taskId;
export const sentence = (code: string): string => {
  const words = code.replace(/[_:]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const stripPrefix = (code: string): string => code.replace(/^(policy_denied|approval_required):/, '');

/** Plain words for the codes the scheduler and policy engine emit. An unlisted code is spelled out, and the raw code is always in details. */
const EXPLAIN: Readonly<Record<string, string>> = {
  restricted_data_cloud_destination: 'Restricted data may not reach a cloud destination.',
  classification_not_cloud_eligible: 'This task\'s data classification does not allow cloud processing.',
  source_not_cloud_eligible: 'A source for this task is not eligible for cloud processing.',
  source_not_selected: 'A source for this task was not selected for this run.',
  unclassified_source: 'A source for this task has no data classification.',
  missing_policy: 'No policy is set for this project, and missing policy blocks the action.',
  'missing_destination:execution': 'No execution destination is allowed for this task.',
  missing_budget_limit: 'No budget limit is set, and a missing limit blocks the action.',
  'missing_limit:maxConcurrentTotal': 'No concurrency limit is set, and a missing limit blocks the action.',
  concurrency_limit_reached: 'Every coding slot is in use.',
  no_free_slot: 'No eligible slot is free.',
  cloud_start: 'Starting a cloud worker needs your approval.',
  'configured_require_approval:start_cloud_worker': 'Starting a cloud worker needs your approval.',
  execution_conflicts_with_role_pin: 'The task\'s execution setting conflicts with where its role is pinned.',
};

export function explain(code: string): string {
  const bare = stripPrefix(code);
  const known = EXPLAIN[bare];
  if (known) return known;
  const [head, ...rest] = bare.split(':');
  const arg = rest.join(':');
  if (head === 'resource_conflict') return arg ? `Another task holds a resource this one needs (${arg}).` : 'Another task holds a resource this one needs.';
  if (head === 'role_not_mapped') return `The ${arg || 'task\'s'} role is not mapped to a worker location.`;
  if (head === 'location_disabled') return `The ${arg || 'chosen'} location is disabled for this run.`;
  if (head === 'budget') {
    if (arg === 'exceeds_limit') return 'This would exceed the run\'s budget limit.';
    if (arg === 'unknown_cost') return 'The cost of this work cannot be established, so it cannot be checked against the budget.';
    return `The run budget does not allow this: ${sentence(arg).toLowerCase()}.`;
  }
  return `${sentence(bare)}.`;
}

export type BlockClass = 'decision' | 'repair' | 'budget' | 'wait' | 'policy' | 'blocked';

/** `policy` is an allowlist: only a real policy denial or classification denial is called a policy incident. Anything unrecognized is plainly `blocked`. */
export function classifyBlock(code: string): BlockClass {
  if (code.startsWith('approval_required:') || code === 'approval_denied') return 'decision';
  const bare = stripPrefix(code);
  if (bare === 'repair_budget_exhausted' || bare === 'repair_limit_exhausted') return 'repair';
  if (bare === 'concurrency_limit_reached' || bare === 'no_free_slot') return 'wait';
  if (bare.startsWith('budget:') || bare.startsWith('missing_budget') || bare.startsWith('missing_limit:')) return 'budget';
  if (code.startsWith('policy_denied:') || code === 'classification_not_cloud_eligible') return 'policy';
  return 'blocked';
}

const isRestrictedDenial = (code: string): boolean => /restricted|classification_not_cloud|source_not_cloud_eligible/.test(code);

export function dependentsOf(snapshot: ProjectViewSnapshot, rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i += 1) {
    for (const t of Object.values(snapshot.tasks)) {
      if (!out.includes(t.taskId) && t.dependsOn?.includes(out[i]!)) out.push(t.taskId);
    }
  }
  return out;
}

const whoWaits = (affected: readonly string[]): string =>
  affected.length > 1 ? `This task and ${affected.length - 1} that depend on it cannot proceed.` : 'This task cannot proceed.';

type Defaulted = 'status' | 'needsOperator' | 'asOfLastConfirmed' | 'closedRecord' | 'decisionId';
type ItemInput = Omit<AttentionItem, Defaulted> & Partial<Pick<AttentionItem, Defaulted>>;
const make = (i: ItemInput): AttentionItem => ({ status: null, needsOperator: true, asOfLastConfirmed: false, closedRecord: false, decisionId: null, ...i });

/** The Decisions card that handles a task's block, or null when the fix is elsewhere (a limit, a slot, an approval row that does not exist yet). */
export function decisionIdForBlock(task: Pick<TaskView, 'taskId' | 'runId'>, code: string): string | null {
  if (isReverifiableReason(code)) return `reverify:${task.runId}`;
  const klass = classifyBlock(code);
  if (klass === 'policy' || klass === 'repair' || klass === 'blocked' || code === 'approval_denied') return `placement:${task.taskId}`;
  return null;
}

/** True when a recorded acceptance names this budget-stopped task at this revision. */
/** A request's words as a person should read them: a worker's free text is labelled as such, and is never reworded. */
export function requestText(a: Pick<ApprovalView, 'operation' | 'reason'>): string {
  if (a.reason === null) return 'Unspecified request';
  return a.operation !== null && (WORKER_APPROVAL_OPERATIONS as readonly string[]).includes(a.operation) ? `Worker-supplied reason: ${a.reason}` : sentence(a.reason);
}

export const reducedScopeCovers = (run: RunView | undefined, task: Pick<TaskView, 'taskId' | 'revision'>): boolean =>
  run?.reducedScope?.notDelivered.tasks.some((t) => t.taskId === task.taskId && t.revision === task.revision) ?? false;

export function blockItem(task: TaskView, code: string, hit: readonly string[]): AttentionItem {
  const base = { id: `placement:${task.taskId}`, code, since: task.enteredStatusAt, affectedTaskIds: hit, owner: 'You', decisionId: decisionIdForBlock(task, code) };
  const name = titleOf(task);
  switch (classifyBlock(code)) {
    case 'decision': {
      const denied = code === 'approval_denied';
      return make({
        ...base, kind: 'decision', status: 'open', title: `${name}: ${denied ? 'approval was denied' : 'needs your approval to start'}`, detail: denied ? 'A person denied the request, so the task is blocked.' : explain(code),
        consequence: `${whoWaits(hit)} It waits rather than starting without approval.`, nextAction: denied ? 'Change the plan or cancel the task.' : 'Approve or deny the start.',
      });
    }
    case 'repair':
      return make({
        ...base, kind: 'failed_gate', title: `${name}: out of repair attempts`, detail: 'Its repair attempts are used up, so no further attempt will start.',
        consequence: `${whoWaits(hit)} It stays blocked until a person changes the plan.`, nextAction: 'Inspect the failing check, then replan or cancel the task.',
      });
    case 'budget': {
      const exceeds = code.endsWith('budget:exceeds_limit');
      const unknownCost = code.endsWith('budget:unknown_cost');
      return make({
        ...base, kind: 'budget_resource', title: `${name}: cannot start`, detail: explain(code),
        consequence: `${whoWaits(hit)} ${exceeds ? 'It will not start over budget.' : unknownCost ? 'An unknown cost is never treated as zero.' : 'A missing limit is never treated as unlimited.'}`,
        nextAction: exceeds ? 'Request a scoped budget increase or narrow the task.' : unknownCost ? 'Resolve the missing usage figures, then retry.' : 'Set the limit in the run policy.',
      });
    }
    case 'wait':
      return make({
        ...base, kind: 'budget_resource', owner: 'Scheduler', needsOperator: false, title: `${name}: waiting for a slot`, detail: explain(code),
        consequence: 'It starts when a slot frees up.', nextAction: 'No action needed unless you want to add capacity.',
      });
    case 'policy':
      return make({
        ...base, kind: 'policy_incident', title: `${name}: blocked by policy`, detail: explain(code),
        consequence: `${whoWaits(hit)} Nothing is moved around the policy, and there is no bypass.`,
        nextAction: isRestrictedDenial(code) ? 'Run it in a local sandbox with a device model only.' : 'Review the effective policy for this task.',
      });
    case 'blocked': {
      // A resource conflict is raised at integration and nothing unblocks the task afterwards, so it needs a person like the rest.
      const nextAction = code.startsWith('resource_conflict') ? 'Replan or cancel the task once the resource is free.' : code.startsWith('role_not_mapped') ? 'Map this role to a location in the run setup.' : code.startsWith('location_disabled') ? 'Enable the location or pin the task to another one.' : 'Inspect why it is blocked.';
      return make({
        ...base, kind: 'blocked', title: `${name}: blocked`, detail: explain(code), consequence: `${whoWaits(hit)} It stays blocked until a person acts.`, nextAction,
      });
    }
  }
}

/**
 * The attention queue, sorted by design section 4, then longest-waiting first. Time and liveness are parameters. Health is read only through
 * `effectiveWorkerHealth`. When our own liveness is stale, a worker's reading is taken at `lastConfirmedMs` instead and labelled as such,
 * so a loss seen before the outage stays visible and no new one is invented from the outage itself.
 */
export function buildAttention(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, lastConfirmedMs: number | null = null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const live = Object.values(snapshot.tasks).filter((t) => !isClosedTask(t));
  const affected = (t: TaskView): readonly string[] => dependentsOf(snapshot, t.taskId);

  for (const task of live) {
    const blockCode = task.placementBlock ?? (task.status === 'blocked' ? task.statusReason : null);
    // The expiry sweep blocks the task with this reason, and the expired approval below already says so.
    const expiredRequestShown = blockCode === 'approval_expired' && Object.values(snapshot.approvals).some((a) => a.taskId === task.taskId && approvalStateAt(a, nowMs) === 'expired');
    if (blockCode !== null && !expiredRequestShown) items.push(blockItem(task, blockCode, affected(task)));
    const latestCheck = latestCheckOf(snapshot, task.taskId);
    if (atFailedGate(task, latestCheck)) {
      const check = latestCheck?.state === 'failed' ? latestCheck : undefined;
      const hit = affected(task);
      items.push(make({
        id: `gate:${task.taskId}`, kind: 'failed_gate', code: check?.checkId ?? task.statusReason, since: check?.updatedAt ?? task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
        title: `${titleOf(task)}: ${check ? 'check failed' : 'failed'}`, detail: check?.summary ?? (task.statusReason ? sentence(task.statusReason) : 'No reason was reported.'),
        consequence: `${whoWaits(hit)} It cannot reach review until the check passes.`, nextAction: 'Inspect the failing check, then let the repair attempt run.',
      }));
    }
  }

  // A budget stop is on a closed task, so it blocks nothing now. While its run is open the operator still has to choose: fund it or accept reduced scope.
  for (const task of Object.values(snapshot.tasks)) {
    if (!isBudgetStopped(task, snapshot.runs[task.runId])) continue;
    const runState = snapshot.runs[task.runId]?.lifecycle;
    const runOpen = runState !== 'merged' && runState !== 'failed' && runState !== 'cancelled';
    const accepted = reducedScopeCovers(snapshot.runs[task.runId], task);
    items.push(make({
      id: `budget:${task.taskId}`, kind: 'budget_resource', closedRecord: true, needsOperator: runOpen && !accepted, decisionId: runOpen && !accepted ? `scope:${task.runId}` : null, code: 'budget_exhausted', since: task.enteredStatusAt, affectedTaskIds: affected(task), owner: 'You',
      title: `${titleOf(task)}: stopped, budget exhausted`, detail: accepted ? 'The attempt was stopped when its budget ran out, and you accepted the reduced scope.' : 'The attempt was stopped when its budget ran out.',
      consequence: accepted ? 'Its criteria stay listed as not delivered.' : 'Its work so far is preserved, and its criteria stay unmet. It will not resume on its own.', nextAction: accepted ? 'No action needed. It stays listed as not delivered.' : 'Accept the reduced scope, or replan the run.',
    }));
  }

  for (const approval of Object.values(snapshot.approvals)) {
    const state = approvalStateAt(approval, nowMs);
    if (state !== 'pending' && state !== 'expired') continue;
    const task = approval.taskId !== null ? snapshot.tasks[approval.taskId] : undefined;
    if (task && isClosedTask(task)) continue;
    const hit = task ? affected(task) : Object.values(snapshot.tasks).filter((t) => t.runId === approval.runId && !isClosedTask(t)).map((t) => t.taskId);
    const name = task ? titleOf(task) : 'This run';
    const asked = requestText(approval);
    const askedLine = asked.startsWith('Worker-supplied') ? asked : `Request: ${asked}.`;
    const expiresIn = state === 'pending' && approval.expiresAt !== null ? ` Expires in ${formatAge(Date.parse(approval.expiresAt) - nowMs)}.` : '';
    items.push(make(
      state === 'expired'
        ? {
            id: `decision:${approval.approvalId}`, decisionId: `decision:${approval.approvalId}`, kind: 'decision', status: 'expired', code: approval.reason, since: approval.expiresAt ?? approval.requestedAt, affectedTaskIds: hit, owner: 'You',
            title: `${name}: approval expired`, detail: askedLine,
            consequence: 'It stays paused. An expired approval is never treated as granted.', nextAction: 'Request approval again if the task still needs it.',
          }
        : {
            id: `decision:${approval.approvalId}`, decisionId: `decision:${approval.approvalId}`, kind: 'decision', status: 'open', code: approval.reason, since: approval.requestedAt, affectedTaskIds: hit, owner: 'You',
            title: `${name}: needs your decision`, detail: askedLine,
            consequence: `It stays paused until you decide.${expiresIn}`, nextAction: 'Approve or deny the request.',
          },
    ));
  }

  for (const run of Object.values(snapshot.runs)) {
    if (run.lifecycle !== 'ready_for_review') continue;
    const tasks = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId && t.status !== 'superseded' && t.status !== 'cancelled');
    // A cancelled task is undelivered whatever cancelled it; only a budget stop also needs the reduced scope accepted.
    const cancelled = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId && t.status === 'cancelled');
    const stopped = cancelled.filter((t) => isBudgetStopped(t, run));
    const undelivered = cancelled.length > 0 || (run.reducedScope?.notDelivered.tasks.length ?? 0) > 0;
    const stoppedWord = cancelled.length === 1 ? '1 task was' : `${cancelled.length} tasks were`;
    const why = stopped.length === cancelled.length ? 'stopped for budget' : stopped.length === 0 ? 'cancelled' : 'cancelled or stopped for budget';
    const criteria = run.criteria ? `${run.criteria.verified} of ${run.criteria.total} criteria verified at the current revision.` : null;
    const uncovered = stopped.some((t) => !reducedScopeCovers(run, t));
    items.push(make({
      id: `review:${run.runId}`, decisionId: `review:${run.runId}`, kind: 'decision', status: 'review', code: 'ready_for_review', since: run.latestEvidence?.at ?? snapshot.meta.observedAt, affectedTaskIds: tasks.map((t) => t.taskId), owner: 'You',
      title: 'Run is ready for your review',
      // Budget-stopped work never reads as done: this run did not deliver everything it planned.
      detail: undelivered ? `${cancelled.length > 0 ? `${stoppedWord} not delivered: ${why}.` : 'Some planned work was not delivered.'}${criteria ? ` ${criteria}` : ' Not every planned task is verified.'}` : (criteria ?? 'Every task is verified at the current revision. Per-criterion evidence is not connected.'),
      consequence: 'Nothing merges without you. Agents never merge.', nextAction: uncovered ? 'Accept the reduced scope before a pull request can open.' : 'Review the pull request and merge it on GitHub.',
    }));
  }

  for (const worker of Object.values(snapshot.workers)) {
    const current = effectiveWorkerHealth(worker, nowMs, livenessAsOfMs);
    const confirmed = current.health === 'unknown' && lastConfirmedMs !== null ? effectiveWorkerHealth(worker, lastConfirmedMs, lastConfirmedMs) : null;
    const reading = confirmed ?? current;
    const asOfLastConfirmed = confirmed !== null;
    const task = worker.taskId !== null ? snapshot.tasks[worker.taskId] : undefined;
    if (reading.health === 'suspected_stall' && task) {
      const silence = reading.heartbeatAgeMs !== null ? `No heartbeat from ${worker.workerId} for ${formatAge(reading.heartbeatAgeMs)}.` : `No recent heartbeat from ${worker.workerId}.`;
      items.push(make({
        id: `stall:${worker.workerId}`, kind: 'information', needsOperator: false, asOfLastConfirmed, code: 'suspected_stall', since: worker.lastHeartbeatAt ?? worker.enteredStateAt, affectedTaskIds: [task.taskId], owner: 'No one yet',
        title: `${titleOf(task)}: progress may be stalled`, detail: `${silence} It is still connected.`,
        consequence: 'Usually a long build. The task stays running and nothing has failed.', nextAction: 'No action yet. Inspect it if it stays silent.',
      }));
    }
    if ((reading.health === 'disconnected' || reading.health === 'failed') && task && !isClosedTask(task)) {
      const replaced = task.activeAttemptId !== null && task.activeAttemptId !== worker.attemptId;
      const lastSeen = worker.lastHeartbeatAt ?? worker.enteredStateAt;
      if (replaced) {
        items.push(make({
          id: `lost:${worker.workerId}`, kind: 'information', needsOperator: false, asOfLastConfirmed, code: worker.stateReason ?? 'runner_lost', since: lastSeen, affectedTaskIds: [task.taskId], owner: 'Scheduler',
          title: `${titleOf(task)}: moved off a lost runner`, detail: `Runner ${worker.workerId} stopped answering and a new attempt took over.`,
          consequence: 'The earlier attempt was interrupted, and its work is not counted as verified.', nextAction: 'No action needed. Inspect the new attempt if you want detail.',
        }));
      } else {
        items.push(make({
          id: `lost:${worker.workerId}`, kind: 'worker_lost', asOfLastConfirmed, code: reading.health === 'failed' ? (worker.stateReason ?? 'worker_failed') : 'heartbeat_lost', since: lastSeen, affectedTaskIds: affected(task), owner: 'You',
          title: `${titleOf(task)}: ${reading.health === 'failed' ? 'worker failed' : 'connection to its runner lost'}`,
          detail: `Runner ${worker.workerId} is not answering. Its state is shown as last confirmed, and nothing is assumed about the outcome.`,
          consequence: 'If it does not return, the lease expires and the attempt is interrupted. No work is reported as done.', nextAction: 'Inspect the attempt before relaunching anything.',
        }));
      }
    }
    if (worker.activity === 'waiting_resource' && task) {
      items.push(make({
        id: `capacity:${worker.workerId}`, kind: 'budget_resource', needsOperator: false, code: 'waiting_resource', since: worker.enteredStateAt, affectedTaskIds: [task.taskId], owner: 'Scheduler',
        title: `${titleOf(task)}: waiting for capacity`, detail: 'All eligible slots are in use.', consequence: 'It starts when a slot frees up.', nextAction: 'No action needed unless you want to add capacity.',
      }));
    }
  }

  const replanned = Object.values(snapshot.tasks).filter((t) => t.revision > 1 && !isClosedTask(t));
  for (const run of Object.values(snapshot.runs)) {
    if (run.planRevision < 2) continue;
    const mine = replanned.filter((t) => t.runId === run.runId);
    if (mine.length === 0) continue;
    items.push(make({
      id: `plan:${run.runId}`, kind: 'information', needsOperator: false, code: `plan_revision_${run.planRevision}`, since: mine.map((t) => t.enteredStatusAt).sort()[0]!, affectedTaskIds: mine.map((t) => t.taskId), owner: 'Scheduler',
      title: `Plan moved to revision ${run.planRevision}`, detail: `${mine.length} task${mine.length === 1 ? ' was' : 's were'} replanned at the new revision.`,
      consequence: 'Work on the earlier revision is not reused without a new verification.', nextAction: 'Review what changed in the plan.',
    }));
  }

  const rank = (k: AttentionKind): number => ATTENTION_ORDER.indexOf(k);
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}
