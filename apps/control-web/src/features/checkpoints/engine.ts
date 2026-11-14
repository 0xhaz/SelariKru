import {
  canonicalJson, checkpointBudget, checkpointStorage, continuationFor, effectiveRoutePolicy, escalationDecision, isCloudCapable, resumeDisposition, revalidateCheckpoint, routeLockFor, sha256Hex,
  stopReasonFor,
  type AiCheckpoint, type AiCheckpointResume, type AiCheckpointStage, type AiCheckpointText, type CheckpointProblem, type CheckpointRecheck, type RoutePolicyMode, type RouteStepKind,
} from '@selarikru/domain';
import type { AgentResult, PlanBriefPayload } from '@selarikru/inference-firebase-web';
import { decodeBriefTexts } from '../pm/brief.ts';
import type { EngineeringDataSource, ProjectViewSnapshot, TaskAgentContext, TaskBaseFiles, TaskRouteRead } from '@selarikru/view-protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AgentActionKind } from '../hybrid/model.ts';
import type { StageMark } from '../hybrid/runner.ts';
import type { DeviceCheckpointStore } from './device-store.ts';

/**
 * H12: the browser side of AI step checkpoints. Each step (and each chain of calls one step makes) is one checkpoint, updated at every stage boundary the runner
 * marks. A step that stops is kept `waiting` with its stop reason; the offline queue is the waiting ones. Every checkpoint is kept on this device (IndexedDB), so the
 * queue works offline and survives a reload; only a public or internal one is also stored by the server, so it survives a browser close. A restricted or locked one
 * never leaves this device.
 *
 * On reconnect every waiting checkpoint is re-validated before anything is sent: a fresh route read (H2), the lock, the run's budget, its inputs (revision, context,
 * files) and the context backstop (H5: the server serves the context again and judges it). Inside the accepted plan it is sent on its own; outside it the owner is
 * asked in Action items. A Local first step whose local result failed its checks is escalated to the cloud from its stage, at most once, and never on Local only or
 * locked data.
 */
export type CheckpointOwnerAsk = 'resume' | 'escalate';

export interface CheckpointState {
  readonly checkpoints: Readonly<Record<string, AiCheckpoint>>;
  /** Why a waiting checkpoint was not sent, from its last re-validation. */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  /** Waiting for the owner: outside the accepted plan. */
  readonly asks: Readonly<Record<string, CheckpointOwnerAsk>>;
  readonly busy: Readonly<Record<string, boolean>>;
  /** Kept on this device only (restricted, locked, or the server did not take it). */
  readonly deviceOnly: Readonly<Record<string, boolean>>;
  /** Fix round 2: abandoned steps the owner ran again or dismissed, so they leave the list. This tab only. */
  readonly dismissed: Readonly<Record<string, boolean>>;
}

/** What a resumed step runs through: the agents port (which starts its own recorder, continuing this checkpoint). */
export interface CheckpointRunner {
  run(req: { taskId: string; kind: AgentActionKind; callOverride: RoutePolicyMode | null; resume?: { checkpointId: string; kind: AiCheckpointResume; files?: readonly { path: string; sha256: string | null }[]; priorIssues?: readonly string[] } }): Promise<unknown>;
  pm(req: { kind: 'pmAnswer' | 'pmResearch' | 'pmPlan' | 'pmDelegate' | 'pmVerify' | 'pmVerifyNoWeb'; subjectTaskId: string; question: string; questionClassification: 'internal' | 'restricted'; history: readonly never[]; callOverride: RoutePolicyMode | null; resume?: { checkpointId: string; kind: AiCheckpointResume }; brief?: PlanBriefPayload; briefSha256?: string }): Promise<unknown>;
}

export interface CheckpointEngineDeps {
  readonly projectId: string;
  /** Who the device store is scoped to: the signed-in owner (or the demo's operator). */
  readonly ownerKey: string;
  readonly device: DeviceCheckpointStore;
  readonly server: Pick<EngineeringDataSource, 'saveAiCheckpoint' | 'listAiCheckpoints' | 'claimAiCheckpointEscalation' | 'claimAiCheckpointSend' | 'deleteAiCheckpoint'> | null;
  readonly getTaskRoute: (taskId: string) => Promise<TaskRouteRead>;
  readonly getTaskContext: (taskId: string, destination: 'local' | 'cloud', callOverride: RoutePolicyMode | null, contextId: string) => Promise<TaskAgentContext>;
  /** Fix round 1 (H2): the task's files at its base, to check a paused patch's chosen files are unchanged. Absent: they cannot be checked, so they count as changed. */
  readonly getTaskFiles?: (taskId: string, paths: readonly string[]) => Promise<TaskBaseFiles>;
  readonly snapshot: () => ProjectViewSnapshot | null;
  readonly isOnline: () => boolean;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Fix round 3: where this viewer's dismissed abandoned steps are remembered (a per-viewer convenience). Default: the browser's localStorage. Any failure is
   * ignored: the page works the same without it.
   */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /**
   * H13: the hash of the plan brief the owner has approved now for this checkpoint's run and task, or null when none is approved (edited since, or this tab was
   * reloaded). A paused check is sent only with the brief it was approved with. Absent: none, so a paused check is never sent on its own.
   */
  readonly currentBriefSha?: (cp: AiCheckpoint) => string | null;
}

export interface ChainStart {
  readonly taskId: string;
  readonly stepKind: RouteStepKind;
  readonly callOverride: RoutePolicyMode | null;
  /** Continues this checkpoint (a resume). */
  readonly resumeOf?: string;
  readonly resumedAs?: AiCheckpointResume;
  /** A PM turn: the owner's question, with its label. */
  readonly texts?: readonly AiCheckpointText[];
  /**
   * H13: a step that reads no task context (a plan brief check sends only the approved brief): what its checkpoint is made from, so a pause is kept. Its texts
   * are the brief, with its label.
   */
  readonly noContext?: { readonly runId: string; readonly taskRevision: number; readonly planRevision: number | null; readonly labels: AiCheckpoint['labels']; readonly briefSha256: string };
}

/** How a step ended, as the agents port returns it. */
export type ChainOutcome =
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'result'; readonly result: AgentResult; readonly context: TaskAgentContext | null; readonly simulated?: boolean };

export interface ChainRecorder {
  readonly id: string;
  stage(mark: StageMark): void;
  /** `reply`: a PM turn's answer, with its label. */
  finish(outcome: ChainOutcome, reply?: AiCheckpointText): Promise<void>;
}

const STAGE_OF_KIND: Partial<Record<RouteStepKind, AiCheckpointStage>> = { pmPlan: 'plan_draft', pmAnswer: 'pm_turn', pmResearch: 'pm_turn', pmDelegate: 'pm_turn', plan: 'plan_draft', pmVerify: 'pm_turn', pmVerifyNoWeb: 'pm_turn' };
/** H13: the plan brief's cloud checks: they read no task context and send only the approved brief. */
const BRIEF_CHECKS: ReadonlySet<string> = new Set(['pmVerify', 'pmVerifyNoWeb']);
/** Steps that only ever run in the cloud: never moved to this device, never escalated (fix round 1, H1). */
export const CLOUD_ONLY_STEPS: ReadonlySet<string> = new Set(['pmVerify', 'pmVerifyNoWeb', 'pmResearch']);
const TASK_STEPS: ReadonlySet<string> = new Set(['criteria', 'breakdown', 'patch', 'review', 'triage', 'prDescription']);
const PM_STEPS: ReadonlySet<string> = new Set(['pmAnswer', 'pmResearch', 'pmPlan', 'pmDelegate']);
const webResearchOn = (snap: ProjectViewSnapshot | null, runId: string): boolean => snap?.settings.some((x) => x.scope === 'run' && x.key === runId && x.field === 'web_research' && x.desired === true) ?? false;
const LABELS = new Set(['public', 'internal', 'restricted', 'secret']);
const asLabel = (l: unknown): 'public' | 'internal' | 'restricted' | 'secret' => (typeof l === 'string' && LABELS.has(l) ? l as never : 'restricted');
const bundleSha = (c: TaskAgentContext): string => sha256Hex(canonicalJson({ pinned: c.bundle.pinned, claims: c.bundle.claims }));
/** Fix round 1 (M6): how long a running step may sit before it is abandoned, and how long a closed one is kept on this device. */
export const ABANDON_AFTER_MS = 30 * 60_000;
export const PURGE_AFTER_MS = 7 * 86_400_000;
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['done', 'sent', 'escalated', 'moved_to_device', 'dropped', 'abandoned']);
const codeOf = (e: unknown): string => /^([a-z_]+):/.exec(e instanceof Error ? e.message : '')?.[1] ?? '';
/**
 * H9 step 0 (F1): the server's refusals of a checkpoint write. Only these mean the server's copy won and is adopted here. Every other failure (offline, a network
 * error, any 5xx, a 401 while the token is renewed) never settled anything: the write is kept and sent again on reconnect.
 */
export const CHECKPOINT_REFUSALS: ReadonlySet<string> = new Set(['checkpoint_closed', 'checkpoint_claimed', 'checkpoint_not_found', 'invalid_request', 'checkpoint_secret', 'checkpoint_deleted']);
const isRefusal = (e: unknown): boolean => CHECKPOINT_REFUSALS.has(codeOf(e));

export interface CheckpointEngine {
  readonly store: StoreApi<CheckpointState>;
  attach(runner: CheckpointRunner): void;
  begin(start: ChainStart): ChainRecorder;
  /** H13: keeps a checkpoint that is not a step (the plan brief notes), under the same split: on this device always, on the server only when it may be. */
  /**
   * H13 fix round 1 (H2): `server: false` keeps it on this device only, for now (the notes while they are typed, before their label is settled). A restricted one
   * is always kept on this device only, and a server copy made earlier is deleted.
   */
  keep(cp: AiCheckpoint, opts?: { readonly server?: boolean }): Promise<void>;
  /** Reads the device's and the server's checkpoints for this project. */
  load(): Promise<void>;
  /** Re-validates and, where allowed, sends every waiting checkpoint. */
  reconnect(): Promise<void>;
  process(id: string): Promise<void>;
  /** The owner's Resume (or the plan's own): re-validated first, then sent as it was, after reconnecting. */
  resume(id: string): Promise<void>;
  escalate(id: string): Promise<void>;
  moveToDevice(id: string): Promise<void>;
  drop(id: string): Promise<void>;
  /** Fix round 2: an abandoned step, run again from scratch (a fresh step with its own checkpoint, not a resume). */
  runAgain(id: string): Promise<void>;
  /** Fix round 2: takes an abandoned step off the list without running it. */
  dismiss(id: string): void;
}

export function createCheckpointEngine(deps: CheckpointEngineDeps): CheckpointEngine {
  const storage = deps.storage !== undefined ? deps.storage : (typeof localStorage === 'undefined' ? null : localStorage);
  const dismissedKey = `selarikru.dismissed-abandoned.${deps.ownerKey}.${deps.projectId}`;
  const readDismissed = (): Record<string, boolean> => {
    try {
      const raw = storage?.getItem(dismissedKey);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(ids) ? Object.fromEntries(ids.filter((x): x is string => typeof x === 'string').slice(0, 500).map((x) => [x, true])) : {};
    } catch { return {}; }
  };
  const store = createStore<CheckpointState>()(() => ({ checkpoints: {}, problems: {}, asks: {}, busy: {}, deviceOnly: {}, dismissed: readDismissed() }));
  const keepDismissed = (): void => {
    try { storage?.setItem(dismissedKey, JSON.stringify(Object.keys(store.getState().dismissed).slice(-500))); } catch { /* a convenience only */ }
  };
  const now = (): string => (deps.now ?? (() => new Date()))().toISOString();
  const newId = deps.newId ?? (() => `ckp_${crypto.randomUUID().replace(/-/g, '')}`);
  const newCtx = (): string => `ctx_${crypto.randomUUID().replace(/-/g, '')}`;
  let runner: CheckpointRunner | null = null;
  const writes = new Map<string, Promise<void>>();
  /** Fix round 2 (N1): checkpoints whose last server write did not arrive. H9 step 0 (F2): mirrored on the device, so the list survives a reload. */
  const unsynced = new Set<string>();
  const markUnsynced = async (id: string, on: boolean): Promise<void> => {
    if (on === unsynced.has(id)) return;
    if (on) unsynced.add(id); else unsynced.delete(id);
    try { await deps.device.setUnsynced(deps.ownerKey, deps.projectId, id, on); } catch { /* No device storage: this tab still remembers it. */ }
  };
  /** H13 fix round 1 (H2): checkpoints the server holds (it took a save, or listed them), so a copy that becomes restricted is deleted there. */
  const onServer = new Set<string>();
  /** Deletes the server's copy of a checkpoint that may no longer be stored there. A failure is kept as unsynced and tried again on reconnect. */
  const tombstone = async (id: string): Promise<void> => {
    if (!deps.server?.deleteAiCheckpoint || (!onServer.has(id) && !unsynced.has(id))) return;
    try {
      await deps.server.deleteAiCheckpoint(deps.projectId, id);
      onServer.delete(id);
      await markUnsynced(id, false);
    } catch {
      await markUnsynced(id, true);
    }
  };
  /** Fix round 2 (N4): the claim token this tab holds for a checkpoint it is sending. Sent with its writes; never stored on the device. */
  const claimTokens = new Map<string, string>();

  const patch = (fn: (s: CheckpointState) => Partial<CheckpointState>): void => store.setState((s) => ({ ...s, ...fn(s) }));
  const setFor = <K extends 'problems' | 'asks' | 'busy' | 'deviceOnly' | 'dismissed'>(key: K, id: string, v: CheckpointState[K][string] | undefined): void =>
    patch((s) => { const next = { ...s[key] } as Record<string, unknown>; if (v === undefined) delete next[id]; else next[id] = v; return { [key]: next } as Partial<CheckpointState>; });

  /** Every checkpoint is kept on this device; a public or internal one also goes to the server. One write at a time per checkpoint, in order. */
  function write(cp: AiCheckpoint): Promise<void> {
    patch((s) => ({ checkpoints: { ...s.checkpoints, [cp.checkpointId]: cp } }));
    const prev = writes.get(cp.checkpointId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const toServer = deps.server?.saveAiCheckpoint && checkpointStorage(cp) === 'server' && !store.getState().deviceOnly[cp.checkpointId];
      // Fix round 1 (I3): a device-only checkpoint says so itself, so the mark survives a reload.
      const kept = toServer ? cp : { ...cp, deviceOnly: true };
      try { await deps.device.put(deps.ownerKey, kept); } catch { /* No device storage: the screen still holds it for this tab. */ }
      if (!toServer) { setFor('deviceOnly', cp.checkpointId, true); await tombstone(cp.checkpointId); return; }
      try {
        const token = claimTokens.get(cp.checkpointId);
        await deps.server!.saveAiCheckpoint!(deps.projectId, token !== undefined ? { ...cp, claimToken: token } : cp);
        onServer.add(cp.checkpointId);
        // The save that ends the send spends the token.
        if (token !== undefined) claimTokens.delete(cp.checkpointId);
        await markUnsynced(cp.checkpointId, false);
      } catch (e) {
        // Fix round 2 (N1), round 3 (R2), H9 step 0 (F1): a known refusal (closed, claimed by another tab) means the server's copy won: it is adopted here, and this
        // write is dropped. Anything else (offline, a 5xx, a 401) settled nothing: the write is kept to send again on reconnect.
        if (codeOf(e) === 'checkpoint_restricted') await markUnsynced(cp.checkpointId, false);
        else if (isRefusal(e)) {
          await markUnsynced(cp.checkpointId, false);
          await adoptServerCopy(cp.checkpointId);
        } else await markUnsynced(cp.checkpointId, true);
        // The server judged it restricted (its own backstop): it stays on this device from now on. Any other failure keeps it here until the next write.
        if (codeOf(e) === 'checkpoint_restricted') {
          setFor('deviceOnly', cp.checkpointId, true);
          try { await deps.device.put(deps.ownerKey, { ...cp, deviceOnly: true }); } catch { /* as above */ }
        }
      }
    });
    writes.set(cp.checkpointId, next);
    return next;
  }

  function begin(start: ChainStart): ChainRecorder {
    const prior = start.resumeOf ? store.getState().checkpoints[start.resumeOf] : undefined;
    const id = prior?.checkpointId ?? newId();
    const at = now();
    let draft: AiCheckpoint | null = prior ? { ...prior } : null;
    let pending: Partial<AiCheckpoint> & { labels?: AiCheckpoint['labels'] } = {};
    const texts: AiCheckpointText[] = [...(prior?.partial?.texts ?? start.texts ?? [])];
    const base = (c: TaskAgentContext, contextId: string): AiCheckpoint => ({
      checkpointId: id, projectId: deps.projectId, taskId: start.taskId, taskRevision: c.revision, runId: c.runId, planRevision: c.planRevision,
      stepKind: start.stepKind, stage: 'context', callOverride: start.callOverride, routeMode: null, continuation: 'device_only', labels: ['restricted'], locked: false,
      inputs: { contextId, bundleSha256: bundleSha(c), files: [], inputChars: null, ...(c.change ? { changeSha256: sha256Hex(c.change.diff) } : {}) },
      partial: texts.length > 0 ? { issues: [], texts } : null, stopReason: null, status: 'running', routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: at, updatedAt: at,
    });
    const labelsOf = (c: TaskAgentContext): AiCheckpoint['labels'] => [asLabel(c.task.classification), asLabel(c.bundle.contentLabel)];
    const update = (over: Partial<AiCheckpoint>): AiCheckpoint | null => {
      if (!draft) { pending = { ...pending, ...over }; return null; }
      draft = { ...draft, ...over, updatedAt: now() };
      return draft;
    };
    const fromResult = (r: AgentResult): Partial<AiCheckpoint> => {
      const mode = r.proposal.route?.effectiveMode ?? null;
      return {
        routeRecordId: r.report?.requestId ?? r.proposal.requestId, locked: (draft?.locked ?? false) || r.locked, routeMode: mode,
        continuation: continuationFor({ mode, locked: (draft?.locked ?? false) || r.locked }),
        inputs: { ...(draft?.inputs ?? { contextId: null, bundleSha256: null, files: [], inputChars: null }), inputChars: r.proposal.input?.chars ?? draft?.inputs.inputChars ?? null },
      };
    };
    return {
      id,
      stage(mark) {
        if (mark.context && mark.contextId) {
          // A resume keeps the checkpoint it continues (its inputs as they were); a new step starts its own here.
          if (!draft) draft = { ...base(mark.context, mark.contextId), ...pending, labels: labelsOf(mark.context) };
          else draft = { ...draft, labels: [...new Set([...draft.labels, ...labelsOf(mark.context)])] as AiCheckpoint['labels'], updatedAt: now() };
          // Fix round 1 (I3): the route the step read decides first. A lock (a restricted predecessor, a Brain source, the project) makes it locked and device-only
          // before its first write, whatever the context's own labels say.
          if (mark.route?.lock) draft = { ...draft, locked: true, deviceOnly: true, continuation: 'device_only' };
        } else if (mark.files) {
          update({ stage: 'file_choice', inputs: { ...(draft?.inputs ?? { contextId: null, bundleSha256: null, files: [], inputChars: null }), files: mark.files.map((f) => ({ ...f })) } });
        } else if (mark.result) {
          update({ ...fromResult(mark.result), stage: mark.stage });
        }
        if (draft && draft.status === 'running') void write(draft);
      },
      async finish(outcome, reply) {
        if (outcome.kind === 'refused') {
          // A resume that could not be continued keeps its checkpoint waiting, and says why. A new step that was refused is not a pause.
          if (prior) {
            setFor('problems', id, [outcome.code === 'inputs_changed' ? 'inputs_changed' : outcome.code.startsWith('context') ? 'context_refused' : outcome.code]);
            setFor('busy', id, undefined);
            return;
          }
          if (draft) await write({ ...draft, status: 'done', updatedAt: now() });
          return;
        }
        if (!draft && outcome.context) draft = { ...base(outcome.context, outcome.context ? 'unknown_ctx' : ''), labels: labelsOf(outcome.context) };
        if (!draft && start.noContext) {
          const n = start.noContext;
          draft = {
            checkpointId: id, projectId: deps.projectId, taskId: start.taskId, taskRevision: Math.max(1, n.taskRevision), runId: n.runId, planRevision: n.planRevision, stepKind: start.stepKind, stage: 'pm_turn',
            callOverride: start.callOverride, routeMode: null, continuation: 'device_only', labels: n.labels, locked: false,
            inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null, briefSha256: n.briefSha256 }, partial: texts.length > 0 ? { issues: [], texts: texts.slice(0, 8) } : null,
            stopReason: null, status: 'running', routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: at, updatedAt: at,
          };
        }
        if (!draft) return;
        const r = outcome.result;
        draft = { ...draft, ...fromResult(r), stage: STAGE_OF_KIND[start.stepKind] ?? draft.stage, updatedAt: now() };
        if (reply && r.proposal.status === 'ok') texts.push(reply);
        // A PM turn that read restricted text is restricted, and so is everything about it.
        if (r.locked) for (let i = 0; i < texts.length; i++) texts[i] = { ...texts[i]!, classification: 'restricted' };
        // A brief check's texts are its brief: kept whole, in order.
        if (texts.length > 0) draft = { ...draft, partial: { issues: draft.partial?.issues ?? [], texts: BRIEF_CHECKS.has(start.stepKind) ? texts.slice(0, 8) : texts.slice(-8) } };
        let stop = stopReasonFor(r.proposal.blockedReason);
        const localFailed = !stop && r.proposal.status === 'invalid' && r.proposal.observedSource === 'ON_DEVICE' && TASK_STEPS.has(start.stepKind);
        if (localFailed) stop = 'local_failed_checks';
        let cp: AiCheckpoint;
        if (stop) {
          const issues = localFailed ? r.proposal.validation.errors.slice(0, 20).map((x) => x.slice(0, 160).replace(/\n/g, ' ')) : (draft.partial?.issues ?? []);
          cp = { ...draft, status: 'waiting', stopReason: stop, partial: { issues, texts: draft.partial?.texts ?? [] } };
        } else {
          const status = !start.resumedAs ? 'done' : start.resumedAs === 'after_reconnect' || start.resumedAs === 'owner_resume' ? 'sent' : start.resumedAs === 'escalated' ? 'escalated' : 'moved_to_device';
          const { problems: _cleared, ...rest } = draft;
          void _cleared;
          cp = { ...rest, status, stopReason: null, resumedAs: start.resumedAs ?? null };
          setFor('problems', id, undefined);
          setFor('asks', id, undefined);
        }
        setFor('busy', id, undefined);
        await write(cp);
        // A new pause is judged at once (escalation, or the owner's ask); offline ones wait for the connection inside `process`.
        if (cp.status === 'waiting' && (cp.stopReason === 'local_failed_checks' || prior === undefined)) await process(id);
      },
    };
  }

  /** What is true now, read fresh: the route (with the checkpoint's call override), the lock, the revision, the budget, and the context again (the backstop). */
  async function recheck(cp: AiCheckpoint): Promise<CheckpointRecheck> {
    let read: TaskRouteRead;
    try { read = await deps.getTaskRoute(cp.taskId); } catch { return { route: null, taskRevision: null, budget: 'missing', inputs: null, context: 'refused' }; }
    const lock = read.route.lock ? routeLockFor([read.route.lock.label]) : null;
    const mode = effectiveRoutePolicy({ call: cp.callOverride, task: read.route.override, run: read.route.runDefault, lock }).mode;
    const run = deps.snapshot()?.runs[cp.runId];
    const budget = checkpointBudget(run?.policy?.budgetLimitUsd ?? null, run !== undefined && (run.scopeAssessment !== null || run.lifecycle === 'cancelled'));
    let inputs: { -readonly [K in keyof NonNullable<CheckpointRecheck['inputs']>]: NonNullable<CheckpointRecheck['inputs']>[K] } | null = {};
    let context: CheckpointRecheck['context'] = 'ok';
    if (BRIEF_CHECKS.has(cp.stepKind)) {
      // H13: a check reads no task context; its input is the approved brief, by hash, and the web check needs the run's web research setting on now.
      const snapNow = deps.snapshot();
      return { route: { mode, lock: lock !== null }, taskRevision: read.revision, budget, inputs: { briefSha256: deps.currentBriefSha?.(cp) ?? null }, context: 'not_applicable', ...(cp.stepKind === 'pmVerify' ? { webResearch: webResearchOn(snapNow, cp.runId) } : {}) };
    }
    if (cp.stepKind === 'pmResearch') {
      // Research reads no task context: there is nothing to serve or check (fix round 1, M4).
      inputs = {};
      context = 'not_applicable';
    } else if (mode !== null) {
      try {
        const c = await deps.getTaskContext(cp.taskId, isCloudCapable(mode) ? 'cloud' : 'local', cp.callOverride, newCtx());
        inputs = { bundleSha256: bundleSha(c), ...(c.change ? { changeSha256: sha256Hex(c.change.diff) } : {}) };
        if (!['public', 'internal'].includes(String(c.bundle.contentLabel)) && isCloudCapable(mode)) context = 'refused';
      } catch {
        context = 'refused';
      }
    }
    // Fix round 1 (H2): a patch's chosen files, read again at the base and hashed. Any read that fails, or a file gone, leaves them unchecked: inputs changed.
    if (cp.inputs.files.length > 0 && inputs !== null) {
      try {
        const now = deps.getTaskFiles ? await deps.getTaskFiles(cp.taskId, cp.inputs.files.map((f) => f.path)) : null;
        if (now) inputs = { ...inputs, files: now.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })) };
      } catch { /* left unchecked: counts as changed */ }
    }
    return { route: { mode, lock: lock !== null }, taskRevision: read.revision, budget, inputs, context };
  }

  const planOf = (cp: AiCheckpoint) => {
    const snap = deps.snapshot();
    const run = snap?.runs[cp.runId];
    return run ? { planRevision: run.planRevision, taskIds: Object.values(snap!.tasks).filter((t) => t.runId === cp.runId).map((t) => t.taskId) } : null;
  };

  async function send(cp: AiCheckpoint, how: AiCheckpointResume, callOverride: RoutePolicyMode | null): Promise<void> {
    if (!runner) return;
    setFor('busy', cp.checkpointId, true);
    setFor('asks', cp.checkpointId, undefined);
    let claimed = false;
    try {
      // Fix round 1 (M1): one tab sends it. A stored checkpoint is claimed on the server first (waiting → sending); an escalation was claimed already.
      // Fix round 2 (N1): a device run sends nothing, so it needs no claim and works offline; its closing save syncs through the write-through.
      if (how !== 'escalated' && how !== 'device_only' && deps.server?.claimAiCheckpointSend && !store.getState().deviceOnly[cp.checkpointId] && checkpointStorage(cp) === 'server') {
        const claim = async () => {
          const c = await deps.server!.claimAiCheckpointSend!(deps.projectId, cp.checkpointId);
          if (c.claimToken) claimTokens.set(cp.checkpointId, c.claimToken);
        };
        try {
          try { await claim(); } catch (e) {
            // The server does not have it (it was kept only here, say while the server was unreachable): store it, then claim it.
            if (codeOf(e) !== 'checkpoint_not_found') throw e;
            await write(cp);
            await claim();
          }
          claimed = true;
        } catch (e) {
          setFor('problems', cp.checkpointId, [codeOf(e) === 'checkpoint_claimed' ? 'claimed' : 'claim_failed']);
          return;
        }
      }
      if (BRIEF_CHECKS.has(cp.stepKind)) {
        const brief = decodeBriefTexts(cp.partial?.texts ?? []);
        if (!brief || !cp.inputs.briefSha256) return;
        await runner.pm({ kind: cp.stepKind as 'pmVerify' | 'pmVerifyNoWeb', subjectTaskId: cp.taskId, question: '', questionClassification: 'internal', history: [], callOverride, brief, briefSha256: cp.inputs.briefSha256, resume: { checkpointId: cp.checkpointId, kind: how } });
      } else if (PM_STEPS.has(cp.stepKind)) {
        const q = cp.partial?.texts.find((t) => t.who === 'owner');
        if (!q) return;
        await runner.pm({ kind: cp.stepKind as never, subjectTaskId: cp.taskId, question: q.text, questionClassification: q.classification === 'restricted' || q.classification === 'secret' ? 'restricted' : 'internal', history: [], callOverride, resume: { checkpointId: cp.checkpointId, kind: how } });
      } else {
        await runner.run({ taskId: cp.taskId, kind: cp.stepKind as AgentActionKind, callOverride, resume: { checkpointId: cp.checkpointId, kind: how, ...(cp.inputs.files.length > 0 ? { files: cp.inputs.files } : {}), ...(cp.partial && cp.partial.issues.length > 0 ? { priorIssues: cp.partial.issues } : {}) } });
      }
    } finally {
      // Fix round 2 (N2): a claim is released on every exit that is not a closing write (the runner refused it, its files changed, a PM checkpoint had no
      // question): the row goes back to waiting, with why, so a later Resume can claim it again.
      const after = store.getState().checkpoints[cp.checkpointId];
      if (claimed && after && after.status === 'waiting') await write({ ...after, updatedAt: now() });
      setFor('busy', cp.checkpointId, undefined);
    }
  }

  /** The server's copy of one checkpoint, adopted here (store and device) in place of ours. Null: the server has none, or could not be read. */
  async function adoptServerCopy(id: string): Promise<AiCheckpoint | null> {
    if (!deps.server?.listAiCheckpoints) return null;
    let theirs: AiCheckpoint | undefined;
    try { theirs = (await deps.server.listAiCheckpoints(deps.projectId)).find((c) => c.checkpointId === id); } catch { return null; }
    if (!theirs) return null;
    const adopted = theirs;
    patch((s) => ({ checkpoints: { ...s.checkpoints, [id]: adopted } }));
    try { await deps.device.put(deps.ownerKey, adopted); } catch { /* the screen still holds it */ }
    return adopted;
  }

  /**
   * Accepted behaviour (fix round 3, R5): a step whose closing save failed (it finished, but the server never took `sent`) and whose tab was then reloaded is read
   * back as `running` or `sending`; after 30 minutes it shows as Abandoned, and Run again starts it from scratch. Nothing is sent twice by that: the server still
   * holds its own copy, and a refused write adopts it.
   *
   * Fix round 3 (R1): a step left running or sending is closed as abandoned server first. Offline nothing is marked: it waits for the connection. A stored
   * checkpoint is written to the server first and changed here only after it took it; a refusal (another tab still holds its claim) adopts the server's copy.
   * A device-only one has no server to ask and is closed here.
   */
  async function abandon(cp: AiCheckpoint): Promise<void> {
    if (!deps.isOnline()) return;
    const next: AiCheckpoint = { ...cp, status: 'abandoned', updatedAt: now() };
    const stored = deps.server?.saveAiCheckpoint && checkpointStorage(cp) === 'server' && !store.getState().deviceOnly[cp.checkpointId];
    if (stored) {
      try { await deps.server!.saveAiCheckpoint!(deps.projectId, next); } catch (e) {
        if (isRefusal(e)) await adoptServerCopy(cp.checkpointId);
        return;
      }
    }
    patch((s) => ({ checkpoints: { ...s.checkpoints, [cp.checkpointId]: next } }));
    try { await deps.device.put(deps.ownerKey, { ...next, ...(stored ? {} : { deviceOnly: true }) }); } catch { /* the screen still holds it */ }
  }

  /**
   * Re-validates before a cloud send (fix round 1, I1): an escalation skips only the route comparison. Says why when it fails; a budget that blocks it becomes the
   * checkpoint's stop reason (`budget`), so the queue shows it as waiting on the budget, not on the connection.
   */
  async function revalidated(cp: AiCheckpoint, escalation: boolean): Promise<boolean> {
    const v = revalidateCheckpoint(cp, await recheck(cp), 'cloud', { escalation });
    if (v.ok) return true;
    setFor('problems', cp.checkpointId, v.problems);
    setFor('asks', cp.checkpointId, undefined);
    // Fix round 2 (N3): a budget block never erases why the step paused (offline, a local result that failed its checks): it is kept as a problem on the
    // checkpoint, so once a budget is set the step continues as what it was (an escalation stays an escalation).
    if (v.problems.some((p) => p === 'budget_missing' || p === 'budget_exhausted')) {
      const current = store.getState().checkpoints[cp.checkpointId] ?? cp;
      await write({ ...current, problems: [...v.problems], updatedAt: now() });
    }
    return false;
  }

  async function process(id: string): Promise<void> {
    const cp = store.getState().checkpoints[id];
    if (!cp || cp.status !== 'waiting' || store.getState().busy[id]) return;
    if (cp.stopReason === 'local_failed_checks') {
      let read: TaskRouteRead;
      try { read = await deps.getTaskRoute(cp.taskId); } catch { setFor('problems', id, ['route_unreadable']); return; }
      const lock = read.route.lock ? routeLockFor([read.route.lock.label]) : null;
      const mode = effectiveRoutePolicy({ call: null, task: read.route.override, run: read.route.runDefault, lock }).mode;
      const d = escalationDecision(cp, { mode, lock: lock !== null });
      if (!d.ok) { setFor('problems', id, [d.reason]); return; }
      if (!deps.isOnline()) { setFor('problems', id, undefined); return; }
      // Fix round 1 (I1): the full re-validation, as for any cloud send, before it is offered or done.
      if (!(await revalidated(cp, true))) return;
      if (resumeDisposition(cp, planOf(cp)) === 'automatic') await escalate(id);
      else { setFor('problems', id, undefined); setFor('asks', id, 'escalate'); }
      return;
    }
    // H9: a step paused by the hosted demo's cloud call cap is never sent from this tab: it may be moved to this device or dropped.
    if (cp.continuation !== 'cloud_capable' || !deps.isOnline() || cp.stopReason === 'cloud_quota') return;
    // Fix round 1 (M1): busy before the re-check, so a second trigger (reconnect, the owner's button) does not send it again.
    setFor('busy', id, true);
    let ok: boolean;
    try { ok = await revalidated(cp, false); } finally { setFor('busy', id, undefined); }
    if (!ok) return;
    setFor('problems', id, undefined);
    if (cp.stopReason === 'offline' && resumeDisposition(cp, planOf(cp)) === 'automatic') await send(cp, 'after_reconnect', cp.callOverride);
    else setFor('asks', id, 'resume');
  }

  async function escalate(id: string): Promise<void> {
    const cp = store.getState().checkpoints[id];
    if (cp && CLOUD_ONLY_STEPS.has(cp.stepKind)) return;
    if (!cp || cp.status !== 'waiting' || cp.escalatedAt !== null || !deps.server?.claimAiCheckpointEscalation || store.getState().deviceOnly[id]) {
      if (cp && cp.status === 'waiting') setFor('problems', id, [cp.escalatedAt !== null ? 'already_escalated' : 'locked']);
      return;
    }
    if (!(await revalidated(cp, true))) return;
    // Claimed once, by the server: a reload or a second tab cannot escalate it again.
    let claimed: AiCheckpoint;
    try { claimed = await deps.server.claimAiCheckpointEscalation(deps.projectId, id); } catch (e) {
      setFor('problems', id, [/already_escalated/.test(e instanceof Error ? e.message : '') ? 'already_escalated' : codeOf(e) || 'escalation_refused']);
      return;
    }
    patch((s) => ({ checkpoints: { ...s.checkpoints, [id]: { ...cp, escalatedAt: claimed.escalatedAt } } }));
    await send({ ...cp, escalatedAt: claimed.escalatedAt }, 'escalated', 'ONLY_IN_CLOUD');
  }

  return {
    store,
    attach(r) { runner = r; },
    begin,
    async keep(cp, opts = {}) {
      if (opts.server === false && checkpointStorage(cp) === 'server' && !store.getState().deviceOnly[cp.checkpointId]) {
        // On this device only, for now: not marked device-only and not unsynced, so a later save with the server still stores it.
        patch((s) => ({ checkpoints: { ...s.checkpoints, [cp.checkpointId]: cp } }));
        try { await deps.device.put(deps.ownerKey, cp); } catch { /* the screen still holds it */ }
        return;
      }
      await write(cp);
    },
    async load() {
      const mine = await deps.device.list(deps.ownerKey, deps.projectId).catch(() => [] as AiCheckpoint[]);
      const theirs = deps.server?.listAiCheckpoints ? await deps.server.listAiCheckpoints(deps.projectId).catch(() => [] as AiCheckpoint[]) : [];
      for (const c of theirs) onServer.add(c.checkpointId);
      // H9 step 0 (F2): what this device wrote and the server never took is read back, so it is sent on reconnect.
      for (const id of await deps.device.listUnsynced(deps.ownerKey, deps.projectId).catch(() => [] as string[])) unsynced.add(id);
      const merged: Record<string, AiCheckpoint> = { ...store.getState().checkpoints };
      const serverById = new Map(theirs.map((c) => [c.checkpointId, c]));
      const deviceById = new Map(mine.map((c) => [c.checkpointId, c]));
      // H9 step 0 (F2): this browser's clock and the server's differ, so the time stamps alone cannot decide. A copy this device wrote that the server never took
      // wins, and a server copy still waiting never replaces a copy this device has closed. Otherwise the newer copy wins.
      const choose = (id: string, local: AiCheckpoint | undefined, server: AiCheckpoint | undefined): AiCheckpoint => {
        if (!local) return server!;
        if (!server) return local;
        if (unsynced.has(id) || (CLOSED_STATUSES.has(local.status) && server.status === 'waiting')) return local;
        return local.updatedAt >= server.updatedAt ? local : server;
      };
      for (const id of new Set([...serverById.keys(), ...deviceById.keys()])) {
        const cp = choose(id, deviceById.get(id), serverById.get(id));
        const had = merged[id];
        // An escalation recorded anywhere is never forgotten.
        const escalatedAt = had?.escalatedAt ?? serverById.get(id)?.escalatedAt ?? deviceById.get(id)?.escalatedAt ?? cp.escalatedAt;
        merged[id] = { ...(!had || cp.updatedAt >= had.updatedAt ? cp : had), escalatedAt };
      }
      patch(() => ({ checkpoints: merged }));
      for (const cp of mine) if (cp.deviceOnly === true || checkpointStorage(cp) !== 'server') setFor('deviceOnly', cp.checkpointId, true);
      // The reasons a waiting checkpoint was last held back (fix round 2, N3) are shown again after a reload.
      for (const cp of Object.values(merged)) if (cp.status === 'waiting' && cp.problems && cp.problems.length > 0) setFor('problems', cp.checkpointId, cp.problems);
      // Fix round 1 (M6): a step left running (its tab closed mid-step) for 30 minutes is closed as abandoned, here and on the server; a closed checkpoint older
      // than 7 days is purged from this device. Waiting ones are kept: they are the queue.
      const at = (deps.now ?? (() => new Date()))().getTime();
      for (const cp of Object.values(merged)) {
        const age = at - Date.parse(cp.updatedAt);
        if ((cp.status === 'running' || cp.status === 'sending') && age > ABANDON_AFTER_MS) await abandon(cp);
        else if (CLOSED_STATUSES.has(cp.status) && age > PURGE_AFTER_MS) {
          try { await deps.device.remove(deps.ownerKey, deps.projectId, cp.checkpointId); } catch { /* left for the next load */ }
          patch((s) => { const next = { ...s.checkpoints }; delete next[cp.checkpointId]; return { checkpoints: next }; });
        }
      }
    },
    async reconnect() {
      // First the server is told what changed here while it could not be reached (fix round 2, N1), then the queue is re-validated and sent.
      for (const id of [...unsynced]) { const cp = store.getState().checkpoints[id]; if (cp) await write(cp); }
      for (const cp of Object.values(store.getState().checkpoints)) if (cp.status === 'waiting') await process(cp.checkpointId);
    },
    process,
    async resume(id) {
      const cp = store.getState().checkpoints[id];
      if (!cp || cp.status !== 'waiting' || cp.continuation !== 'cloud_capable' || store.getState().busy[id]) return;
      // Fix round 1 (M1, M4): busy before the re-check, which runs again on every Resume.
      setFor('busy', id, true);
      let ok: boolean;
      try { ok = await revalidated(cp, false); } finally { setFor('busy', id, undefined); }
      if (!ok) return;
      // M1: a step the cloud quota, the rate limit or the budget stopped was not waiting for a connection; the owner's Resume is recorded as theirs.
      await send(cp, cp.stopReason === 'cloud_rate_limited' || cp.stopReason === 'budget' ? 'owner_resume' : 'after_reconnect', cp.callOverride);
    },
    escalate,
    async moveToDevice(id) {
      const cp = store.getState().checkpoints[id];
      // H13 fix round 1 (H1): a cloud check (web research, a brief check) cannot run on this device: it is dropped or checked again, never moved.
      if (!cp || cp.status !== 'waiting' || CLOUD_ONLY_STEPS.has(cp.stepKind)) return;
      await send(cp, 'device_only', 'ONLY_ON_DEVICE');
    },
    async runAgain(id) {
      const cp = store.getState().checkpoints[id];
      if (!cp || cp.status !== 'abandoned' || !runner) return;
      setFor('dismissed', id, true);
      keepDismissed();
      if (BRIEF_CHECKS.has(cp.stepKind)) {
        // Run again only with the brief approved now: the same hash, or nothing is sent.
        const brief = decodeBriefTexts(cp.partial?.texts ?? []);
        if (brief && cp.inputs.briefSha256 && deps.currentBriefSha?.(cp) === cp.inputs.briefSha256) await runner.pm({ kind: cp.stepKind as 'pmVerify' | 'pmVerifyNoWeb', subjectTaskId: cp.taskId, question: '', questionClassification: 'internal', history: [], callOverride: cp.callOverride, brief, briefSha256: cp.inputs.briefSha256 });
        return;
      }
      if (PM_STEPS.has(cp.stepKind)) {
        const q = cp.partial?.texts.find((t) => t.who === 'owner');
        if (q) await runner.pm({ kind: cp.stepKind as never, subjectTaskId: cp.taskId, question: q.text, questionClassification: q.classification === 'restricted' || q.classification === 'secret' ? 'restricted' : 'internal', history: [], callOverride: cp.callOverride });
        return;
      }
      await runner.run({ taskId: cp.taskId, kind: cp.stepKind as AgentActionKind, callOverride: cp.callOverride });
    },
    dismiss(id) { setFor('dismissed', id, true); keepDismissed(); },
    async drop(id) {
      const cp = store.getState().checkpoints[id];
      if (!cp || cp.status !== 'waiting') return;
      setFor('asks', id, undefined);
      setFor('problems', id, undefined);
      await write({ ...cp, status: 'dropped', updatedAt: now() });
    },
  };
}

export type { CheckpointProblem };

/** A store with nothing in it, for screens with no engine (hooks need a store either way). */
export const EMPTY_CHECKPOINT_STORE: StoreApi<CheckpointState> = createStore<CheckpointState>()(() => ({ checkpoints: {}, problems: {}, asks: {}, busy: {}, deviceOnly: {}, dismissed: {} }));
