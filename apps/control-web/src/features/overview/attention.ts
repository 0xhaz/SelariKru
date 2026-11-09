import { approvalStateAt, effectiveWorkerHealth, type ProjectViewSnapshot, type TaskView } from '@selarikru/view-protocol';
import { formatAge } from '@selarikru/ui';

/** Design section 4, highest first. The view never reorders this list; reordering changes the meaning of the queue. */
export const ATTENTION_ORDER = ['policy_incident', 'failed_gate', 'decision', 'worker_lost', 'budget_resource', 'information'] as const;
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
}

const CLOSED: readonly TaskView['status'][] = ['superseded', 'cancelled', 'merged', 'verified'];
const titleOf = (t: TaskView): string => t.title ?? t.taskId;
const sentence = (code: string): string => {
  const words = code.replace(/[_:]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Plain words for the codes the scheduler and policy engine emit. An unlisted code is spelled out, and the raw code is always in details. */
const EXPLAIN: Readonly<Record<string, string>> = {
  restricted_data_cloud_destination: 'Restricted data may not reach a cloud destination.',
  source_not_cloud_eligible: 'A source for this task is not eligible for cloud processing.',
  source_not_selected: 'A source for this task was not selected for this run.',
  unclassified_source: 'A source for this task has no data classification.',
  missing_policy: 'No policy is set for this project, and missing policy blocks the action.',
  'missing_destination:execution': 'No execution destination is allowed for this task.',
  missing_budget_limit: 'No budget limit is set, and a missing limit blocks the action.',
  'missing_limit:maxConcurrentTotal': 'No concurrency limit is set, and a missing limit blocks the action.',
  concurrency_limit_reached: 'Every coding slot is in use.',
  cloud_start: 'Starting a cloud worker needs your approval.',
  'configured_require_approval:start_cloud_worker': 'Starting a cloud worker needs your approval.',
};
const stripPrefix = (code: string): string => code.replace(/^(policy_denied|approval_required):/, '');
const explain = (code: string): string => EXPLAIN[stripPrefix(code)] ?? `${sentence(stripPrefix(code))}.`;
const isBudgetOrLimit = (code: string): boolean => /budget|missing_limit|concurrency_limit/.test(code);

function dependentsOf(snapshot: ProjectViewSnapshot, rootId: string): string[] {
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

/**
 * The attention queue, sorted by design section 4, then longest-waiting first. Time and liveness are parameters. Health is read only through
 * `effectiveWorkerHealth`, so a stale projection reads as unknown and raises no false loss.
 */
export function buildAttention(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const live = Object.values(snapshot.tasks).filter((t) => !CLOSED.includes(t.status));
  const affected = (t: TaskView): readonly string[] => dependentsOf(snapshot, t.taskId);

  for (const task of live) {
    const blockCode = task.placementBlock ?? (task.status === 'blocked' ? task.statusReason : null);
    if (blockCode !== null) {
      const hit = affected(task);
      if (blockCode.startsWith('approval_required:') || blockCode === 'approval_denied') {
        const denied = blockCode === 'approval_denied';
        items.push({
          id: `placement:${task.taskId}`, kind: 'decision', status: 'open', code: blockCode, since: task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
          title: `${titleOf(task)}: ${denied ? 'approval was denied' : 'needs your approval to start'}`, detail: denied ? 'A person denied the request, so the task is blocked.' : explain(blockCode),
          consequence: `${whoWaits(hit)} It waits rather than starting without approval.`, nextAction: denied ? 'Change the plan or cancel the task.' : 'Approve or deny the start.',
        });
      } else if (isBudgetOrLimit(blockCode)) {
        items.push({
          id: `placement:${task.taskId}`, kind: 'budget_resource', status: null, code: blockCode, since: task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
          title: `${titleOf(task)}: cannot start`, detail: explain(blockCode),
          consequence: `${whoWaits(hit)} A missing limit is never treated as unlimited.`, nextAction: 'Set the limit in the run policy.',
        });
      } else {
        items.push({
          id: `placement:${task.taskId}`, kind: 'policy_incident', status: null, code: blockCode, since: task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
          title: `${titleOf(task)}: blocked by policy`, detail: explain(blockCode),
          consequence: `${whoWaits(hit)} Nothing is moved around the policy, and there is no bypass.`,
          nextAction: blockCode.includes('restricted') ? 'Run it in a local sandbox or reclassify the source.' : 'Review the effective policy for this task.',
        });
      }
    }
    const latestCheck = Object.values(snapshot.checks).filter((c) => c.taskId === task.taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    // A failed verdict is released back to `ready` for a repair, so a queued task whose latest check failed is still a failed gate.
    if (task.status === 'failed' || (task.status === 'ready' && latestCheck?.state === 'failed')) {
      const check = latestCheck?.state === 'failed' ? latestCheck : undefined;
      const hit = affected(task);
      items.push({
        id: `gate:${task.taskId}`, kind: 'failed_gate', status: null, code: check?.checkId ?? task.statusReason, since: check?.updatedAt ?? task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
        title: `${titleOf(task)}: ${check ? 'check failed' : 'failed'}`, detail: check?.summary ?? (task.statusReason ? sentence(task.statusReason) : 'No reason was reported.'),
        consequence: `${whoWaits(hit)} It cannot reach review until the check passes.`, nextAction: 'Inspect the failing check, then let the repair attempt run.',
      });
    }
  }

  // A budget stop is on a closed task, so it is looked up across all tasks.
  for (const task of Object.values(snapshot.tasks)) {
    if (task.status !== 'cancelled' || task.cancelReason !== 'budget_exhausted') continue;
    const hit = affected(task);
    items.push({
      id: `budget:${task.taskId}`, kind: 'budget_resource', status: null, code: 'budget_exhausted', since: task.enteredStatusAt, affectedTaskIds: hit, owner: 'You',
      title: `${titleOf(task)}: stopped, budget exhausted`, detail: 'The attempt was stopped when its budget ran out.',
      consequence: 'Its work so far is preserved. It will not resume on its own.', nextAction: 'Request a scoped budget increase.',
    });
  }

  for (const approval of Object.values(snapshot.approvals)) {
    const state = approvalStateAt(approval, nowMs);
    if (state !== 'pending' && state !== 'expired') continue;
    const task = approval.taskId !== null ? snapshot.tasks[approval.taskId] : undefined;
    if (task && CLOSED.includes(task.status)) continue;
    const hit = task ? affected(task) : Object.values(snapshot.tasks).filter((t) => t.runId === approval.runId && !CLOSED.includes(t.status)).map((t) => t.taskId);
    const name = task ? titleOf(task) : 'This run';
    const asked = approval.reason ? sentence(approval.reason) : 'Unspecified request';
    const expiresIn = state === 'pending' && approval.expiresAt !== null ? ` Expires in ${formatAge(Date.parse(approval.expiresAt) - nowMs)}.` : '';
    items.push(
      state === 'expired'
        ? {
            id: `decision:${approval.approvalId}`, kind: 'decision', status: 'expired', code: approval.reason, since: approval.expiresAt ?? approval.requestedAt, affectedTaskIds: hit, owner: 'You',
            title: `${name}: approval expired`, detail: `Request: ${asked}.`,
            consequence: 'It stays paused. An expired approval is never treated as granted.', nextAction: 'Request approval again if the task still needs it.',
          }
        : {
            id: `decision:${approval.approvalId}`, kind: 'decision', status: 'open', code: approval.reason, since: approval.requestedAt, affectedTaskIds: hit, owner: 'You',
            title: `${name}: needs your decision`, detail: `Request: ${asked}.`,
            consequence: `It stays paused until you decide.${expiresIn}`, nextAction: 'Approve or deny the request.',
          },
    );
  }

  for (const run of Object.values(snapshot.runs)) {
    if (run.lifecycle !== 'ready_for_review') continue;
    const tasks = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId && t.status !== 'superseded' && t.status !== 'cancelled');
    items.push({
      id: `review:${run.runId}`, kind: 'decision', status: 'review', code: 'ready_for_review', since: run.latestEvidence?.at ?? snapshot.meta.observedAt, affectedTaskIds: tasks.map((t) => t.taskId), owner: 'You',
      title: 'Run is ready for your review', detail: 'Every criterion is verified at the current revision.',
      consequence: 'Nothing merges without you. Agents never merge.', nextAction: 'Review the pull request and merge it on GitHub.',
    });
  }

  for (const worker of Object.values(snapshot.workers)) {
    const reading = effectiveWorkerHealth(worker, nowMs, livenessAsOfMs);
    const task = worker.taskId !== null ? snapshot.tasks[worker.taskId] : undefined;
    if (reading.health === 'suspected_stall' && task) {
      items.push({
        id: `stall:${worker.workerId}`, kind: 'information', status: null, code: 'suspected_stall', since: worker.lastHeartbeatAt ?? worker.enteredStateAt, affectedTaskIds: [task.taskId], owner: 'No one yet',
        title: `${titleOf(task)}: progress may be stalled`, detail: `No heartbeat from ${worker.workerId} for ${formatAge(reading.heartbeatAgeMs ?? 0)}. It is still connected.`,
        consequence: 'Usually a long build. The task stays running and nothing has failed.', nextAction: 'No action yet. Inspect it if it stays silent.',
      });
    }
    if ((reading.health === 'disconnected' || reading.health === 'failed') && task && !CLOSED.includes(task.status)) {
      const replaced = task.activeAttemptId !== null && task.activeAttemptId !== worker.attemptId;
      const lastSeen = worker.lastHeartbeatAt ?? worker.enteredStateAt;
      if (replaced) {
        items.push({
          id: `lost:${worker.workerId}`, kind: 'information', status: null, code: worker.stateReason ?? 'runner_lost', since: lastSeen, affectedTaskIds: [task.taskId], owner: 'Scheduler',
          title: `${titleOf(task)}: moved off a lost runner`, detail: `Runner ${worker.workerId} stopped answering and a new attempt took over.`,
          consequence: 'The earlier attempt was interrupted, and its work is not counted as verified.', nextAction: 'No action needed. Inspect the new attempt if you want detail.',
        });
      } else {
        items.push({
          id: `lost:${worker.workerId}`, kind: 'worker_lost', status: null, code: reading.health === 'failed' ? (worker.stateReason ?? 'worker_failed') : 'heartbeat_lost', since: lastSeen, affectedTaskIds: affected(task), owner: 'You',
          title: `${titleOf(task)}: ${reading.health === 'failed' ? 'worker failed' : 'connection to its runner lost'}`,
          detail: `Runner ${worker.workerId} is not answering. Its state is shown as last confirmed, and nothing is assumed about the outcome.`,
          consequence: 'If it does not return, the lease expires and the attempt is interrupted. No work is reported as done.', nextAction: 'Inspect the attempt before relaunching anything.',
        });
      }
    }
    if (worker.activity === 'waiting_resource' && task) {
      items.push({
        id: `capacity:${worker.workerId}`, kind: 'budget_resource', status: null, code: 'waiting_resource', since: worker.enteredStateAt, affectedTaskIds: [task.taskId], owner: 'Scheduler',
        title: `${titleOf(task)}: waiting for capacity`, detail: 'All eligible slots are in use.', consequence: 'It starts when a slot frees up.', nextAction: 'No action needed unless you want to add capacity.',
      });
    }
  }

  const replanned = Object.values(snapshot.tasks).filter((t) => t.revision > 1 && !CLOSED.includes(t.status));
  for (const run of Object.values(snapshot.runs)) {
    if (run.planRevision < 2) continue;
    const mine = replanned.filter((t) => t.runId === run.runId);
    if (mine.length === 0) continue;
    items.push({
      id: `plan:${run.runId}`, kind: 'information', status: null, code: `plan_revision_${run.planRevision}`, since: mine.map((t) => t.enteredStatusAt).sort()[0]!, affectedTaskIds: mine.map((t) => t.taskId), owner: 'Scheduler',
      title: `Plan moved to revision ${run.planRevision}`, detail: `${mine.length} task${mine.length === 1 ? ' was' : 's were'} replanned at the new revision.`,
      consequence: 'Work on the earlier revision is not reused without a new verification.', nextAction: 'Review what changed in the plan.',
    });
  }

  const rank = (k: AttentionKind): number => ATTENTION_ORDER.indexOf(k);
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}
