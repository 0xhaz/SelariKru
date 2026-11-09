import { ADVISORY_APPROVAL_OPERATIONS, WORKER_APPROVAL_OPERATIONS, approvalUnavailableReason } from '@selarikru/domain';
import { approvalStateAt, isEmptyProject, isReverifiableReason, type ApprovalView, type AuthorizedViewCommand, type ChangeRequestView, type ProjectViewSnapshot, type RunView, type TaskView } from '@selarikru/view-protocol';
import { formatAge, type Tone } from '@selarikru/ui';
import { blockItem, classifyBlock, decisionIdForBlock, dependentsOf, explain, isClosedTask, reducedScopeCovers, sentence } from '../overview/attention.ts';
import { hrefFor } from '../../shell/route.ts';
import type { ConnectionState } from '../../shell/projection-store.ts';

export type CardKind = 'approval' | 'policy_deny' | 'budget_stop' | 'blocked' | 'reverify' | 'merge_review' | 'reconciliation';
export type CardState = 'open' | 'changed' | 'expired';
export type ActionStyle = 'primary' | 'quiet' | 'danger';

export interface ConfirmCopy {
  readonly title: string;
  /** What becomes true and cannot be taken back. */
  readonly consequence: string;
  readonly keepLabel: string;
}

export type CommandIntent = Omit<AuthorizedViewCommand, 'idempotencyKey'>;

interface ActionBase {
  readonly id: string;
  readonly label: string;
  readonly style: ActionStyle;
  /** Non-null means the control is off, and this sentence says why. */
  readonly disabledReason: string | null;
}
export type DecisionAction =
  | (ActionBase & { readonly kind: 'command'; readonly intent: CommandIntent; readonly confirm: ConfirmCopy | null })
  | (ActionBase & { readonly kind: 'link'; readonly href: string; readonly external: boolean });

export interface Fact { readonly label: string; readonly value: string; readonly mono?: boolean }
export interface NotDeliveredModel {
  readonly tasks: readonly { readonly taskId: string; readonly title: string; readonly status: string; readonly budgetStopped: boolean }[];
  readonly requirementIds: readonly string[];
  readonly acceptanceCheckIds: readonly string[];
}

export interface DecisionCardModel {
  readonly id: string;
  readonly kind: CardKind;
  readonly chip: string;
  readonly tone: Tone;
  readonly state: CardState;
  readonly title: string;
  readonly summary: string;
  readonly consequence: string;
  /** Null when the request says nothing. `source` keeps worker claims apart from what policy reports. */
  readonly reason: { readonly label: string; readonly text: string; readonly source: 'worker' | 'policy' } | null;
  readonly advisory: string | null;
  /** Why a decision a person might expect is not offered. */
  readonly note: string | null;
  readonly facts: readonly Fact[];
  readonly details: readonly Fact[];
  readonly notDelivered: NotDeliveredModel | null;
  readonly changed: { readonly title: string; readonly body: string } | null;
  readonly actions: readonly DecisionAction[];
  readonly since: string;
  /** Changes when anything a person relied on changes; a clock tick does not. */
  readonly fingerprint: string;
}

export interface HistoryEntry {
  readonly id: string;
  readonly outcome: string;
  readonly subject: string;
  readonly at: string;
  readonly tone: Tone;
}

export interface DecisionsModel {
  readonly cards: readonly DecisionCardModel[];
  readonly history: readonly HistoryEntry[];
  readonly waiting: number;
  /** Non-null means no command can be sent now, and says why. */
  readonly paused: string | null;
  readonly empty: boolean;
  readonly simulated: boolean;
}

export interface DecisionOptions {
  readonly mode: 'mock' | 'live';
  readonly connection: ConnectionState;
}

const PAUSE: Readonly<Record<Exclude<ConnectionState, 'live'>, string>> = {
  reconnecting: 'Decisions are off while the connection comes back, so nothing is decided on stale state. Nothing is queued.',
  dead: 'Decisions are off because the event stream stopped. Restart the session to decide on current state.',
  connecting: 'Decisions turn on once the first snapshot arrives.',
  unavailable: 'Decisions are off because no project data is connected.',
};

const titleOf = (t: TaskView): string => t.title ?? t.taskId;
const short = (sha: string): string => sha.slice(0, 7);
const WORKER_OPS: readonly string[] = WORKER_APPROVAL_OPERATIONS;
const ADVISORY_OPS: readonly string[] = ADVISORY_APPROVAL_OPERATIONS;
const STATUS_WORD: Readonly<Record<string, string>> = { planned: 'Planned', ready: 'Queued', running: 'Running', awaiting_approval: 'Awaiting approval', blocked: 'Blocked', verifying: 'Verifying', failed: 'Failed', cancelled: 'Stopped' };

interface OpCopy { readonly title: (name: string, destination: string | null) => string; readonly grant: string | null; readonly consequence: string }
const OPERATION: Readonly<Record<string, OpCopy>> = {
  start_cloud_worker: { title: (n) => `Start "${n}" in a cloud sandbox`, grant: 'Grant cloud start', consequence: 'A grant lets the scheduler start this task in a cloud sandbox once a slot is free.' },
  repair_within_limits: { title: (n) => `Run one more repair attempt for "${n}"`, grant: 'Grant repair attempt', consequence: 'A grant lets the scheduler run one more repair attempt within the repair limits.' },
  breaking_api_change: { title: (n) => `Breaking API change in "${n}"`, grant: 'Record approval of breaking API change', consequence: 'A worker wants to make a breaking change to a public API.' },
  destructive_data_migration: { title: (n) => `Destructive data migration in "${n}"`, grant: 'Record approval of destructive migration', consequence: 'A worker wants to run a migration that destroys or rewrites data.' },
  new_domain: { title: (n, d) => `Allow "${n}" to reach ${d ?? 'a new domain'}`, grant: null, consequence: 'A worker wants network access to a new domain.' },
  new_connector: { title: (n, d) => `Allow "${n}" to use the connector ${d ?? ''}`.trimEnd(), grant: null, consequence: 'A worker wants access to a new connector.' },
  scope_change: { title: (n) => `Change the scope of "${n}"`, grant: null, consequence: 'A worker wants to work outside its task scope.' },
  broader_scope: { title: (n) => `Broaden the scope of "${n}"`, grant: null, consequence: 'A worker wants a wider scope.' },
};

const ADVISORY_TEXT = 'This approval is a recorded human pause. A grant records your decision and tells the worker, and the pull request lists it for the reviewer. It does not check or limit what the worker then changes.';
const WORKER_REASON = 'Reason given by the worker (worker-supplied, not verified)';
const REPLAN_OFF = 'Replanning runs through the Assistant, which is off under demo data.';
const CANCEL_CONSEQUENCE = 'It stops for good. Work so far stays on record, but it only runs again through a new plan revision.';

function replanAction(mode: DecisionOptions['mode'], paused: string | null): DecisionAction {
  const disabledReason = mode === 'mock' ? REPLAN_OFF : paused;
  return { kind: 'link', id: 'replan', label: 'Replan in the Assistant', style: 'quiet', href: hrefFor('assistant'), external: false, disabledReason };
}

function cancelAction(t: TaskView, paused: string | null, label = 'Cancel task'): DecisionAction {
  return {
    kind: 'command', id: `cancel:${t.taskId}`, label, style: 'danger', disabledReason: paused,
    intent: { command: 'task.cancel', expectedRevision: t.aggregateRevision, args: { taskId: t.taskId } },
    confirm: { title: `Cancel "${titleOf(t)}"?`, consequence: CANCEL_CONSEQUENCE, keepLabel: 'Keep the task' },
  };
}

const openCancel = (t: TaskView, paused: string | null): readonly DecisionAction[] => (isClosedTask(t) ? [] : [cancelAction(t, paused)]);

function githubLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

function prLink(cr: ChangeRequestView, mode: DecisionOptions['mode'], simulated: boolean): DecisionAction {
  const href = githubLink(cr.url);
  const disabledReason = mode === 'mock' || simulated ? 'Demo data: this pull request is simulated, so there is nothing to open on GitHub.' : href === null ? 'This pull request has no valid GitHub link.' : null;
  return { kind: 'link', id: 'github', label: `Open pull request #${cr.prNumber} on GitHub`, style: 'primary', href: href ?? cr.url, external: true, disabledReason };
}

function approvalCard(a: ApprovalView, snapshot: ProjectViewSnapshot, nowMs: number, options: DecisionOptions, paused: string | null): DecisionCardModel | null {
  const display = approvalStateAt(a, nowMs);
  if (display !== 'pending' && display !== 'expired') return null;
  const task = a.taskId !== null ? snapshot.tasks[a.taskId] : undefined;
  if (task && isClosedTask(task)) return null;
  const name = task ? titleOf(task) : 'this run';
  const op = a.operation !== null ? OPERATION[a.operation] : undefined;
  const expired = display === 'expired';
  const movedRevision = task !== undefined && a.taskRevision !== null && a.taskRevision !== task.revision;
  const notWaiting = task !== undefined && !expired && task.status !== 'awaiting_approval';
  const changed = movedRevision
    ? { title: 'This request changed', body: `The plan moved this task to revision ${task.revision}. This request was made for revision ${a.taskRevision}, so it stays pending and cannot be decided as it stands.` }
    : notWaiting
      ? { title: 'This request changed', body: `This task is no longer waiting on this request (it is now ${STATUS_WORD[task.status] ?? task.status}). It stays pending and cannot be decided as it stands.` }
      : null;
  const changedReason = changed ? 'This request changed. Review the updated task before deciding.' : null;
  const blockedReason = paused ?? changedReason;

  const unavailable = a.operation !== null ? approvalUnavailableReason(a.operation) : null;
  const note = a.operation === null
    ? 'This request names no operation, so policy cannot judge it and it cannot be granted.'
    : unavailable === 'egress_enforcement_unavailable'
      ? 'A network grant cannot take effect yet: this sandbox cannot limit egress to one host.'
      : unavailable === 'scope_grant_unavailable'
        ? 'A scope grant cannot take effect yet: nothing can widen a task\'s allowed paths.'
        : null;

  const actions: DecisionAction[] = [];
  const scopeHash = a.scopeHash ?? a.approvalId;
  if (!expired && note === null && a.operation !== null) {
    const advisory = ADVISORY_OPS.includes(a.operation);
    const label = op?.grant ?? `Grant ${sentence(a.operation).toLowerCase()}`;
    actions.push({
      kind: 'command', id: 'grant', label, style: 'primary', disabledReason: blockedReason,
      intent: { command: 'approval.grant', expectedRevision: task?.aggregateRevision ?? 0, args: { approvalId: a.approvalId, scopeHash } },
      confirm: advisory ? { title: `${label} for "${name}"?`, consequence: 'This records your approval and tells the worker. It does not check or limit what the worker then changes, so review the pull request yourself before merging.', keepLabel: 'Keep pending' } : null,
    });
  }
  const swept = expired && task?.status !== 'awaiting_approval';
  const denyLabel = swept || task === undefined ? 'Record denial' : 'Deny and block task';
  actions.push({
    kind: 'command', id: 'deny', label: denyLabel, style: 'danger', disabledReason: blockedReason,
    intent: { command: 'approval.deny', expectedRevision: task?.aggregateRevision ?? 0, args: { approvalId: a.approvalId, scopeHash } },
    confirm: { title: `${denyLabel} for "${name}"?`, consequence: swept ? 'The denial is recorded and the task stays blocked. It only continues through a new plan revision.' : 'The task moves to blocked. It only continues through a new plan revision.', keepLabel: 'Keep pending' },
  });
  if (task) {
    actions.push(...(changed ? [{ kind: 'link', id: 'review-task', label: 'Review the updated task', style: 'quiet', href: `${hrefFor('pipeline')}?task=${encodeURIComponent(task.taskId)}`, external: false, disabledReason: null } as DecisionAction] : []));
    if (expired) actions.push(replanAction(options.mode, paused), ...openCancel(task, paused));
  }

  const hit = task ? dependentsOf(snapshot, task.taskId) : Object.values(snapshot.tasks).filter((t) => t.runId === a.runId && !isClosedTask(t)).map((t) => t.taskId);
  const affected = hit.map((id) => snapshot.tasks[id]?.title ?? id).join(', ');
  const isWorker = a.operation !== null && WORKER_OPS.includes(a.operation);
  const reason = a.reason === null ? null : isWorker ? { label: WORKER_REASON, text: a.reason, source: 'worker' as const } : { label: 'Why policy asks', text: explain(a.reason), source: 'policy' as const };
  const expiry = a.expiresAt !== null ? (expired ? `${formatAge(nowMs - Date.parse(a.expiresAt))} ago` : `in ${formatAge(Date.parse(a.expiresAt) - nowMs)}`) : 'No expiry recorded';
  const facts: Fact[] = [
    ...(a.destination !== null ? [{ label: 'Destination', value: a.destination, mono: true }] : []),
    { label: 'Task', value: task ? `${name}, revision ${a.taskRevision ?? task.revision}${movedRevision ? ` (the task is now at revision ${task.revision})` : ''}` : 'This run' },
    { label: 'Project', value: snapshot.meta.projectId, mono: true },
    { label: 'Affected tasks', value: affected || 'None recorded' },
    { label: 'Policy result', value: changed ? 'Out of date; policy rechecks an updated request' : expired ? 'Expired; it can only be denied' : 'Requires your approval' },
    { label: 'Approver', value: 'You, the project owner' },
    { label: expired ? 'Expired' : 'Expires', value: expiry },
  ];
  return {
    id: `decision:${a.approvalId}`, kind: 'approval', chip: expired ? 'Expired approval' : 'Approval', tone: expired ? 'danger' : 'warning', state: changed ? 'changed' : expired ? 'expired' : 'open',
    title: op?.title(name, a.destination) ?? `${sentence(a.reason ?? a.operation ?? 'Unspecified request')} (${name})`,
    summary: op?.consequence ?? 'A worker asked for something a person must decide.',
    consequence: expired ? 'It stays paused. An expired approval is never treated as granted.' : `It stays paused until you decide.${a.expiresAt !== null ? ` Expires ${expiry}.` : ''}`,
    reason, advisory: a.operation !== null && ADVISORY_OPS.includes(a.operation) ? ADVISORY_TEXT : null, note, facts, notDelivered: null, changed, actions, since: a.requestedAt,
    details: [
      { label: 'Approval ID', value: a.approvalId }, { label: 'Scope hash', value: a.scopeHash ?? 'Not recorded' }, { label: 'Operation', value: a.operation ?? 'None' },
      { label: 'Reason code', value: a.reason ?? 'None' }, { label: 'Task revision', value: String(a.taskRevision ?? 'none') }, { label: 'Expected revision', value: String(task?.aggregateRevision ?? 0) },
    ],
    fingerprint: ['apr', a.scopeHash, a.taskRevision, task?.revision, task?.aggregateRevision, task?.status, a.operation, a.destination, a.state].join('|'),
  };
}

function blockCards(snapshot: ProjectViewSnapshot, nowMs: number, options: DecisionOptions, paused: string | null): DecisionCardModel[] {
  const out: DecisionCardModel[] = [];
  const reverify = new Map<string, TaskView[]>();
  for (const task of Object.values(snapshot.tasks)) {
    if (isClosedTask(task)) continue;
    const code = task.placementBlock ?? (task.status === 'blocked' ? task.statusReason : null);
    if (code === null) continue;
    if (isReverifiableReason(code)) {
      reverify.set(task.runId, [...(reverify.get(task.runId) ?? []), task]);
      continue;
    }
    if (code === 'approval_expired' && Object.values(snapshot.approvals).some((a) => a.taskId === task.taskId && approvalStateAt(a, nowMs) === 'expired')) continue;
    if (decisionIdForBlock(task, code) === null) continue;
    const hit = dependentsOf(snapshot, task.taskId);
    const item = blockItem(task, code, hit);
    const policy = classifyBlock(code) === 'policy';
    const actions: DecisionAction[] = [replanAction(options.mode, paused), ...openCancel(task, paused)];
    out.push({
      id: `placement:${task.taskId}`, kind: policy ? 'policy_deny' : 'blocked', chip: policy ? 'Policy denied' : code === 'approval_denied' ? 'Denied' : 'Blocked', tone: policy ? 'danger' : 'warning', state: 'open',
      title: policy ? `${titleOf(task)}: denied by policy` : item.title, summary: item.detail, consequence: item.consequence, reason: null, advisory: null,
      note: policy ? `No approval can override this policy denial. ${item.nextAction}` : null,
      facts: [{ label: 'Task', value: `${titleOf(task)}, revision ${task.revision}` }, { label: 'Status', value: STATUS_WORD[task.status] ?? task.status }, { label: 'Next', value: item.nextAction }],
      details: [{ label: 'Reason code', value: code }, { label: 'Task ID', value: task.taskId }, { label: 'Expected revision', value: String(task.aggregateRevision) }], notDelivered: null, changed: null, actions, since: task.enteredStatusAt,
      fingerprint: ['block', code, task.revision, task.aggregateRevision, task.status].join('|'),
    });
  }
  for (const [runId, tasks] of reverify) {
    const run = snapshot.runs[runId];
    const expected = run?.planRevision ?? 0;
    const names = tasks.map(titleOf).join(', ');
    const actions: DecisionAction[] = [
      { kind: 'command', id: 'reverify', label: 'Re-verify the run', style: 'primary', disabledReason: paused, intent: { command: 'run.reverify', expectedRevision: expected, args: { runId } }, confirm: null },
      replanAction(options.mode, paused),
      ...tasks.flatMap((t) => (tasks.length > 1 ? [cancelAction(t, paused, `Cancel "${titleOf(t)}"`)] : [cancelAction(t, paused)])),
    ];
    const codes = tasks.map((t) => t.statusReason ?? 'unknown').join(', ');
    const allAssembly = tasks.every((t) => t.statusReason?.startsWith('assembly_infrastructure:'));
    out.push({
      id: `reverify:${runId}`, kind: 'reverify', chip: allAssembly ? 'Assembly failed' : 'Verification failed', tone: 'warning', state: 'open',
      title: `${names}: verification could not finish`, summary: allAssembly ? 'The assembly step could not build a candidate, so nothing was verified.' : 'The verifier could not reach a verdict. This is an infrastructure failure, not a failed check.',
      consequence: 'It stays blocked. Finished work is not lost, and no worker needs to redo it.', reason: null, advisory: null, note: 'Re-verifying sends the finished work back without running a worker. It is limited per task revision.',
      facts: [{ label: 'Tasks', value: names }, { label: 'Plan revision', value: String(expected) }], details: [{ label: 'Reason codes', value: codes }, { label: 'Run ID', value: runId }], notDelivered: null, changed: null, actions,
      since: tasks.map((t) => t.enteredStatusAt).sort()[0]!, fingerprint: ['reverify', expected, codes, tasks.map((t) => `${t.taskId}:${t.aggregateRevision}`).join(',')].join('|'),
    });
  }
  return out;
}

function budgetCard(run: RunView, snapshot: ProjectViewSnapshot, options: DecisionOptions, paused: string | null): DecisionCardModel | null {
  if (run.lifecycle === 'merged' || run.lifecycle === 'failed' || run.lifecycle === 'cancelled') return null;
  const tasks = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId);
  const stopped = tasks.filter((t) => t.status === 'cancelled' && t.cancelReason === 'budget_exhausted');
  if (stopped.length === 0 || stopped.every((t) => reducedScopeCovers(run, t))) return null;
  const assessment = run.scopeAssessment;
  const titleById = (id: string): string => snapshot.tasks[id]?.title ?? id;
  const notDelivered: NotDeliveredModel | null = assessment
    ? { tasks: assessment.notDelivered.tasks.map((t) => ({ taskId: t.taskId, title: titleById(t.taskId), status: STATUS_WORD[t.status] ?? sentence(t.status), budgetStopped: t.budgetStopped })), requirementIds: assessment.notDelivered.requirementIds, acceptanceCheckIds: assessment.notDelivered.acceptanceCheckIds }
    : null;
  const stoppingNow = assessment !== null && assessment.stoppingTaskIds.length > 0;
  const n = notDelivered?.tasks.length ?? 0;
  const acceptOff = paused ?? (notDelivered === null ? 'What was not delivered is not known yet, so this cannot be accepted.' : stoppingNow ? 'A budget stop is still stopping work, so the final scope is not known yet.' : null);
  const reqs = notDelivered ? `, ${notDelivered.requirementIds.length} requirement${notDelivered.requirementIds.length === 1 ? '' : 's'}` : '';
  const actions: DecisionAction[] = [
    {
      kind: 'command', id: 'accept', label: 'Accept reduced scope', style: 'primary', disabledReason: acceptOff,
      intent: { command: 'run.accept_reduced_scope', expectedRevision: run.planRevision, args: { runId: run.runId } },
      confirm: { title: 'Accept this run at reduced scope?', consequence: `${n} task${n === 1 ? '' : 's'}${reqs} will be recorded as not delivered. A pull request can then open without them. This cannot be undone.`, keepLabel: 'Keep deciding' },
    },
    replanAction(options.mode, paused),
    ...tasks.filter((t) => !isClosedTask(t)).map((t) => cancelAction(t, paused, `Cancel "${titleOf(t)}"`)),
  ];
  const stoppedNames = stopped.map(titleOf).join(', ');
  return {
    id: `scope:${run.runId}`, kind: 'budget_stop', chip: 'Budget stop', tone: 'warning', state: 'open', title: 'The budget ran out before this run finished',
    summary: `${stoppedNames} ${stopped.length === 1 ? 'was' : 'were'} stopped. Work so far is preserved, and the stopped work stays unmet.`,
    consequence: 'Nothing resumes on its own, and no pull request can open until you decide.', reason: null, advisory: null, note: null, facts: [{ label: 'Plan revision', value: String(run.planRevision) }, { label: 'Delivered requirements', value: assessment ? (assessment.deliveredRequirementIds.join(', ') || 'None') : 'Not known yet' }],
    details: [{ label: 'Run ID', value: run.runId }, { label: 'Expected plan revision', value: String(run.planRevision) }], notDelivered, changed: null, actions, since: stopped.map((t) => t.enteredStatusAt).sort()[0]!,
    fingerprint: ['scope', run.planRevision, JSON.stringify(assessment), JSON.stringify(run.reducedScope?.decisionId)].join('|'),
  };
}

const openPrAction = (run: RunView, paused: string | null, uncovered: boolean): DecisionAction => ({
  kind: 'command', id: 'open-pr', label: 'Open draft pull request', style: 'primary', disabledReason: paused ?? (uncovered ? 'Accept the reduced scope first: a pull request cannot open while budget-stopped work is undecided.' : null),
  intent: { command: 'run.open_pull_request', expectedRevision: run.planRevision, args: { runId: run.runId } }, confirm: null,
});

function changeCards(run: RunView, snapshot: ProjectViewSnapshot, options: DecisionOptions, paused: string | null): DecisionCardModel[] {
  const cr = snapshot.changeRequests.find((c) => c.runId === run.runId);
  const simulated = snapshot.meta.provenance === 'simulated';
  const tasks = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId);
  const stopped = tasks.filter((t) => t.status === 'cancelled' && t.cancelReason === 'budget_exhausted');
  const uncovered = stopped.some((t) => !reducedScopeCovers(run, t));
  const scopeNote = run.reducedScope ? `Accepted at reduced scope: ${run.reducedScope.notDelivered.tasks.length} planned task${run.reducedScope.notDelivered.tasks.length === 1 ? ' is' : 's are'} not delivered.` : uncovered ? 'Some planned work was stopped for budget and is not delivered.' : null;
  const evidence = run.criteria ? `${run.criteria.verified} of ${run.criteria.total} criteria verified at the current revision` : `${tasks.filter((t) => t.status === 'verified' || t.status === 'merged').length} of ${tasks.filter((t) => t.status !== 'superseded').length} tasks verified; per-criterion evidence is not connected`;
  const base = { state: 'open' as const, reason: null, advisory: null, notDelivered: null, changed: null };

  if (cr && (cr.status === 'merged_sha_mismatch' || cr.status === 'stale_candidate')) {
    const mismatch = cr.status === 'merged_sha_mismatch';
    return [{
      ...base, id: `review:${run.runId}`, kind: 'reconciliation', chip: mismatch ? 'Merge not recorded' : 'Stale pull request', tone: mismatch ? 'danger' : 'warning',
      title: mismatch ? `Pull request #${cr.prNumber} does not match what was verified` : `Pull request #${cr.prNumber} no longer matches the run's candidate`,
      summary: mismatch ? 'GitHub reports a merge, but its head or base is not the commit SelariKru verified. No merge is recorded, and no task counts as merged.' : 'The candidate this pull request carries is no longer the run\'s current one. Whatever happens to it is not recorded for this run.',
      consequence: mismatch ? 'The run stays unmerged here until someone reconciles it on GitHub.' : 'Merging it would ship a commit nothing verified against the current run.',
      note: mismatch ? 'Check what was merged on GitHub. SelariKru cannot change a merge.' : null,
      facts: [{ label: 'Status', value: mismatch ? 'Merged commit is not the verified commit' : 'Candidate is stale' }, { label: 'Verified candidate', value: short(cr.candidateSha), mono: true }, { label: 'GitHub head', value: cr.observedHeadSha ? short(cr.observedHeadSha) : 'Not reported', mono: true }, { label: 'Merge commit', value: cr.mergeCommitSha ? short(cr.mergeCommitSha) : 'Not reported', mono: true }],
      details: [{ label: 'Verified candidate', value: cr.candidateSha }, { label: 'GitHub head', value: cr.observedHeadSha ?? 'None' }, { label: 'Merge commit', value: cr.mergeCommitSha ?? 'None' }, { label: 'Provider status', value: cr.status }, { label: 'Base ref', value: cr.baseRef }],
      actions: [prLink(cr, options.mode, simulated), ...(!mismatch ? [openPrAction(run, paused, uncovered)] : [])], since: cr.observedAt ?? snapshot.meta.observedAt,
      fingerprint: ['recon', cr.status, cr.observedHeadSha, cr.mergeCommitSha, cr.candidateSha].join('|'),
    }];
  }
  if (run.lifecycle !== 'ready_for_review') return [];
  if (cr && cr.status === 'open') {
    return [{
      ...base, id: `review:${run.runId}`, kind: 'merge_review', chip: 'Merge readiness', tone: 'success', title: `Pull request #${cr.prNumber} is ready for your review`,
      summary: `${evidence}.${scopeNote ? ` ${scopeNote}` : ''}`, consequence: 'It waits on GitHub. Agents never merge, and nothing here merges for you.', note: 'Merging is a human action on GitHub.',
      facts: [{ label: 'Target branch', value: cr.baseRef, mono: true }, { label: 'Candidate', value: short(cr.candidateSha), mono: true }, { label: 'Evidence', value: evidence }],
      details: [{ label: 'Candidate', value: cr.candidateSha }, { label: 'Pull request URL', value: cr.url }, { label: 'Provider status', value: cr.status }],
      actions: [prLink(cr, options.mode, simulated)], since: run.latestEvidence?.at ?? snapshot.meta.observedAt, fingerprint: ['review', cr.status, cr.candidateSha, cr.url].join('|'),
    }];
  }
  if (cr && cr.status === 'merged') return [];
  return [{
    ...base, id: `review:${run.runId}`, kind: 'merge_review', chip: 'Merge readiness', tone: uncovered ? 'warning' : 'success', title: cr ? `Pull request #${cr.prNumber} was closed; open a new one` : 'The run is ready for review, with no pull request yet',
    summary: `${evidence}.${scopeNote ? ` ${scopeNote}` : ''}`, consequence: 'Nothing is proposed for review until a draft pull request is opened. Agents never merge.', note: 'A draft pull request is opened from the verified candidate; merging it stays on GitHub.',
    facts: [{ label: 'Evidence', value: evidence }], details: [{ label: 'Run ID', value: run.runId }], actions: [openPrAction(run, paused, uncovered)], since: run.latestEvidence?.at ?? snapshot.meta.observedAt, fingerprint: ['review-none', cr?.status ?? 'none', uncovered, run.planRevision].join('|'),
  }];
}

const RANK: Readonly<Record<CardKind, number>> = { policy_deny: 0, reconciliation: 1, approval: 2, budget_stop: 3, blocked: 4, reverify: 4, merge_review: 5 };

/**
 * The Decisions queue, in design section 4's order with live requests before expired ones. Every button states its outcome; a card can only offer what the
 * server would accept. Commands carry the revision the card was built from, so the server can recheck it. Time is a parameter.
 */
export function buildDecisions(snapshot: ProjectViewSnapshot, nowMs: number, options: DecisionOptions): DecisionsModel {
  const paused = options.connection === 'live' ? null : PAUSE[options.connection];
  const cards: DecisionCardModel[] = [];
  for (const a of Object.values(snapshot.approvals)) {
    const card = approvalCard(a, snapshot, nowMs, options, paused);
    if (card) cards.push(card);
  }
  cards.push(...blockCards(snapshot, nowMs, options, paused));
  for (const run of Object.values(snapshot.runs)) {
    const budget = budgetCard(run, snapshot, options, paused);
    if (budget) cards.push(budget);
    cards.push(...changeCards(run, snapshot, options, paused));
  }
  const expiredLast = (c: DecisionCardModel): number => (c.state === 'expired' ? 1 : 0);
  cards.sort((a, b) => RANK[a.kind] - RANK[b.kind] || expiredLast(a) - expiredLast(b) || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));

  const history: HistoryEntry[] = [];
  for (const a of Object.values(snapshot.approvals)) {
    if (a.state === 'pending' || a.resolvedAt === null) continue;
    const name = a.taskId ? (snapshot.tasks[a.taskId]?.title ?? a.taskId) : 'This run';
    const outcome = a.state === 'granted' ? 'Granted' : a.state === 'denied' ? 'Denied' : a.state === 'expired' ? 'Expired' : 'Superseded';
    history.push({ id: a.approvalId, outcome, subject: `${name}: ${sentence(a.operation ?? a.reason ?? 'request')}`, at: a.resolvedAt, tone: a.state === 'granted' ? 'success' : a.state === 'denied' ? 'danger' : 'neutral' });
  }
  for (const run of Object.values(snapshot.runs)) {
    if (!run.reducedScope) continue;
    const n = run.reducedScope.notDelivered.tasks.length;
    history.push({ id: run.reducedScope.decisionId, outcome: 'Accepted reduced scope', subject: `${n} task${n === 1 ? '' : 's'} not delivered`, at: run.reducedScope.acceptedAt, tone: 'neutral' });
  }
  history.sort((a, b) => b.at.localeCompare(a.at));

  return { cards, history, waiting: cards.length, paused, empty: isEmptyProject(snapshot), simulated: snapshot.meta.provenance === 'simulated' };
}
