import type { ChangeRequestView, ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import { verifiedState } from '../features/evidence/model.ts';
import { currentRun } from '../features/settings/model.ts';
import type { TeamModel, TeamRow } from '../features/team/model.ts';
import { workerAccents, stateStyle, type RobotState } from '../theme/tokens.ts';
import { roofState, type OfficeRoof } from './roof.ts';
import { PROJECT_MANAGER_ROLE, roleLabel } from '@selarikru/domain';

/**
 * What the office canvas shows, read from SelariKru's own snapshot and team model. It is a picture of the same facts the team panel
 * lists; nothing here is invented for the animation, and a state the source did not confirm stays unknown.
 */

export interface OfficeAgent {
  readonly id: string;
  /** The name on its desk plate and tag: the owner-given name (H11), else its role, numbered when two share one. */
  readonly name: string;
  /** Its role in words, shown on hover, in the team card and in the summary (H11). */
  readonly roleLabel?: string;
  /** False: not started, disabled, or its runner is not running. Its desk is empty and dimmed, with its nameplate and no robot (H11). */
  readonly active?: boolean;
  /** H11 fix round 1 (M10): a desk for a role of the plan that no worker holds yet. Its id is `role:<role>`; it is a desk only, never a robot, rack or count. */
  readonly notStarted?: true;
  readonly color: string;
  readonly state: RobotState;
  readonly label: string;
  readonly taskTitle: string | null;
  /**
   * The desk's mark. `expected`: a call is in flight and this is where its route sends it first, a prediction until its record lands. `observed`: where the task's
   * last call ran, as reported. Null: no call yet, the last one was blocked, or its source was not shown. `fellBack` (observed only, from the record's
   * server-derived flag): the call ran on the other side from where its route sent it first.
   */
  readonly ai: { readonly place: 'device' | 'cloud'; readonly state: 'expected' | 'observed' | 'waiting'; readonly fellBack?: true } | null;
}

/** A task's AI call in flight in this browser, and where it is meant to run first. */
export interface OfficeCall {
  readonly taskId: string;
  readonly place: 'device' | 'cloud' | null;
  /** The step, when known: a Project Manager step makes the PM robot talk while it runs (H11). */
  readonly stepKind?: string;
  /** H12: not in flight: a checkpoint waiting to be sent to the cloud. Its robot waits at the CLOUD deck, marked waiting. */
  readonly waiting?: true;
}

/** A sticky note on the plan wall. Columns: 0 to do, 1 doing, 2 verifying, 3 done. */
export interface OfficeNote {
  readonly taskId: string;
  readonly column: 0 | 1 | 2 | 3;
  readonly status: TaskView['status'];
  readonly ownerId: string | null;
}

/**
 * What the office's errands and effects are read from (H7 fix): per worker, the facts whose changes are real events (office/events.ts). Never a
 * prediction, except `cloudCall`, which is a call this browser has in flight and is shown as one.
 */
export interface OfficeCue {
  readonly agentId: string;
  readonly taskId: string | null;
  readonly taskRevision: number | null;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly attemptRunning: boolean;
  readonly attemptOutcome: string | null;
  /** The task's last route record, and whether it was a conforming fallback to the cloud. */
  readonly recordId: string | null;
  readonly fellBackToCloud: boolean;
  /** A cloud AI call for its task is in flight in this browser. */
  readonly cloudCall: boolean;
  /** A device AI call for its task is in flight in this browser (round 4). */
  readonly deviceCall: boolean;
  readonly needsYou: boolean;
  /** H11: when the task it holds was last delegated, and under which accepted plan revision. */
  readonly delegatedAt?: string | null;
  readonly delegatedPlanRevision?: number | null;
}

/** A pull request on the PR board. A run's change has no single author, so none is named. */
export interface OfficePr {
  readonly num: number;
  /** The run it belongs to: the workers on that run walk to the board when it opens. */
  readonly runId: string;
  readonly authorId: string | null;
  /**
   * From the run's own verification record, never from the pull request being open. `verified`: its candidate is the run's live candidate,
   * the record stands and every approved criterion passed. `out_of_date`: it no longer holds the run's live candidate. Otherwise `unverified`.
   */
  readonly verification: 'verified' | 'unverified' | 'out_of_date';
  readonly merged: boolean;
  readonly closed: boolean;
}

/**
 * A candidate on the belt, on its way to the verifier. `to_gate`: a live candidate not yet verified. `verified`: Evidence's rule holds for it.
 * `merged`: its run's pull request was merged (a recorded merge only). A rejected or replaced candidate is not on the belt.
 */
export interface OfficeParcel {
  readonly id: string;
  /** The first characters of its commit, for the tag on the belt. */
  readonly label: string;
  readonly stage: 'to_gate' | 'verified' | 'merged';
}

/** A worker's sandbox, shown on its desk monitor (H9; it was a rack before). Running while the worker holds an attempt with no end recorded. */
export interface OfficeRack {
  readonly agentId: string;
  readonly name: string;
  readonly running: boolean;
}

export interface OfficeRunChoice {
  readonly runId: string;
  readonly label: string;
}

export interface OfficeWorld {
  readonly projectName: string;
  readonly agents: readonly OfficeAgent[];
  /** The run whose tasks are on the plan wall, and the phase banner above it. */
  readonly planRunId: string | null;
  /** The plan revision the owner accepted for that run (H11): a new one pins its notes and the Project Manager says so. */
  readonly planRevision?: number | null;
  readonly banner: string | null;
  readonly runs: readonly OfficeRunChoice[];
  readonly notes: readonly OfficeNote[];
  /** The plan desk: SelariKru has no lead agent, so it is labelled PLAN and has no robot. */
  readonly leadLabel: string;
  readonly racks: readonly OfficeRack[];
  /** How many workers hold an attempt with no end recorded: the top bar's "Sandbox · N running". */
  readonly running: number;
  readonly prs: readonly OfficePr[];
  readonly parcels: readonly OfficeParcel[];
  /** True while any task is verifying: the gate scans. */
  readonly verifying: boolean;
  /** True while a cloud AI call is in flight: the rooftop cloud deck (its uplink and CLOUD sign) is lit. */
  readonly cloudCall: boolean;
  /** The canvas's text equivalent. */
  readonly summary: string;
  /** Per worker, what errands are read from. */
  readonly cues: readonly OfficeCue[];
  /** Approvals a person answered (granted or denied, with an approver), by task. Expired and superseded ones were not answered. */
  readonly resolvedApprovals: readonly { readonly approvalId: string; readonly taskId: string | null }[];
  /**
   * What the record says about each run's candidate (round 2): `failed` (a failed criterion recorded on it while it is live), `rejected`, `retired`
   * (replaced or otherwise no longer live), or `pending`. Only a change to failed or rejected raises CHANGES.
   */
  readonly verdicts: readonly OfficeVerdict[];
  /** The rooftop inference deck (round 4): its two boxes' state, from records and calls in flight. */
  readonly roof: OfficeRoof;
  /** H11: each task's delegation as recorded (worker, accepted plan revision, when). */
  readonly delegations?: readonly { readonly taskId: string; readonly workerId: string; readonly planRevision: number; readonly at: string }[];
  /** H11: the Project Manager at the PLAN desk, always there: the worker with role project_manager if there is one. Busy while a PM call runs. */
  readonly pm: { readonly id: string | null; readonly name: string; readonly busy: boolean };
  /**
   * H9: the shared table. The PM meets the team there while a review is in progress (a worker whose task is verifying) or while a plan is drafted (a PM plan
   * or delegation call in flight). `agentIds`: the reviewing workers who join it. From the snapshot and the calls in flight only.
   */
  readonly meeting?: { readonly pm: boolean; readonly why: 'review' | 'plan' | null; readonly agentIds: readonly string[] };
  /** Which projection this world belongs to (the project and the data source session). A world from another epoch is never compared with this one. */
  readonly epoch: string;
}

export interface OfficeVerdict {
  readonly id: string;
  readonly label: string;
  readonly outcome: 'pending' | 'passed' | 'failed' | 'rejected' | 'retired';
}

/** Only a recorded merge is a merge. `merged_sha_mismatch` merged a commit that is not the verified one, and a stale PR's merge commit is not this run's. */
export const isRecordedMerge = (c: ChangeRequestView): boolean => c.status === 'merged';

function prVerification(snapshot: ProjectViewSnapshot, c: ChangeRequestView): OfficePr['verification'] {
  if (c.outOfDate || c.status === 'stale_candidate' || c.status === 'merged_sha_mismatch') return 'out_of_date';
  const run = snapshot.runs[c.runId];
  if (!run) return 'unverified';
  // Evidence's own rule (verified, or verified at reduced scope), and the pull request must hold the candidate that rule judged.
  const candidate = run.evidence?.candidate ?? null;
  const established = verifiedState(run, run.evidence).established;
  return established && candidate !== null && candidate.sha === c.candidateSha ? 'verified' : 'unverified';
}

const DONE = new Set<TaskView['status']>(['verified', 'merged']);

/** "<Name> · <Role>" for an office agent, or its desk name when it has no separate role label. */
const labelOf = (a: OfficeAgent): string => (a.roleLabel && a.roleLabel !== a.name && !a.name.startsWith(a.roleLabel) ? `${a.name} · ${a.roleLabel}` : a.name);

/** A worker's robot state: its presence first, then what its current task says. A stale or lost reading is never shown as a current one. */
export function robotState(row: TeamRow, snapshot: ProjectViewSnapshot): RobotState {
  const p = row.presence.state;
  if (p === 'unknown') return 'unknown';
  if (p === 'lost') return 'offline';
  const status = row.task ? snapshot.tasks[row.task.taskId]?.status ?? null : null;
  if (p === 'needs_you' || status === 'awaiting_approval') return 'needs_input';
  if (p === 'blocked') return 'blocked';
  if (status !== null && DONE.has(status)) return 'verified';
  if (status === 'verifying') return 'in_review';
  if (p === 'working') return 'working';
  return 'idle';
}

const COLUMN: Readonly<Partial<Record<TaskView['status'], OfficeNote['column']>>> = {
  planned: 0, ready: 0, blocked: 0, running: 1, awaiting_approval: 1, verifying: 2, verified: 3, merged: 3,
};

const ORDER: readonly RobotState[] = ['needs_input', 'working', 'in_review', 'verified', 'blocked', 'idle', 'offline', 'unknown'];

const roleName = (role: string | null): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Worker');

export function buildOfficeWorld(snapshot: ProjectViewSnapshot, team: TeamModel, projectName: string, planRunId: string | null = null, calls: readonly OfficeCall[] = [], epoch = '', opts: { readonly offline?: boolean } = {}): OfficeWorld {
  // Colours follow the worker's id, not its place in the attention order, so a robot keeps its colour as the order changes.
  const ids = Object.keys(snapshot.workers).sort();
  const colorOf = (id: string): string => workerAccents[Math.max(0, ids.indexOf(id)) % workerAccents.length]!;
  const seen = new Map<string, number>();
  const roles = new Map<string, number>();
  for (const r of team.rows) roles.set(roleName(r.role), (roles.get(roleName(r.role)) ?? 0) + 1);
  // A call in flight wins; otherwise the task's last reported source. Unknown is no mark: it is never shown as either side.
  const aiMark = (taskId: string | null): OfficeAgent['ai'] => {
    if (taskId === null) return null;
    const live = calls.find((c) => c.taskId === taskId && c.place !== null);
    if (live) return { place: live.place!, state: live.waiting === true ? 'waiting' : 'expected' };
    const last = snapshot.tasks[taskId]?.route?.lastObserved;
    if (!last || last.status === 'blocked' || last.status === 'error') return null;
    const place = last.observedSource === 'ON_DEVICE' ? 'device' : last.observedSource === 'IN_CLOUD' ? 'cloud' : null;
    if (place === null) return null;
    // Only a conforming record is an allowed fallback; a violation is never drawn as one (H7 fix I2).
    return last.fellBack === true && last.conformance === 'conforms' ? { place, state: 'observed', fellBack: true } : { place, state: 'observed' };
  };
  // H11: the Project Manager has the PLAN desk, not a worker desk; every other worker has a desk, lit when active and dimmed when not.
  const pmRow = team.rows.find((r) => r.role === PROJECT_MANAGER_ROLE) ?? null;
  const disabled = (id: string): boolean => snapshot.settings.some((x) => x.scope === 'runner' && x.key === id && x.field === 'enabled' && x.desired === false);
  const agents = team.rows.filter((r) => r !== pmRow).map((r): OfficeAgent => {
    const base = roleName(r.role);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const state = robotState(r, snapshot);
    const name = r.name ?? ((roles.get(base) ?? 0) > 1 ? `${base} ${n}` : base);
    const active = !disabled(r.workerId) && state !== 'offline' && state !== 'unknown';
    return { id: r.workerId, name, roleLabel: roleLabel(r.role), active, color: colorOf(r.workerId), state, label: stateStyle[state].label, taskTitle: r.task?.title ?? null, ai: aiMark(r.task?.taskId ?? null) };
  });
  // M10: a role the plan names that no worker holds yet has a desk too, "not started", with the role on its plate.
  const runNow = (planRunId !== null ? snapshot.runs[planRunId] ?? null : null) ?? currentRun(snapshot);
  const held = new Set(team.rows.filter((r) => r !== pmRow).map((r) => r.role).filter((r): r is string => typeof r === 'string'));
  const planRoles = [...new Set(Object.values(snapshot.tasks).filter((t) => runNow === null || t.runId === runNow.runId).map((t) => t.role).filter((r): r is string => typeof r === 'string' && r !== '' && r !== PROJECT_MANAGER_ROLE))].sort();
  const notStarted = planRoles.filter((r) => !held.has(r)).map((r): OfficeAgent => ({ id: `role:${r}`, name: roleLabel(r), roleLabel: roleLabel(r), active: false, notStarted: true, color: '#8a7a6a', state: 'unknown', label: 'Not started', taskTitle: null, ai: null }));
  // The PM's name: its worker's, else the one the owner gave in Settings › Workflow (before any worker holds the role), else "Project Manager".
  const savedPmName = runNow ? snapshot.settings.find((x) => x.scope === 'run' && x.key === runNow.runId && x.field === 'pm_display_name')?.desired : undefined;
  const pm = { id: pmRow?.workerId ?? null, name: pmRow?.name ?? (typeof savedPmName === 'string' && savedPmName.trim() ? savedPmName.trim() : 'Project Manager'), busy: calls.some((c) => typeof c.stepKind === 'string' && c.stepKind.startsWith('pm')) };

  const chosen = planRunId !== null ? snapshot.runs[planRunId] ?? null : null;
  const run = chosen ?? currentRun(snapshot);
  const runs = Object.values(snapshot.runs).map((r): OfficeRunChoice => ({ runId: r.runId, label: `${r.runId} · ${r.lifecycle.replace(/_/g, ' ')}` }));
  const banner = run ? `${run.runId} · plan rev ${run.planRevision}` : null;
  const holder = new Map(Object.values(snapshot.workers).filter((w) => w.taskId !== null).map((w) => [w.taskId!, w.workerId]));
  const notes = Object.values(snapshot.tasks)
    .filter((t) => run === null || t.runId === run.runId)
    .flatMap((t): OfficeNote[] => {
      const column = COLUMN[t.status];
      return column === undefined ? [] : [{ taskId: t.taskId, column, status: t.status, ownerId: holder.get(t.taskId) ?? null }];
    });

  const prs = snapshot.changeRequests.map((c): OfficePr => {
    const merged = isRecordedMerge(c);
    return { num: c.prNumber, runId: c.runId, authorId: null, verification: prVerification(snapshot, c), merged, closed: !merged && c.status === 'closed' };
  });
  const parcels = Object.values(snapshot.runs).flatMap((r): OfficeParcel[] => {
    const candidate = r.evidence?.candidate ?? null;
    if (!candidate || !candidate.live) return [];
    const merged = snapshot.changeRequests.some((c) => c.runId === r.runId && c.candidateSha === candidate.sha && isRecordedMerge(c));
    const stage = merged ? 'merged' : verifiedState(r, r.evidence).established ? 'verified' : 'to_gate';
    return [{ id: `${r.runId}:${candidate.sha}`, label: candidate.sha.slice(0, 4).toUpperCase(), stage }];
  });
  // A sandbox is running when its worker holds an attempt that has not ended: read from the attempt record, not inferred from the robot's state.
  const holdsLiveAttempt = (workerId: string): boolean => {
    const attemptId = snapshot.workers[workerId]?.attemptId ?? null;
    const attempt = attemptId ? snapshot.attempts[attemptId] : undefined;
    return attempt !== undefined && attempt.endedAt === null;
  };
  const racks = agents.map((a): OfficeRack => ({ agentId: a.id, name: a.name, running: holdsLiveAttempt(a.id) }));
  const verifying = Object.values(snapshot.tasks).some((t) => t.status === 'verifying');

  let summary: string;
  if (agents.length === 0) summary = `Office for ${projectName}: no workers yet.`;
  else {
    const counts = ORDER.map((s) => [s, agents.filter((a) => a.state === s).length] as const).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${stateStyle[s].label.toLowerCase()}`);
    const open = prs.filter((p) => !p.closed && !p.merged).length;
    const prText = open > 0 ? ` ${open} pull request${open === 1 ? '' : 's'}.` : '';
    summary = `Office for ${projectName}: ${agents.length} worker${agents.length === 1 ? '' : 's'}. ${counts.join(', ')}.${prText} The team panel lists each worker.`;
    // H11: who they are, as "<Name> · <Role>", and which desks are empty.
    summary += ` Team: ${agents.map(labelOf).join(', ')}.`;
    const inactive = agents.filter((a) => a.active === false).length;
    if (inactive > 0) summary += ` ${inactive} inactive (empty desk).`;
  }
  // H9: where each worker is, in words: the kopitiam (no claimed task), the shared table (a review, or a plan with the PM), and the sandboxes on the desks.
  const reviewers = agents.filter((a) => a.active !== false && a.state === 'in_review');
  const planning = calls.some((c) => c.waiting !== true && (c.stepKind === 'pmPlan' || c.stepKind === 'pmDelegate'));
  const meeting: OfficeWorld['meeting'] = { pm: reviewers.length > 0 || planning, why: planning ? 'plan' : reviewers.length > 0 ? 'review' : null, agentIds: reviewers.map((a) => a.id) };
  if (agents.length > 0) {
    const resting = agents.filter((a) => a.active !== false && a.state === 'idle');
    if (resting.length > 0) summary += ` In the kopitiam, with no claimed task: ${resting.map(labelOf).join(', ')}.`;
    if (meeting.pm) summary += reviewers.length > 0 ? ` At the shared table with ${pm.name}, for a review: ${reviewers.map(labelOf).join(', ')}.` : ` At the shared table: ${pm.name}, drafting a plan.`;
    const sandboxes = racks.filter((r) => r.running).map((r) => r.name);
    summary += sandboxes.length > 0 ? ` Sandbox running at the desk of: ${sandboxes.join(', ')}.` : ' No sandbox is running.';
  } else if (planning) summary += ` At the shared table: ${pm.name}, drafting a plan.`;
  if (notStarted.length > 0) summary += ` +${notStarted.length} role${notStarted.length === 1 ? '' : 's'} without a worker (${notStarted.map((a) => a.name).join(', ')}): Team settings gives ${notStarted.length === 1 ? 'it one' : 'each one'}.`;
  const cloudCall = calls.some((c) => c.place === 'cloud');
  // The desk marks in words: a call in flight is where its route sends it, expected until its record says where it ran.
  const marks = agents.flatMap((a) => (a.ai === null ? [] : [a.ai.state === 'waiting' ? `${labelOf(a)} waiting at the cloud deck for the connection` : a.ai.state === 'expected'
    ? `${labelOf(a)} ${a.ai.place === 'cloud' ? 'headed to the cloud (expected)' : 'expected on this device'}`
    : `${labelOf(a)} last AI call ran ${a.ai.place === 'cloud' ? 'in the cloud' : 'on this device'}${a.ai.fellBack ? (a.ai.place === 'cloud' ? ' (fell back from this device)' : ' (fell back from the cloud)') : ''}`]));
  if (marks.length > 0) summary += ` Desk marks: ${marks.join('; ')}.`;
  if (cloudCall) summary += ' The rooftop cloud deck is lit: a call is headed to the cloud.';
  const roof = roofState(snapshot, run?.runId ?? null, calls, opts);
  summary += ` ${roof.summary}`;
  const cues = team.rows.map((r): OfficeCue => {
    const taskId = r.task?.taskId ?? null;
    const t = taskId ? snapshot.tasks[taskId] : undefined;
    const attemptId = snapshot.workers[r.workerId]?.attemptId ?? null;
    const attempt = attemptId ? snapshot.attempts[attemptId] : undefined;
    const last = t?.route?.lastObserved ?? null;
    return {
      agentId: r.workerId, taskId, taskRevision: t?.revision ?? null, runId: t?.runId ?? null, attemptId,
      attemptRunning: attempt !== undefined && attempt.endedAt === null, attemptOutcome: attempt?.endedAt ? attempt.outcome : null,
      recordId: last?.recordId ?? null, fellBackToCloud: last !== null && last.fellBack === true && last.conformance === 'conforms' && last.status === 'ok' && last.observedSource === 'IN_CLOUD',
      cloudCall: taskId !== null && calls.some((c) => c.taskId === taskId && c.place === 'cloud'),
      deviceCall: taskId !== null && calls.some((c) => c.taskId === taskId && c.place === 'device'),
      needsYou: agents.find((a) => a.id === r.workerId)?.state === 'needs_input',
      delegatedAt: t?.delegation?.at ?? null, delegatedPlanRevision: t?.delegation?.planRevision ?? null,
    };
  });
  const resolvedApprovals = snapshot.approvalHistory
    .filter((h) => h.resolvedAt !== null && (h.outcome === 'granted' || h.outcome === 'denied') && h.approver !== null)
    .map((h) => ({ approvalId: h.approvalId, taskId: h.taskId }));
  const verdicts = Object.values(snapshot.runs).flatMap((r): OfficeVerdict[] => {
    const candidate = r.evidence?.candidate ?? null;
    if (!candidate) return [];
    const failed = (r.evidence?.criteria ?? []).some((c) => c.state === 'failed' && c.candidateSha === candidate.sha);
    const outcome: OfficeVerdict['outcome'] = !candidate.live ? (candidate.status === 'rejected' ? 'rejected' : 'retired')
      : failed ? 'failed' : verifiedState(r, r.evidence).established ? 'passed' : 'pending';
    return [{ id: `${r.runId}:${candidate.sha}`, label: candidate.sha.slice(0, 4).toUpperCase(), outcome }];
  });
  return { projectName, agents: [...agents, ...notStarted], planRunId: run?.runId ?? null, planRevision: run?.planRevision ?? null, banner, runs, notes, leadLabel: 'PLAN', racks, meeting, running: racks.filter((r) => r.running).length, prs, parcels, verifying, cloudCall, summary, cues, resolvedApprovals, verdicts, roof, pm, delegations: Object.values(snapshot.tasks).flatMap((t) => (t.delegation ? [{ taskId: t.taskId, workerId: t.delegation.workerId, planRevision: t.delegation.planRevision, at: t.delegation.at }] : [])), epoch: epoch || snapshot.meta.projectId };
}
