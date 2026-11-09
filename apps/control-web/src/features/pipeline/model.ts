import { formatAge, type Tone } from '@selarikru/ui';
import { approvalStateAt, isEmptyProject, type AttemptView, type ProjectViewSnapshot, type RunView, type TaskView } from '@selarikru/view-protocol';
import { atFailedGate, blockItem, buildAttention, classifyBlock, explain, isClosedTask, latestCheckOf, sentence, type AttentionItem } from '../overview/attention.ts';
import { activeRun, taskRow } from '../overview/model.ts';
import { checksOf, readCheck } from '../team/model.ts';
import type { LayoutInput } from './layout.ts';

export const STAGES = [
  { id: 'discovery', label: 'Discovery' }, { id: 'contract', label: 'Contract' }, { id: 'build', label: 'Build' }, { id: 'integrate', label: 'Integrate' },
  { id: 'verify', label: 'Verify' }, { id: 'review', label: 'Review' }, { id: 'merged', label: 'Merged' },
] as const;
export type StageId = (typeof STAGES)[number]['id'];
export const stageIndex = (id: StageId): number => STAGES.findIndex((s) => s.id === id);
export const stageLabel = (id: StageId): string => STAGES[stageIndex(id)]!.label;

/** Design section 6, in order. Tests and the table both read this, so the column set cannot drift. */
export const PIPELINE_COLUMNS = [
  { key: 'task', label: 'Task and stage' }, { key: 'owner', label: 'Owner' }, { key: 'state', label: 'State and reason' }, { key: 'predecessors', label: 'Predecessors' },
  { key: 'accepted', label: 'Accepted revision' }, { key: 'branch', label: 'Branch or candidate' }, { key: 'checks', label: 'Checks' }, { key: 'age', label: 'Age' }, { key: 'next', label: 'Next action' },
] as const;

export type BlockCause = 'policy' | 'budget' | 'approval' | 'claim' | 'placement' | 'gate' | 'worker' | 'cycle' | 'dependency' | 'capacity' | 'other' | 'unstated';
const CAUSE_ORDER: readonly BlockCause[] = ['policy', 'budget', 'approval', 'claim', 'placement', 'gate', 'worker', 'cycle', 'dependency', 'capacity', 'other', 'unstated'];
export const CAUSE_LABEL: Readonly<Record<BlockCause, string>> = {
  policy: 'Policy', budget: 'Budget', approval: 'Approval', claim: 'Resource claim', placement: 'Placement', gate: 'Failed check', worker: 'Worker', cycle: 'Plan cycle', dependency: 'Dependency', capacity: 'Capacity', other: 'Reported reason', unstated: 'Not stated',
};

export interface BlockReason {
  readonly cause: BlockCause;
  readonly label: string;
  readonly text: string;
  /** The stable reason code when the source gave one. */
  readonly code: string | null;
  /** The tasks this reason names, so the view can link to them. */
  readonly taskIds: readonly string[];
  /** True when the reason is that something is not known, so the view does not read it as a finding. */
  readonly unknown: boolean;
  /** True when nothing can clear this without a person changing the plan: a dependency that can never finish, or a cycle. */
  readonly terminal: boolean;
  /** True for an approval a person can still give. An expired or denied one has a different next step. */
  readonly canApprove: boolean;
}

export interface WhyBlocked {
  readonly held: boolean;
  /** The first is the most severe. Empty when nothing is holding the task. */
  readonly reasons: readonly BlockReason[];
}

export type EdgeState = 'met' | 'waiting' | 'stale' | 'unknown' | 'cycle';

export interface Predecessor {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly edge: EdgeState;
  readonly note: string | null;
}

export interface PipelineEdge {
  readonly from: string;
  readonly to: string;
  readonly state: EdgeState;
  /** Text drawn on the edge. Null when dash pattern and legend say enough. */
  readonly label: string | null;
  readonly critical?: true;
}

export interface CheckLine {
  readonly checkId: string;
  readonly label: string;
  readonly tone: Tone;
  readonly summary: string | null;
  readonly at: string;
}

export interface CheckSummary {
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string | null;
}

export interface TaskLink {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

export interface ApprovalEffect {
  readonly text: string;
  /** Dependents held only by this task. They become eligible once it verifies; they are not said to finish. */
  readonly eligible: readonly TaskLink[];
  readonly stillWaiting: readonly TaskLink[];
}

export interface AttemptLine {
  readonly label: string;
  readonly at: string;
  readonly runner: string | null;
}

export interface PipelineRow {
  readonly taskId: string;
  readonly title: string;
  readonly role: string | null;
  readonly revision: number;
  readonly status: TaskView['status'];
  readonly stage: StageId;
  readonly owner: { readonly role: string | null; readonly workerId: string | null };
  readonly state: { readonly label: string; readonly tone: Tone };
  /** One line for the table: the first reason, a stall note, or null when there is nothing to say. */
  readonly reason: string | null;
  /** Null means the dependencies are unknown; empty means none. */
  readonly predecessors: readonly Predecessor[] | null;
  readonly dependents: readonly TaskLink[];
  /** What was accepted at the task's current revision, so never blank: "Rev 2", "None at rev 2" or "Replaced by rev 3". */
  readonly accepted: string;
  readonly branch: string | null;
  readonly checks: CheckSummary | null;
  readonly checkCount: number;
  readonly checkLines: readonly CheckLine[];
  readonly attempts: readonly AttemptLine[];
  readonly age: string;
  readonly since: string;
  readonly nextAction: string;
  /** The Decisions card to act on this from, or null when there is none. */
  readonly decisionId: string | null;
  readonly why: WhyBlocked;
  /** Held only by healthy waiting: a dependency still in progress or a free slot. Should not compete with a real blocker. */
  readonly quietWait: boolean;
  readonly critical: boolean;
  readonly inCycle: boolean;
  /** Only when an approval is what holds this task. */
  readonly ifApproved: ApprovalEffect | null;
  /** The row's attention rail. Waiting on another task stays quiet. */
  readonly rail: Tone | null;
}

export type CriticalChain =
  | { readonly state: 'known'; readonly label: string; readonly length: number; readonly taskIds: readonly string[] }
  | { readonly state: 'unknown'; readonly label: string; readonly length: null; readonly taskIds: readonly [] }
  | { readonly state: 'none'; readonly label: string; readonly length: 0; readonly taskIds: readonly [] };

export interface StageGroup {
  readonly id: StageId;
  readonly label: string;
  readonly rows: readonly PipelineRow[];
}

export interface ReplanSummary {
  readonly planRevision: number;
  readonly replanned: readonly string[];
  readonly superseded: readonly string[];
  readonly decisions: readonly string[];
  readonly unreported: string;
}

export interface PipelineModel {
  readonly empty: boolean;
  readonly simulated: boolean;
  readonly stale: boolean;
  /** Null when there are no tasks to count. */
  readonly summary: string | null;
  readonly runs: readonly string[];
  readonly runId: string | null;
  readonly planRevision: number | null;
  readonly rows: readonly PipelineRow[];
  readonly edges: readonly PipelineEdge[];
  readonly stages: readonly StageGroup[];
  readonly critical: CriticalChain;
  readonly cycle: { readonly ids: readonly string[]; readonly text: string } | null;
  readonly replan: ReplanSummary | null;
  readonly stageNote: string;
}

const STAGE_NOTE = 'Stage is inferred from each task\'s role, state and dependencies. A finished task stays with its work while others depend on it. The plan does not record a stage.';
const REPLAN_UNREPORTED = 'The earlier plan, invalidated outputs and checks, and cost impact are not in this snapshot.';

const ROLE_STAGE: ReadonlyMap<string, StageId> = new Map([
  ['research', 'discovery'], ['planner', 'discovery'], ['product', 'discovery'], ['discovery', 'discovery'], ['architect', 'contract'], ['contract', 'contract'],
  ['integration', 'integrate'], ['integrator', 'integrate'], ['verification', 'verify'], ['verifier', 'verify'], ['qa', 'verify'], ['reviewer', 'review'],
]);

/**
 * A task's column. The role says what kind of work it is; a finished task with nothing depending on it moves on to its own gate. A dependency is
 * pulled left so that it never sits right of what needs it: stage grouping is presentation and must not read as a different dependency.
 */
function assignStages(tasks: readonly TaskView[], dependentsOf: ReadonlyMap<string, readonly string[]>): Map<string, StageId> {
  // While any task's dependencies are unknown, nothing can be said to have no dependents, so no finished task moves on.
  const anyUnknown = tasks.some((t) => t.dependsOn === null);
  const natural = (t: TaskView): number => {
    const hasDependents = (dependentsOf.get(t.taskId)?.length ?? 0) > 0;
    let base: StageId = (t.role ? ROLE_STAGE.get(t.role) : undefined) ?? 'build';
    if (t.role === 'reviewer' && hasDependents) base = 'contract';
    if (!hasDependents && !anyUnknown) {
      const advance: StageId | null = t.status === 'merged' ? 'merged' : t.status === 'verified' ? 'review' : t.status === 'verifying' ? 'verify' : null;
      if (advance && stageIndex(advance) > stageIndex(base)) base = advance;
    }
    return stageIndex(base);
  };
  const index = new Map(tasks.map((t) => [t.taskId, natural(t)]));
  // Repeated relaxation, so a cycle converges instead of recursing forever.
  for (let pass = 0; pass <= tasks.length; pass += 1) {
    for (const t of tasks) {
      for (const d of dependentsOf.get(t.taskId) ?? []) index.set(t.taskId, Math.min(index.get(t.taskId)!, index.get(d) ?? Infinity));
    }
  }
  return new Map([...index].map(([id, i]) => [id, STAGES[i]!.id]));
}

function findCycle(byId: ReadonlyMap<string, TaskView>): readonly string[] | null {
  const color = new Map<string, 'on_stack' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): readonly string[] | null => {
    color.set(id, 'on_stack');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      if (color.get(dep) === 'on_stack') return [...stack.slice(stack.indexOf(dep)), dep];
      if (color.get(dep) !== 'done') {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 'done');
    return null;
  };
  for (const id of byId.keys()) {
    if (color.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

const UNFINISHED_EXCLUDED: readonly TaskView['status'][] = ['verified', 'merged', 'cancelled', 'superseded'];
const isUnfinished = (t: TaskView): boolean => !UNFINISHED_EXCLUDED.includes(t.status);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The longest chain of unfinished tasks, counted in tasks, because no duration estimate exists. It is unknown whenever the picture is incomplete: a
 * null or absent dependency could reshape the whole chain, so naming one would be a guess.
 */
function longestChain(tasks: readonly TaskView[], byId: ReadonlyMap<string, TaskView>, cycle: readonly string[] | null): { chain: CriticalChain; depth: ReadonlyMap<string, number> } {
  const unfinished = tasks.filter(isUnfinished);
  const noDepth = new Map<string, number>();
  const unknown = (label: string): { chain: CriticalChain; depth: ReadonlyMap<string, number> } => ({ chain: { state: 'unknown', label: `Longest chain unknown: ${label}`, length: null, taskIds: [] }, depth: noDepth });
  if (cycle) return unknown('the plan has a cycle');
  const nullDeps = unfinished.filter((t) => t.dependsOn === null).length;
  if (nullDeps > 0) return unknown(`${plural(nullDeps, 'task')} ${nullDeps === 1 ? 'has' : 'have'} not reported ${nullDeps === 1 ? 'its' : 'their'} dependencies`);
  const missing = unfinished.filter((t) => t.dependsOn!.some((d) => !byId.has(d))).length;
  if (missing > 0) return unknown(`${plural(missing, 'task')} ${missing === 1 ? 'has a dependency' : 'have dependencies'} outside this snapshot`);

  const preds = new Map(unfinished.map((t) => [t.taskId, t.dependsOn!.filter((d) => byId.has(d) && isUnfinished(byId.get(d)!))]));
  const depth = new Map<string, number>();
  const ways = new Map<string, number>();
  const measure = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parents = preds.get(id)!;
    const d = parents.length === 0 ? 1 : 1 + Math.max(...parents.map(measure));
    depth.set(id, d);
    ways.set(id, parents.length === 0 ? 1 : parents.filter((p) => measure(p) === d - 1).reduce((sum, p) => sum + ways.get(p)!, 0));
    return d;
  };
  for (const t of unfinished) measure(t.taskId);
  const max = Math.max(0, ...depth.values());
  if (max <= 1) return { chain: { state: 'none', label: 'No chain: no unfinished task waits on another', length: 0, taskIds: [] }, depth: noDepth };

  const ends = [...depth.keys()].filter((id) => depth.get(id) === max);
  const chains = ends.reduce((sum, id) => sum + ways.get(id)!, 0);
  const on = new Set(ends);
  const queue = [...ends];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    for (const p of preds.get(id)!) {
      if (depth.get(p) === depth.get(id)! - 1 && !on.has(p)) {
        on.add(p);
        queue.push(p);
      }
    }
  }
  const label = `Longest unfinished chain: ${plural(max, 'task')}${chains > 1 ? ` (${chains} chains tie)` : ''}`;
  return { chain: { state: 'known', label, length: max, taskIds: tasks.filter((t) => on.has(t.taskId)).map((t) => t.taskId) }, depth };
}

function edgeOf(dep: TaskView | undefined): { state: EdgeState; label: string | null; note: string | null } {
  if (!dep) return { state: 'unknown', label: null, note: 'Not in this snapshot' };
  if (dep.status === 'superseded') {
    const revision = dep.supersededByRevision;
    return { state: 'stale', label: revision === null ? 'Stale: superseded' : `Stale: superseded by rev ${revision}`, note: revision === null ? 'Superseded' : `Superseded by revision ${revision}` };
  }
  if (dep.status === 'cancelled') return { state: 'stale', label: 'Stale: cancelled', note: 'Cancelled' };
  if (dep.status === 'verified' || dep.status === 'merged') return { state: 'met', label: null, note: null };
  return { state: 'waiting', label: null, note: null };
}

function reasonFromCode(t: TaskView, code: string): BlockReason {
  const item = blockItem(t, code, [t.taskId]);
  const klass = classifyBlock(code);
  let cause: BlockCause;
  if (klass === 'decision') cause = 'approval';
  else if (klass === 'repair') cause = 'gate';
  else if (klass === 'budget') cause = 'budget';
  else if (klass === 'wait') cause = 'capacity';
  else if (klass === 'policy') cause = 'policy';
  else if (code.startsWith('resource_conflict')) cause = 'claim';
  else if (code.startsWith('role_not_mapped') || code.startsWith('location_disabled')) cause = 'placement';
  else cause = 'other';
  return { cause, label: CAUSE_LABEL[cause], text: item.detail, code, taskIds: [], unknown: false, terminal: false, canApprove: code.startsWith('approval_required:') };
}

function reason(cause: BlockCause, text: string, extra: Partial<Pick<BlockReason, 'code' | 'taskIds' | 'unknown' | 'terminal' | 'canApprove'>> = {}): BlockReason {
  return { cause, label: CAUSE_LABEL[cause], text, code: extra.code ?? null, taskIds: extra.taskIds ?? [], unknown: extra.unknown ?? false, terminal: extra.terminal ?? false, canApprove: extra.canApprove ?? false };
}

const WAITING_STATUSES: readonly TaskView['status'][] = ['planned', 'blocked'];
const HOLDABLE_BY_APPROVAL: readonly TaskView['status'][] = ['awaiting_approval', 'planned', 'ready', 'blocked'];

function whyBlocked(t: TaskView, ctx: Context, own: readonly AttentionItem[]): WhyBlocked {
  if (isClosedTask(t)) return { held: false, reasons: [] };
  const reasons: BlockReason[] = [];
  const code = t.placementBlock ?? (t.status === 'blocked' ? t.statusReason : null);
  if (code) reasons.push(reasonFromCode(t, code));

  if (HOLDABLE_BY_APPROVAL.includes(t.status) && !reasons.some((r) => r.cause === 'approval')) {
    const open = Object.values(ctx.snapshot.approvals).filter((a) => a.taskId === t.taskId).map((a) => ({ a, state: approvalStateAt(a, ctx.nowMs) })).filter((x) => x.state === 'pending' || x.state === 'expired');
    if (open.length > 0) {
      const latest = open.sort((x, y) => y.a.requestedAt.localeCompare(x.a.requestedAt))[0]!;
      const asked = latest.a.reason ? sentence(latest.a.reason) : 'Unspecified request';
      reasons.push(reason('approval', latest.state === 'expired' ? `A request expired and was not granted: ${asked}.` : `Waiting for your decision: ${asked}.`, { code: latest.a.reason, canApprove: latest.state === 'pending' }));
    } else if (t.status === 'awaiting_approval') {
      reasons.push(reason('approval', 'It is waiting for approval, and the request is not in this snapshot.'));
    }
  }

  const check = latestCheckOf(ctx.snapshot, t.taskId);
  const failedLatest = check?.state === 'failed' ? check : undefined;
  if (atFailedGate(t, check)) {
    if (failedLatest) {
      const summary = failedLatest.summary ?? failedLatest.checkId;
      reasons.push(reason('gate', `Check failed: ${summary}.${t.status === 'ready' ? ' A repair attempt is scheduled.' : ''}`, { code: failedLatest.checkId }));
    } else {
      reasons.push(reason('gate', t.statusReason ? explain(t.statusReason) : 'It failed, and no reason was reported.', { code: t.statusReason }));
    }
  }

  const lost = own.find((i) => i.kind === 'worker_lost');
  if (lost) reasons.push(reason('worker', lost.detail, { code: lost.code }));
  if (ctx.workerByTask.get(t.taskId)?.activity === 'waiting_resource') reasons.push(reason('capacity', 'It is waiting for a free slot.', { code: 'waiting_resource' }));

  const waitsOnDeps = WAITING_STATUSES.includes(t.status);
  const inCycle = ctx.cycleIds.has(t.taskId);
  if (waitsOnDeps && inCycle) reasons.push(reason('cycle', `It is part of a dependency cycle (${ctx.cycleText}), so it can never start.`, { taskIds: [...ctx.cycleIds], terminal: true }));
  if (waitsOnDeps) {
    if (t.dependsOn === null) {
      reasons.push(reason('dependency', 'Its dependencies are not known yet, so one may be holding it.', { unknown: true }));
    } else {
      for (const id of t.dependsOn) {
        const dep = ctx.byId.get(id);
        const edge = edgeOf(dep);
        if (edge.state === 'met' || (inCycle && ctx.cycleIds.has(id))) continue;
        const name = dep?.title ?? id;
        if (edge.state === 'unknown') reasons.push(reason('dependency', `Depends on ${name}, which is not in this snapshot, so its state is unknown.`, { taskIds: [id], unknown: true }));
        else if (edge.state === 'stale') reasons.push(reason('dependency', `Depends on ${name}, which was ${edge.note!.toLowerCase()} and cannot finish.`, { taskIds: [id], terminal: true }));
        else reasons.push(reason('dependency', `Waiting on ${name} (${taskRow(dep!).statusLabel.toLowerCase()}).`, { taskIds: [id] }));
      }
    }
  }

  if (t.status === 'blocked' && reasons.length === 0) reasons.push(reason('unstated', 'It is blocked, and the snapshot does not say why.', { unknown: true }));
  reasons.sort((a, b) => CAUSE_ORDER.indexOf(a.cause) - CAUSE_ORDER.indexOf(b.cause));
  return { held: reasons.length > 0, reasons };
}

function defaultNext(t: TaskView, why: WhyBlocked, run: RunView | undefined): string {
  if (why.reasons.some((r) => r.terminal)) return 'A person must replan or cancel this task.';
  switch (t.status) {
    case 'planned':
      if (t.dependsOn === null) return 'None yet. Its dependencies are not known.';
      return why.held ? 'None. It starts when its dependencies are met.' : 'None. The scheduler releases it.';
    case 'ready': return 'None. It waits for the scheduler.';
    case 'running': return 'None while it runs.';
    case 'verifying': return 'None. The verifier is running.';
    case 'verified': return run?.lifecycle === 'ready_for_review' ? 'Review the pull request and merge it on GitHub.' : 'None yet. It waits for the rest of the run.';
    case 'awaiting_approval': return 'The request is not in this snapshot.';
    case 'blocked': case 'failed': return 'Inspect why it stopped.';
    default: return 'None.';
  }
}

interface Context {
  readonly snapshot: ProjectViewSnapshot;
  readonly nowMs: number;
  readonly byId: ReadonlyMap<string, TaskView>;
  readonly cycleIds: ReadonlySet<string>;
  readonly cycleText: string;
  readonly workerByTask: ReadonlyMap<string, ProjectViewSnapshot['workers'][string]>;
}

const RUN_EVIDENCE_BRANCH: Readonly<Record<string, string>> = {
  'candidate.assembled': 'Run: candidate assembled', 'change.proposed': 'Run: pull request proposed', 'change.merged': 'Run: merged on GitHub',
};

function attemptLines(attempts: readonly AttemptView[]): AttemptLine[] {
  return [...attempts].sort((a, b) => a.number - b.number).map((a) => ({ label: `Attempt ${a.number}, ${a.outcome}${a.exitReason ? `. ${explain(a.exitReason)}` : ''}`, at: a.startedAt, runner: a.runnerId }));
}

const BUCKET: Readonly<Partial<Record<TaskView['status'], string>>> = { running: 'running', verifying: 'verifying', ready: 'planned or queued', planned: 'planned or queued', verified: 'done', merged: 'done', cancelled: 'cancelled', superseded: 'superseded' };
const SUMMARY_ORDER: readonly string[] = ['running', 'verifying', 'held', 'waiting', 'planned or queued', 'done', 'cancelled', 'superseded'];

const STATUS_ORDER: readonly TaskView['status'][] = ['failed', 'blocked', 'awaiting_approval', 'running', 'verifying', 'ready', 'planned', 'verified', 'merged', 'cancelled', 'superseded'];

export interface PipelineOptions {
  /** The run to show. A run that does not exist falls back to the one the overview follows. */
  readonly runId?: string | null;
  readonly lastConfirmedMs?: number | null;
  readonly stale?: boolean;
}

/** Everything the Pipeline view shows, derived from one snapshot. Pure; time and liveness are parameters. */
export function buildPipeline(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, options: PipelineOptions = {}): PipelineModel {
  const runs = Object.keys(snapshot.runs);
  const requested = options.runId && snapshot.runs[options.runId] ? snapshot.runs[options.runId]! : null;
  const run = requested ?? activeRun(snapshot);
  const runId = run?.runId ?? null;
  const tasks = Object.values(snapshot.tasks).filter((t) => runId === null || t.runId === runId);
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const workers = Object.values(snapshot.workers);

  const dependentsOf = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (byId.has(dep)) dependentsOf.set(dep, [...(dependentsOf.get(dep) ?? []), t.taskId]);
    }
  }
  const stages = assignStages(tasks, dependentsOf);
  const cyclePath = findCycle(byId);
  const inCycle = new Set(cyclePath ?? []);
  // The search walks "depends on"; the graph's arrows run the other way, so the path is reported in the direction it is drawn.
  const drawnCycle = cyclePath ? [...cyclePath].reverse() : null;
  const cycleTitle = (id: string): string => byId.get(id)?.title ?? id;
  const cycleText = drawnCycle ? drawnCycle.map(cycleTitle).join(' → ') : '';
  const isCycleEdge = (taskId: string, dep: string): boolean => cyclePath?.some((id, i) => id === taskId && cyclePath[i + 1] === dep) ?? false;
  const ctx: Context = { snapshot, nowMs, byId, cycleIds: inCycle, cycleText, workerByTask: new Map(workers.filter((w) => w.taskId !== null).map((w) => [w.taskId!, w])) };
  const { chain, depth } = longestChain(tasks, byId, cyclePath);
  const criticalIds = new Set(chain.taskIds);
  const attention = buildAttention(snapshot, nowMs, livenessAsOfMs, options.lastConfirmedMs ?? null);
  const attemptsBy = new Map<string, AttemptView[]>();
  for (const a of Object.values(snapshot.attempts)) attemptsBy.set(a.taskId, [...(attemptsBy.get(a.taskId) ?? []), a]);

  const ownItems = (taskId: string): AttentionItem[] => attention.filter((i) => {
    if (i.affectedTaskIds[0] !== taskId || i.status === 'review' || i.id.startsWith('plan:')) return false;
    if (!i.id.startsWith('decision:')) return true;
    return snapshot.approvals[i.id.slice('decision:'.length)]?.taskId === taskId;
  });

  const link = (id: string): TaskLink => {
    const t = byId.get(id)!;
    return { taskId: id, title: t.title ?? id, status: taskRow(t).statusLabel };
  };

  const rows = tasks
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.title ?? a.taskId).localeCompare(b.title ?? b.taskId) || a.taskId.localeCompare(b.taskId))
    .map((t): PipelineRow => {
      const own = ownItems(t.taskId);
      const why = whyBlocked(t, ctx, own);
      const base = taskRow(t);
      // A released repair is still a failed gate; the plain status would read as a calm queued task.
      const state = t.status === 'ready' && why.reasons[0]?.cause === 'gate' ? { label: 'Failed check; repair queued', tone: 'danger' as const } : { label: base.statusLabel, tone: base.tone };
      const taskAttempts = attemptsBy.get(t.taskId) ?? [];
      const latestAttempt = [...taskAttempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
      const checks = checksOf(snapshot, t.taskId).map((c) => readCheck(c, t, latestAttempt));
      const current = checks.filter((c) => !c.earlier);
      const pick = current.find((c) => c.check.state === 'failed') ?? current.find((c) => c.check.state === 'running') ?? current[0] ?? checks[0];
      const predecessors = t.dependsOn === null ? null : t.dependsOn.map((id): Predecessor => {
        const dep = byId.get(id);
        const edge = edgeOf(dep);
        return { taskId: id, title: dep?.title ?? id, status: dep ? taskRow(dep).statusLabel : 'Unknown', edge: isCycleEdge(t.taskId, id) ? 'cycle' : edge.state, note: edge.note };
      });
      let ifApproved: ApprovalEffect | null = null;
      if (why.reasons.some((r) => r.canApprove)) {
        const followers = (dependentsOf.get(t.taskId) ?? []).map((id) => byId.get(id)!).filter(isUnfinished);
        const onlyThis = (f: TaskView): boolean => (f.dependsOn ?? []).every((d) => d === t.taskId || edgeOf(byId.get(d)).state === 'met');
        ifApproved = {
          text: 'Approving lets this task continue. Nothing here is implied to finish.',
          eligible: followers.filter(onlyThis).map((f) => link(f.taskId)),
          stillWaiting: followers.filter((f) => !onlyThis(f)).map((f) => link(f.taskId)),
        };
      }
      const accepted = t.status === 'verified' || t.status === 'merged' ? `Rev ${t.revision}` : t.status === 'superseded' ? (t.supersededByRevision !== null ? `Replaced by rev ${t.supersededByRevision}` : 'Replaced') : `None at rev ${t.revision}`;
      const branch = (t.status === 'verified' || t.status === 'merged') && run?.latestEvidence ? (RUN_EVIDENCE_BRANCH[run.latestEvidence.kind] ?? null) : null;
      return {
        taskId: t.taskId, title: base.title, role: t.role, revision: t.revision, status: t.status, stage: stages.get(t.taskId)!,
        owner: { role: t.role, workerId: ctx.workerByTask.get(t.taskId)?.workerId ?? null },
        state,
        reason: why.reasons[0]?.text ?? own[0]?.detail ?? null,
        predecessors,
        dependents: (dependentsOf.get(t.taskId) ?? []).map(link),
        accepted, branch,
        // The table chip keeps the verdict; the task's own state is already in the row, and the inspector has the full reading.
        checks: pick ? { label: pick.label.split(';')[0]!, tone: pick.tone, detail: pick.check.summary } : null,
        checkCount: checks.length,
        checkLines: checks.map((c) => ({ checkId: c.check.checkId, label: c.label, tone: c.tone, summary: c.check.summary, at: c.check.updatedAt })),
        attempts: attemptLines(taskAttempts),
        age: formatAge(nowMs - Date.parse(t.enteredStatusAt)),
        since: t.enteredStatusAt,
        nextAction: own[0]?.nextAction ?? defaultNext(t, why, run ?? undefined),
        decisionId: own.find((i) => i.decisionId !== null)?.decisionId ?? null,
        why,
        quietWait: why.held && why.reasons.every((r) => !r.unknown && !r.terminal && (r.cause === 'dependency' || r.cause === 'capacity')),
        critical: criticalIds.has(t.taskId),
        inCycle: inCycle.has(t.taskId),
        ifApproved,
        rail: state.tone === 'danger' || state.tone === 'warning' ? state.tone : null,
      };
    });

  const edges: PipelineEdge[] = [];
  for (const t of rows) {
    const task = byId.get(t.taskId)!;
    for (const dep of task.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const base = isCycleEdge(t.taskId, dep) ? { state: 'cycle' as const, label: 'Cycle' } : edgeOf(byId.get(dep));
      const onChain = criticalIds.has(dep) && criticalIds.has(t.taskId) && depth.get(t.taskId) === (depth.get(dep) ?? -2) + 1;
      edges.push({ from: dep, to: t.taskId, state: base.state, label: base.label, ...(onChain ? { critical: true as const } : {}) });
    }
  }
  edges.sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from));

  const groups: StageGroup[] = STAGES.map((s) => ({ id: s.id, label: s.label, rows: rows.filter((r) => r.stage === s.id) })).filter((g) => g.rows.length > 0);
  const summary = (() => {
    if (rows.length === 0) return null;
    // Each row lands in exactly one bucket, so the parts always add up to the total.
    const bucketOf = (r: PipelineRow): string => (r.why.held ? (r.quietWait ? 'waiting' : 'held') : (BUCKET[r.status] ?? r.status));
    const count = (bucket: string): number => rows.filter((r) => bucketOf(r) === bucket).length;
    const held = CAUSE_ORDER.map((c) => [c, rows.filter((r) => bucketOf(r) === 'held' && r.why.reasons[0]?.cause === c).length] as const).filter(([, n]) => n > 0).map(([c, n]) => `${n} ${CAUSE_LABEL[c].toLowerCase()}`).join(', ');
    const body = SUMMARY_ORDER.map((bucket): [number, string] => [count(bucket), bucket === 'held' && held ? `held (${held})` : bucket]).filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(', ');
    return `${options.stale ? 'Last confirmed: ' : ''}${plural(rows.length, 'task')}: ${body}.`;
  })();

  let replan: ReplanSummary | null = null;
  if (run && run.planRevision >= 2) {
    const titleOf = (t: TaskView): string => t.title ?? t.taskId;
    const decisions = Object.values(snapshot.approvals).filter((a) => a.runId === run.runId && (approvalStateAt(a, nowMs) === 'pending')).map((a) => (a.reason ? sentence(a.reason) : 'Unspecified request'));
    replan = {
      planRevision: run.planRevision,
      replanned: tasks.filter((t) => t.revision > 1 && t.status !== 'superseded').map(titleOf),
      superseded: tasks.filter((t) => t.status === 'superseded').map(titleOf),
      decisions,
      unreported: REPLAN_UNREPORTED,
    };
  }

  return {
    empty: isEmptyProject(snapshot) || rows.length === 0,
    simulated: snapshot.meta.provenance === 'simulated',
    stale: options.stale === true,
    summary, runs, runId, planRevision: run?.planRevision ?? null,
    rows, edges, stages: groups, critical: chain,
    cycle: drawnCycle ? { ids: drawnCycle, text: cycleText } : null,
    replan, stageNote: STAGE_NOTE,
  };
}

/** The graph's input, in task id order whatever the rows' status order, so a status change alone never moves a node. */
export function graphInput(rows: readonly PipelineRow[], edges: readonly PipelineEdge[]): LayoutInput {
  const shown = new Set(rows.map((r) => r.taskId));
  return {
    nodes: [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((r) => ({ id: r.taskId, column: stageIndex(r.stage) })),
    edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)).map((e) => ({ from: e.from, to: e.to })),
  };
}

/** The filter both views share. An unknown or absent chain cannot filter anything, so it shows every task rather than a confident subset. */
export function filterRows(rows: readonly PipelineRow[], critical: CriticalChain, filter: { readonly criticalOnly: boolean }): readonly PipelineRow[] {
  return filter.criticalOnly && critical.state === 'known' ? rows.filter((r) => r.critical) : rows;
}
