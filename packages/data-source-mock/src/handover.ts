import { checkpointDigest, HANDOVER_CLOSE_TEXT, HANDOVER_REASON_TEXT, HANDOVER_STATE_LABEL, OPEN_HANDOVER_STATES, sha256Hex, type CheckpointRefusal, type HandoverIneligible, type HandoverState } from '@selarikru/domain';
import { DataSourceException, type HandoverAction, type HandoverDiffView, type HandoverRecordView, type HandoversView, type HandoverTaskView, type ProjectViewSnapshot } from '@selarikru/view-protocol';

/**
 * Checkpoint continuation on demo data. The same rules as the server, played out on the demo clock: a request stops the local attempt, the fence follows its acknowledgement,
 * and only then does a cloud attempt start, recorded through the same events the services emit. Nothing here touches a network, and every figure is a labelled demo estimate.
 * "Cloud runner" means an enrolled runner whose location is cloud; the demo's is `runner_cloud_1`.
 */

const DEMO_BASE = 'c'.repeat(40);
const CLOUD_RUNNER = 'runner_cloud_1';
const LOCAL_RUNNER = 'runner_local_1';
const OWNER = 'demo-operator';
/** When each step happens after the request, on the demo clock. */
export const DEMO_HANDOVER_STEPS = { fencedMs: 2_000, startingMs: 4_000, runningMs: 6_000 } as const;

export const DEMO_HANDOVER_NOTICE =
  'Demo data. A cloud runner here is an enrolled runner whose location is cloud. Continuing starts a new attempt there from the approved base commit with the checked checkpoint applied; '
  + 'it is not a migration of the running session, and the combined result is verified again from the start. Secret-bearing files and anything outside the allowed paths are never carried.';
const EXCLUDES = [
  '.env files, keys, certificates and credential files (.pem, .key, id_rsa, .npmrc, credentials.*)',
  'any file whose content the secret detector flags',
  'anything outside the task\'s allowed paths',
  'links and special files, home directories, model memory and sandbox state',
];

export interface DemoHandoverDeps {
  readonly snapshotOf: (projectId: string) => ProjectViewSnapshot;
  readonly nowMs: (projectId: string) => number;
  /** Appends a simulated event, `delayMs` after now, as the services would emit it. */
  readonly emit: (projectId: string, taskId: string, type: 'handover.requested' | 'attempt.failed' | 'attempt.fenced' | 'task.ready' | 'attempt.started' | 'attempt.route_changed' | 'checkpoint.recorded' | 'checkpoint.refused' | 'handover.decided', payload: Record<string, unknown>, o: { delayMs?: number; attemptId?: string | null; revisionStep?: number }) => void;
}

interface DemoRecord {
  checkpointId: string;
  taskId: string;
  runId: string;
  revision: number;
  mode: 'resume' | 'restart';
  priorAttemptId: string;
  priorFence: number;
  requestedAtMs: number;
  /** Set when the demo checkpoint cannot be resumed: the frontend demo task carries a secret file inside its paths. */
  refusal: CheckpointRefusal | null;
  decision: { choice: 'release' | 'restart' | 'decline'; atMs: number } | null;
  successorAttemptId: string;
  files: { path: string; status: 'added' | 'modified'; size: number; sha256: string }[];
  exclusions: { path: string; reason: 'secret_file_name' | 'outside_allowed_paths' }[];
}

const refuse = (message: string): DataSourceException => new DataSourceException({ code: 'unavailable', message, retryable: false });
const estimate = (elapsedSeconds: number | null) => ({
  costUsd: { value: 0.5, provenance: 'estimated' as const, basis: 'demo: the worst-case hold one more attempt reserves' },
  timeSeconds: elapsedSeconds === null ? { value: null, provenance: 'unavailable' as const, basis: 'demo: no start time' } : { value: elapsedSeconds, provenance: 'estimated' as const, basis: 'demo: how long the local attempt has run; a restart repeats that work' },
});

export interface DemoHandover {
  get(projectId: string): Promise<HandoversView>;
  act(projectId: string, action: HandoverAction): Promise<HandoversView>;
  diff(projectId: string, taskId: string, checkpointId: string, path: string): Promise<HandoverDiffView>;
}

export function createDemoHandover(d: DemoHandoverDeps): DemoHandover {
  const records = new Map<string, DemoRecord[]>();
  const keys = new Map<string, string>();
  const listOf = (projectId: string): DemoRecord[] => {
    let l = records.get(projectId);
    if (!l) { l = []; records.set(projectId, l); }
    return l;
  };

  /** As on the server: stopping, then (a checked checkpoint) waiting for review, or (a restart) fenced, or a restart offer; the owner's answer moves it on. */
  function stateOf(r: DemoRecord, now: number): HandoverState {
    if (now < r.requestedAtMs + DEMO_HANDOVER_STEPS.fencedMs) return 'stopping';
    if (r.decision === null) return r.refusal !== null ? 'restart_offered' : r.mode === 'resume' ? 'awaiting_review' : now < r.requestedAtMs + DEMO_HANDOVER_STEPS.startingMs ? 'fenced' : now < r.requestedAtMs + DEMO_HANDOVER_STEPS.runningMs ? 'starting' : 'running';
    if (r.decision.choice === 'decline') return 'declined';
    const startAt = r.decision.atMs + (DEMO_HANDOVER_STEPS.startingMs - DEMO_HANDOVER_STEPS.fencedMs);
    if (now < startAt) return 'fenced';
    return now < startAt + (DEMO_HANDOVER_STEPS.runningMs - DEMO_HANDOVER_STEPS.startingMs) ? 'starting' : 'running';
  }

  function recordView(r: DemoRecord, now: number): HandoverRecordView {
    const state = stateOf(r, now);
    const resumed = r.mode === 'resume' && r.decision?.choice !== 'restart' && r.decision?.choice !== 'decline';
    const dropped = state === 'running' ? 'successor_running' : r.decision?.choice === 'decline' ? 'declined' : r.decision?.choice === 'restart' ? 'restart_chosen' : null;
    return {
      checkpointId: r.checkpointId, taskId: r.taskId, revision: r.revision, runId: r.runId, mode: r.decision?.choice === 'restart' ? 'restart' : r.mode, state, stateLabel: HANDOVER_STATE_LABEL[state],
      target: 'cloud', priorAttemptId: r.priorAttemptId, priorFence: r.priorFence, nextFence: state === 'stopping' ? null : r.priorFence + 1,
      successorAttemptId: state === 'starting' || state === 'running' ? r.successorAttemptId : null, successorFence: state === 'starting' || state === 'running' ? r.priorFence + 1 : null,
      baseSha: DEMO_BASE,
      patch: resumed && r.refusal === null && state !== 'stopping' ? {
        sha256: checkpointDigest(DEMO_BASE, r.files.map((f) => ({ ...f, executable: false }))), fileCount: r.files.length, totalBytes: r.files.reduce((n, f) => n + f.size, 0),
        files: r.files.map((f) => ({ ...f, added: dropped ? null : 2, removed: dropped ? null : 0, hasDiff: dropped === null, binary: false })), stat: dropped ? null : { added: 2 * r.files.length, removed: 0 },
      } : null,
      exclusions: state === 'stopping' ? [] : r.exclusions, refusal: state !== 'stopping' && r.refusal ? { code: r.refusal, text: HANDOVER_REASON_TEXT[r.refusal] ?? r.refusal } : null,
      estimate: estimate(null), latePublishes: 0, requestedAt: new Date(r.requestedAtMs).toISOString(),
      fencedAt: state === 'stopping' ? null : new Date(r.requestedAtMs + DEMO_HANDOVER_STEPS.fencedMs).toISOString(), updatedAt: new Date(now).toISOString(),
      releasedAt: r.decision?.choice === 'release' ? new Date(r.decision.atMs).toISOString() : null, releasedBy: r.decision?.choice === 'release' ? OWNER : null, successorRetries: 0,
      contentDropped: dropped && r.mode === 'resume' ? { at: new Date(now).toISOString(), reason: dropped, text: HANDOVER_CLOSE_TEXT[dropped] ?? dropped } : null,
      closed: state === 'declined' ? { reason: 'declined', text: HANDOVER_CLOSE_TEXT['declined']! } : null,
    };
  }

  function taskViews(projectId: string, now: number): HandoverTaskView[] {
    const snap = d.snapshotOf(projectId);
    const mine = listOf(projectId);
    const out: HandoverTaskView[] = [];
    for (const t of Object.values(snap.tasks).sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
      const current = mine.filter((r) => r.taskId === t.taskId).at(-1) ?? null;
      const attempt = t.activeAttemptId ? snap.attempts[t.activeAttemptId] : undefined;
      if (t.status !== 'running' && current === null) continue;
      const worker = attempt ? Object.values(snap.workers).find((w) => w.attemptId === attempt.attemptId) : undefined;
      const open = current !== null && (OPEN_HANDOVER_STATES as readonly string[]).includes(stateOf(current, now)) && !(stateOf(current, now) === 'running' && t.status !== 'running');
      const reasons: HandoverIneligible[] = [];
      // As on the server: a handover in hand says so first, whatever the task's status is while it waits.
      if (open) reasons.push('handover_open');
      else if (t.status !== 'running' || !attempt) reasons.push('task_not_running');
      else if (worker?.execution !== 'local') reasons.push('attempt_not_local');
      else if (t.cancelRequested) reasons.push('cancel_pending');
      const elapsed = attempt ? Math.max(0, Math.round((now - Date.parse(attempt.startedAt)) / 1000)) : null;
      out.push({
        taskId: t.taskId, status: t.status,
        attempt: attempt ? { attemptId: attempt.attemptId, fence: attempt.fence ?? 1, runnerId: attempt.runnerId, location: worker?.execution === 'cloud' ? 'cloud' : 'local', startedAt: attempt.startedAt } : null,
        baseSha: DEMO_BASE, allowedPaths: [t.role === 'frontend' ? 'src' : 'server'],
        resume: { eligible: reasons.length === 0, reasons, reasonText: reasons.map((r) => HANDOVER_REASON_TEXT[r] ?? r) },
        restart: { eligible: reasons.length === 0, target: reasons.length === 0 ? 'cloud' : null, reasons, reasonText: reasons.map((r) => HANDOVER_REASON_TEXT[r] ?? r) },
        estimate: estimate(elapsed), excludes: EXCLUDES, current: current ? recordView(current, now) : null,
      });
    }
    return out;
  }

  const view = (projectId: string): HandoversView => {
    const now = d.nowMs(projectId);
    return { projectId, observedAt: new Date(now).toISOString(), notice: DEMO_HANDOVER_NOTICE, tasks: taskViews(projectId, now), records: [...listOf(projectId)].reverse().map((r) => recordView(r, now)) };
  };

  /** The successor starts, on the cloud runner, after the fence: the same events the claim records. */
  function scheduleSuccessor(projectId: string, r: DemoRecord, delayMs: number, revisionStep: number, location: 'cloud' | 'local' = 'cloud'): void {
    const fence = r.priorFence + 1;
    d.emit(projectId, r.taskId, 'attempt.started', { fence, attemptNumber: fence, runnerId: location === 'cloud' ? CLOUD_RUNNER : LOCAL_RUNNER, location, modelRoute: 'cloud', amountUsd: 0.5, reservationId: `res_${r.successorAttemptId}` }, { delayMs, attemptId: r.successorAttemptId, revisionStep });
    if (location === 'cloud') d.emit(projectId, r.taskId, 'attempt.route_changed', { checkpointId: r.checkpointId, mode: r.decision?.choice === 'restart' ? 'restart' : r.mode, fromAttemptId: r.priorAttemptId, toAttemptId: r.successorAttemptId, from: 'local', to: 'cloud', priorFence: r.priorFence, fence }, { delayMs, attemptId: r.successorAttemptId, revisionStep });
  }

  return {
    async get(projectId) {
      return view(projectId);
    },
    async diff(projectId, taskId, checkpointId, path) {
      const r = listOf(projectId).find((x) => x.checkpointId === checkpointId && x.taskId === taskId);
      const f = r?.files.find((x) => x.path === path);
      if (!r || !f || stateOf(r, d.nowMs(projectId)) !== 'awaiting_review') throw refuse('That file\'s diff is not kept: the checkpoint is not waiting for review.');
      return { checkpointId, path, status: f.status, size: f.size, sha256: f.sha256, binary: false, added: 2, removed: 0, lines: [['+', `export const handoverDemo = '${taskId}';`], ['+', '']], redacted: false };
    },
    async act(projectId, action) {
      const replay = keys.get(`${projectId}:${action.kind}:${action.idempotencyKey}`);
      if (replay !== undefined) return view(projectId);
      const now = d.nowMs(projectId);
      if (action.kind === 'request') {
        const t = taskViews(projectId, now).find((x) => x.taskId === action.taskId);
        if (!t) throw refuse(HANDOVER_REASON_TEXT['task_not_running']!);
        const verdict = action.mode === 'resume' ? t.resume : t.restart;
        if (!verdict.eligible || t.attempt === null) throw refuse(verdict.reasonText[0] ?? 'This task cannot continue in cloud.');
        const snap = d.snapshotOf(projectId);
        const task = snap.tasks[action.taskId]!;
        const path = t.allowedPaths[0]!;
        // The demo frontend task changed a secret-bearing file inside its own paths: the checkpoint cannot be carried whole, so a restart is offered.
        const required = task.role === 'frontend' && action.mode === 'resume';
        const body = `export const handoverDemo = '${task.taskId}';\n`;
        const r: DemoRecord = {
          checkpointId: `ckpt_demo_${listOf(projectId).length + 1}`, taskId: task.taskId, runId: task.runId, revision: task.revision, mode: action.mode,
          priorAttemptId: t.attempt.attemptId, priorFence: t.attempt.fence, requestedAtMs: now, refusal: required ? 'required_file_excluded' : null, decision: null,
          successorAttemptId: `att_demo_cloud_${listOf(projectId).length + 1}`,
          files: action.mode === 'resume' ? [{ path: `${path}/handover-demo.ts`, status: 'added', size: body.length, sha256: sha256Hex(body) }] : [],
          exclusions: action.mode === 'resume' ? [{ path: required ? `${path}/.env.local` : '.env', reason: 'secret_file_name' }, { path: 'notes/scratch.md', reason: 'outside_allowed_paths' }] : [],
        };
        listOf(projectId).push(r);
        keys.set(`${projectId}:${action.kind}:${action.idempotencyKey}`, r.checkpointId);
        d.emit(projectId, r.taskId, 'handover.requested', { checkpointId: r.checkpointId, mode: r.mode, target: 'cloud', priorAttemptId: r.priorAttemptId, priorFence: r.priorFence, baseSha: DEMO_BASE }, { attemptId: r.priorAttemptId, revisionStep: 1 });
        const fenceAt = DEMO_HANDOVER_STEPS.fencedMs;
        d.emit(projectId, r.taskId, 'attempt.failed', { fence: r.priorFence, reason: 'handover', outcome: 'interrupted' }, { delayMs: fenceAt, attemptId: r.priorAttemptId, revisionStep: 2 });
        d.emit(projectId, r.taskId, 'attempt.fenced', { checkpointId: r.checkpointId, priorAttemptId: r.priorAttemptId, priorFence: r.priorFence, nextFence: r.priorFence + 1, cause: 'acknowledged' }, { delayMs: fenceAt, attemptId: r.priorAttemptId, revisionStep: 2 });
        d.emit(projectId, r.taskId, 'task.ready', { reason: 'handover' }, { delayMs: fenceAt, attemptId: r.priorAttemptId, revisionStep: 2 });
        if (required) d.emit(projectId, r.taskId, 'checkpoint.refused', { checkpointId: r.checkpointId, reason: 'required_file_excluded' }, { delayMs: fenceAt, attemptId: r.priorAttemptId, revisionStep: 2 });
        else if (r.mode === 'restart') scheduleSuccessor(projectId, r, DEMO_HANDOVER_STEPS.startingMs, 3);
        return view(projectId);
      }
      const r = listOf(projectId).find((x) => x.checkpointId === action.checkpointId && x.taskId === action.taskId);
      const allowed: Readonly<Record<string, readonly HandoverState[]>> = { release: ['awaiting_review'], restart: ['awaiting_review', 'restart_offered'], decline: ['awaiting_review', 'fenced', 'restart_offered'] };
      if (!r || !(allowed[action.choice] ?? []).includes(stateOf(r, now))) throw refuse(action.choice === 'release' ? 'There is no checkpoint waiting for your review on this task.' : 'There is nothing to answer for this task.');
      r.decision = { choice: action.choice, atMs: now };
      keys.set(`${projectId}:${action.kind}:${action.idempotencyKey}`, r.checkpointId);
      d.emit(projectId, r.taskId, 'handover.decided', { checkpointId: r.checkpointId, choice: action.choice, target: 'cloud' }, { revisionStep: 1 });
      // A restart starts in cloud from the persisted input; kept where it is, a local runner takes it as policy places it.
      // A release or a restart starts in cloud; kept where it is, a local runner takes it as policy places it.
      scheduleSuccessor(projectId, r, DEMO_HANDOVER_STEPS.startingMs - DEMO_HANDOVER_STEPS.fencedMs, 2, action.choice === 'decline' ? 'local' : 'cloud');
      return view(projectId);
    },
  };
}
