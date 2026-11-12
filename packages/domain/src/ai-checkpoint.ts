import { z } from 'zod';
import { strongerLabel } from './brain.ts';
import { redactSecrets } from './redact.ts';
import { ROUTE_RESUMES, RoutePolicyModeSchema, RouteStepKindSchema, suggestRoute, type RoutePolicyMode, type RouteSuggestion, type RouteSuggestionContext, type RouteSuggestionRule } from './route-policy.ts';

/**
 * H12: persistent AI step checkpoints. Every AI step, and every chain of calls one step makes (the PM turn; the patch agent's file choice, patch and re-ask; review;
 * plan draft; criteria; triage), marks where it stands at each stage boundary, so a step that stopped (offline, too large for the device, a local result that failed
 * its checks, waiting on the owner, a changed route, the budget) can continue later from that stage rather than from scratch.
 *
 * Storage is split by label, as a hard rule: a checkpoint whose labels include restricted or secret (or anything that is not a label), or whose call was locked,
 * is kept only in this browser (IndexedDB, per project and owner) and is never sent to the server. Every other one is stored by the server, owner only and project
 * scoped, so it survives a browser close; the server refuses a restricted or locked one the same way the H5 context backstop refuses restricted output.
 *
 * A checkpoint holds ids, hashes, sizes, codes, and text only with its label (the PM's turns). Never a prompt, a bundle, file contents or a model's answer.
 */
/**
 * Why a step stopped. `budget`: the step's first pause was the run's budget (missing or spent); a step that paused for another reason keeps that reason, and a
 * later budget block is recorded as a problem on it (fix round 2, N3). `awaiting_owner` is reserved: nothing sets it yet; a step that waits
 * for the owner is shown through its Action items ask, with the stop reason it already had.
 */
export const AI_CHECKPOINT_STOP_REASONS = ['offline', 'input_too_large_for_device', 'local_failed_checks', 'awaiting_owner', 'route_changed', 'budget'] as const;
export type AiCheckpointStopReason = (typeof AI_CHECKPOINT_STOP_REASONS)[number];

/** The stage boundaries. `context`: the task context was read; the others name the call that just finished (or stopped). */
export const AI_CHECKPOINT_STAGES = ['context', 'file_choice', 'patch', 'reask', 'criteria', 'breakdown', 'review', 'triage', 'pr_description', 'plan_draft', 'pm_turn'] as const;
export type AiCheckpointStage = (typeof AI_CHECKPOINT_STAGES)[number];

/**
 * `running`: between stages. `waiting`: stopped, with a stop reason, until it is resumed, moved or dropped. `done`: the step finished (kept as memory). `sent`: sent
 * after reconnecting. `escalated`: continued in the cloud after its local result failed checks. `moved_to_device`: the owner moved it to device only. `dropped`.
 * Fix round 1: `sending`, claimed by one tab to send it (M1), and `abandoned`, a step left `running` (its tab closed mid-step) for 30 minutes (M6).
 */
export const AI_CHECKPOINT_STATUSES = ['running', 'waiting', 'sending', 'done', 'sent', 'escalated', 'moved_to_device', 'dropped', 'abandoned'] as const;
export type AiCheckpointStatus = (typeof AI_CHECKPOINT_STATUSES)[number];

/** Where the step may continue, from the H2 route and the H3 lock when it stopped. */
export const AI_CHECKPOINT_CONTINUATIONS = ['device_only', 'cloud_capable'] as const;
export type AiCheckpointContinuation = (typeof AI_CHECKPOINT_CONTINUATIONS)[number];

/** How a resumed call ran. Recorded on the call's route record too, so it reads "Sent after reconnecting", never as a fallback. */
export const AI_CHECKPOINT_RESUMES = ROUTE_RESUMES;
export type AiCheckpointResume = (typeof AI_CHECKPOINT_RESUMES)[number];

const Label = z.enum(['public', 'internal', 'restricted', 'secret']);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const RecordId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const Iso = z.iso.datetime();

/** One labelled text a checkpoint carries: a PM turn. Its label goes with it everywhere, and decides where the checkpoint may be stored. */
export const AiCheckpointTextSchema = z.strictObject({ who: z.enum(['owner', 'pm']), text: z.string().max(2000), classification: Label });
export type AiCheckpointText = z.infer<typeof AiCheckpointTextSchema>;

export const AiCheckpointSchema = z.strictObject({
  checkpointId: z.string().regex(/^ckp_[A-Za-z0-9_-]{8,80}$/),
  projectId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  taskRevision: z.number().int().min(1),
  runId: z.string().min(1).max(200),
  /** The accepted plan revision when the step ran. Null: the run had none the browser could read. */
  planRevision: z.number().int().min(0).nullable(),
  stepKind: RouteStepKindSchema,
  stage: z.enum(AI_CHECKPOINT_STAGES),
  /** The step's one-call override, kept so a resume is the same call. Never stored as a task's route. */
  callOverride: RoutePolicyModeSchema.nullable(),
  /** The effective mode when it stopped (with the call override, after the lock). */
  routeMode: RoutePolicyModeSchema.nullable(),
  continuation: z.enum(AI_CHECKPOINT_CONTINUATIONS),
  /** Every label the step read: the task, the bundle, the files, the question. Restricted or secret keeps the checkpoint on the device. */
  labels: z.array(Label).min(1).max(16),
  /** The call's route was locked to the device. */
  locked: z.boolean(),
  inputs: z.strictObject({
    /** The served context the step read (H5): a resume reads a new one, and the server judges that one. */
    contextId: RecordId.nullable(),
    /** sha256 of the bundle's pinned revisions and claims, to tell whether the context changed. */
    bundleSha256: Hex64.nullable(),
    /** The files the step chose and their hashes at the base commit (paths only, never contents). */
    files: z.array(z.strictObject({ path: z.string().min(1).max(512), sha256: Hex64.nullable() })).max(20),
    /** The prompt's size, in characters. */
    inputChars: z.number().int().min(0).nullable(),
    /** A triage step: the failed check it read. */
    checkId: RecordId.nullable().optional(),
    /** A review or PR description: sha256 of the change it read. */
    changeSha256: Hex64.nullable().optional(),
  }),
  /** What the chain has so far: the checks' issue codes (`<json path> <code>`, never the answer), and the PM's turns with their labels. */
  partial: z.strictObject({ issues: z.array(z.string().max(160).regex(/^[^\n]*$/)).max(20), texts: z.array(AiCheckpointTextSchema).max(8) }).nullable(),
  stopReason: z.enum(AI_CHECKPOINT_STOP_REASONS).nullable(),
  status: z.enum(AI_CHECKPOINT_STATUSES),
  /** The route record of the last call the step made. */
  routeRecordId: RecordId.nullable(),
  /** Set once, when the step was escalated to the cloud: a reload can never escalate it again. */
  escalatedAt: Iso.nullable(),
  resumedAs: z.enum(AI_CHECKPOINT_RESUMES).nullable(),
  /**
   * Fix round 2 (N3): why its last re-validation did not send it (codes such as `budget_missing`), kept with it. The stop reason still says why it first paused.
   */
  problems: z.array(z.string().regex(/^[a-z][a-z_]{0,39}$/)).max(10).optional(),
  /**
   * Fix round 2 (N4): the token the server gave the tab that claimed this checkpoint for sending. A save to a `sending` row must carry it. Never stored in the body,
   * never shown, never kept on the device.
   */
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  /** Fix round 1 (I3): kept on this device only, whatever its labels say now (its route was locked, or the server judged it restricted). Never sent. */
  deviceOnly: z.boolean().optional(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type AiCheckpoint = z.infer<typeof AiCheckpointSchema>;

/** The strongest label a checkpoint carries: its own labels, its texts' labels, and restricted if its call was locked. Anything that is not a label reads as secret. */
export function checkpointLabel(cp: Pick<AiCheckpoint, 'labels' | 'locked' | 'partial'>): string {
  const all: unknown[] = [...cp.labels, ...(cp.partial?.texts ?? []).map((t) => t.classification), ...(cp.locked ? ['restricted'] : [])];
  return all.reduce<string>((acc, l) => strongerLabel(acc, l), 'public');
}

/** Where a checkpoint is kept: on the server only when everything it carries is public or internal and its call was not locked. */
export function checkpointStorage(cp: Pick<AiCheckpoint, 'labels' | 'locked' | 'partial'> & { readonly deviceOnly?: boolean | undefined }): 'device' | 'server' {
  const l = checkpointLabel(cp);
  return !cp.locked && cp.deviceOnly !== true && (l === 'public' || l === 'internal') ? 'server' : 'device';
}

/** Why the server refuses to store a checkpoint, or null. Restricted first, then secret-shaped text anywhere it carries text. */
export function serverCheckpointRefusal(cp: AiCheckpoint): 'checkpoint_restricted' | 'checkpoint_secret' | null {
  if (checkpointStorage(cp) !== 'server') return 'checkpoint_restricted';
  const texts = [...(cp.partial?.texts ?? []).map((t) => t.text), ...(cp.partial?.issues ?? []), ...cp.inputs.files.map((f) => f.path)];
  return texts.some((t) => redactSecrets(t) !== t) ? 'checkpoint_secret' : null;
}

/** Where a stopped step may continue: device only under the lock, on a Local only route, or with no route; otherwise the cloud is allowed. */
export function continuationFor(route: { readonly mode: RoutePolicyMode | null; readonly locked: boolean }): AiCheckpointContinuation {
  return route.locked || route.mode === null || route.mode === 'ONLY_ON_DEVICE' ? 'device_only' : 'cloud_capable';
}

/** The stop reason an adapter refusal code means, or null when the code is not a pause (a refusal that a later try would not change). */
export function stopReasonFor(code: string | null | undefined): AiCheckpointStopReason | null {
  switch (code) {
    case 'offline': return 'offline';
    case 'input_too_large_for_device': return 'input_too_large_for_device';
    case 'route_changed_in_queue': return 'route_changed';
    case 'budget': return 'budget';
    default: return null;
  }
}

// ---- re-validation before a resume --------------------------------------------------------------------------------------------

/** What is true now, read fresh before a waiting checkpoint is sent. */
export interface CheckpointRecheck {
  /** The fresh route read (H2): the effective mode with the checkpoint's call override, and whether a lock is in force. Null: the read failed. */
  readonly route: { readonly mode: RoutePolicyMode | null; readonly lock: boolean } | null;
  /** The task's current revision. Null: unknown. */
  readonly taskRevision: number | null;
  /** The run's budget for a cloud call (`checkpointBudget`). */
  readonly budget: 'ok' | 'missing' | 'exhausted';
  /** The step's inputs as they are now. Null: they could not be read, so they count as changed. */
  readonly inputs: { readonly bundleSha256?: string | null; readonly files?: readonly { readonly path: string; readonly sha256: string | null }[]; readonly changeSha256?: string | null; readonly checkId?: string | null } | null;
  /**
   * The context backstop (H5): the server served a context for this destination, no stronger than the destination allows. `not_applicable`: the step reads no task
   * context (web research sends only the question), so there is none to check.
   */
  readonly context: 'ok' | 'refused' | 'not_applicable';
}

export const CHECKPOINT_PROBLEMS = ['not_waiting', 'route_unreadable', 'route_changed', 'locked', 'revision_changed', 'inputs_changed', 'budget_missing', 'budget_exhausted', 'context_refused'] as const;
export type CheckpointProblem = (typeof CHECKPOINT_PROBLEMS)[number];
export type CheckpointRevalidation = { readonly ok: true } | { readonly ok: false; readonly problems: readonly CheckpointProblem[] };

/**
 * Re-validates a waiting checkpoint before anything is sent. Every change is named; any one stops the send. `to`: where the resume would run. The budget only
 * matters for the cloud. A lock now in force is always a problem: the checkpoint was made without it.
 */
/** `escalation`: the step is escalated, so its mode changes on purpose (Local first to the cloud); every other check still applies. */
export function revalidateCheckpoint(cp: AiCheckpoint, now: CheckpointRecheck, to: 'cloud' | 'device' = 'cloud', opts: { readonly escalation?: boolean } = {}): CheckpointRevalidation {
  if (cp.status !== 'waiting') return { ok: false, problems: ['not_waiting'] };
  if (now.route === null) return { ok: false, problems: ['route_unreadable'] };
  const problems: CheckpointProblem[] = [];
  if (opts.escalation ? now.route.mode === null : to === 'cloud' ? now.route.mode !== cp.routeMode : now.route.mode === null) problems.push('route_changed');
  if (now.route.lock && !cp.locked) problems.push('locked');
  if (now.taskRevision !== null && now.taskRevision !== cp.taskRevision) problems.push('revision_changed');
  const i = now.inputs;
  const sameFiles = (a: readonly { path: string; sha256: string | null }[], b: readonly { path: string; sha256: string | null }[] | undefined) =>
    b !== undefined && a.length === b.length && a.every((f) => b.some((g) => g.path === f.path && g.sha256 === f.sha256));
  const changed = i === null
    || (cp.inputs.bundleSha256 !== null && i.bundleSha256 !== undefined && i.bundleSha256 !== cp.inputs.bundleSha256)
    || (cp.inputs.files.length > 0 && !sameFiles(cp.inputs.files, i.files))
    || (cp.inputs.changeSha256 != null && i.changeSha256 !== undefined && i.changeSha256 !== cp.inputs.changeSha256)
    || (cp.inputs.checkId != null && i.checkId !== undefined && i.checkId !== cp.inputs.checkId);
  if (changed) problems.push('inputs_changed');
  if (to === 'cloud' && now.budget !== 'ok') problems.push(now.budget === 'missing' ? 'budget_missing' : 'budget_exhausted');
  if (now.context === 'refused') problems.push('context_refused');
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * The run's budget for a cloud step, from the budget fields that exist (the run's limit as its policy reports it). Missing is never unlimited: a limit that is only
 * recommended or unresolved counts as missing. A run stopped for budget, or a limit of zero, is spent.
 */
export function checkpointBudget(limit: { readonly value: number | null; readonly basis: string } | null | undefined, stopped: boolean): 'ok' | 'missing' | 'exhausted' {
  if (!limit || limit.basis !== 'configured' || limit.value === null || !Number.isFinite(limit.value)) return 'missing';
  if (stopped || limit.value <= 0) return 'exhausted';
  return 'ok';
}

// ---- escalation ---------------------------------------------------------------------------------------------------------------

export type EscalationDecision = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_failed_checks' | 'already_escalated' | 'not_local_first' | 'locked' | 'device_only' };

/**
 * Whether a stopped step may continue in the cloud because its local result failed its checks. Only on Local first (both the task's route now and the mode the
 * call itself ran under), never for a call pinned to the device, never on Local only and never on locked or restricted data, and at most once: the escalation is recorded on the checkpoint, so a reload cannot do it twice.
 */
export function escalationDecision(cp: AiCheckpoint, route: { readonly mode: RoutePolicyMode | null; readonly lock: boolean }): EscalationDecision {
  if (cp.stopReason !== 'local_failed_checks' || cp.status !== 'waiting') return { ok: false, reason: 'not_failed_checks' };
  if (cp.escalatedAt !== null) return { ok: false, reason: 'already_escalated' };
  if (route.lock || cp.locked || checkpointStorage(cp) !== 'server') return { ok: false, reason: 'locked' };
  // Fix round 1 (H1): the call's own choice counts, not only the task's. A call the owner pinned to the device (its override, or a device-only continuation) is
  // never sent to the cloud, whatever the task's route says; and the call itself must have run Local first.
  if (cp.callOverride === 'ONLY_ON_DEVICE' || cp.continuation !== 'cloud_capable') return { ok: false, reason: 'device_only' };
  if (cp.routeMode !== 'PREFER_ON_DEVICE' || route.mode !== 'PREFER_ON_DEVICE') return { ok: false, reason: 'not_local_first' };
  return { ok: true };
}

// ---- who resumes it -----------------------------------------------------------------------------------------------------------

/** Steps that change the plan or reach outside the project: always the owner's call. */
const OWNER_STEPS: ReadonlySet<string> = new Set(['pmPlan', 'pmResearch', 'plan', 'brief']);

/**
 * Inside the accepted plan a checkpoint resumes on its own (the owner's rule: the PM acts within an approved plan); anything outside it goes to Action items. Inside
 * means: the run has an accepted plan, the checkpoint was made under that same revision, the task is one of its tasks, and the step does not change the plan.
 */
export function resumeDisposition(cp: AiCheckpoint, plan: { readonly planRevision: number; readonly taskIds: readonly string[] } | null): 'automatic' | 'owner' {
  if (!plan || plan.planRevision < 1 || cp.planRevision !== plan.planRevision || !plan.taskIds.includes(cp.taskId) || OWNER_STEPS.has(cp.stepKind)) return 'owner';
  return 'automatic';
}

// ---- the PM's route proposals -------------------------------------------------------------------------------------------------

export interface PmPlanRouteInput {
  readonly key: string;
  /** The task's strongest label. Missing counts as restricted. */
  readonly label: unknown;
  /** Estimated input size in characters; null when not estimated. */
  readonly inputChars: number | null;
}
export interface PmPlanRoute {
  readonly key: string;
  readonly mode: RoutePolicyMode;
  readonly rule: RouteSuggestionRule;
  readonly reason: string;
  /** Restricted data: Local only, and the owner cannot pick another mode. */
  readonly locked: boolean;
}

/**
 * The route the Project Manager proposes for each task of a plan it drafts, with its reason: suggestRoute's own rule, on its own inputs (the task's label, its size,
 * whether the browser is offline or the cloud budget is spent), for the task's main step (the patch). The owner accepts the routes with the plan; nothing is applied
 * before that, and the lock still decides at every call.
 */
export function pmPlanRoutes(tasks: readonly PmPlanRouteInput[], ctx: RouteSuggestionContext): PmPlanRoute[] {
  return tasks.map((t) => {
    const s: RouteSuggestion = suggestRoute({ label: t.label === undefined || t.label === null ? 'restricted' : t.label, stepKind: 'patch', inputChars: t.inputChars }, ctx);
    return { key: t.key, mode: s.mode, rule: s.rule, reason: s.reason, locked: s.locked };
  });
}
