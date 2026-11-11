import { z } from 'zod';
import { strongerLabel } from './brain.ts';
import { INFERENCE_CHOICES } from './onboarding.ts';

/**
 * Where each AI step of a task runs: Firebase AI Logic's four modes (plan.md §4.1). A run has a default, seeded from the onboarding choice; a task may override it; an
 * AI step may override it for that one call, and a call override is never stored. Restricted or secret data locks a task to the device: the lock is derived from
 * the task's labels on every read, so no route write can lift it. Only a reclassification decision that lowers the labels does.
 *
 * This is server-enforced metadata. The browser adapter reads the effective policy for the task and still applies its own restricted no-cloud rule; what it reports
 * back about where a response ran is untrusted and labelled as reported by the browser.
 */
export const ROUTE_POLICY_MODES = INFERENCE_CHOICES;
export const RoutePolicyModeSchema = z.enum(INFERENCE_CHOICES);
export type RoutePolicyMode = z.infer<typeof RoutePolicyModeSchema>;

/** The words the UI shows for each mode. Inference only: worker execution is a separate axis with its own labels. */
export const ROUTE_POLICY_LABELS: Readonly<Record<RoutePolicyMode, string>> = {
  ONLY_ON_DEVICE: 'Local only', PREFER_ON_DEVICE: 'Local first', ONLY_IN_CLOUD: 'Cloud only', PREFER_IN_CLOUD: 'Cloud first',
};

/** Where the effective policy came from. `lock`: restricted data forced it. `unset`: nothing chosen, which blocks the step; missing is never a default. */
export const ROUTE_POLICY_SOURCES = ['call', 'task', 'run', 'lock', 'unset'] as const;
export type RoutePolicySource = (typeof ROUTE_POLICY_SOURCES)[number];

/** Every mode but ONLY_ON_DEVICE can put the prompt in the cloud: PREFER_ON_DEVICE falls back there when the device model is not ready. */
export const isCloudCapable = (mode: RoutePolicyMode): boolean => mode !== 'ONLY_ON_DEVICE';

// ---- the data lock ------------------------------------------------------------------------------------------------------------

export const ROUTE_LOCK_CODE = 'route_locked_restricted';
export interface RouteLock {
  readonly label: 'restricted' | 'secret';
  readonly code: typeof ROUTE_LOCK_CODE;
  readonly reason: string;
}

/**
 * The lock for a task whose sources carry these labels: the strongest label by the Brain's own fold (`strongerLabel`, which reads anything that is not a label as
 * `secret`). Restricted or secret locks the task to the device. No labels at all is no lock; a caller always passes at least the task's own label.
 */
export function routeLockFor(labels: readonly unknown[]): RouteLock | null {
  if (labels.length === 0) return null;
  const strongest = labels.reduce<string>((acc, l) => strongerLabel(acc, l), 'public');
  if (strongest !== 'restricted' && strongest !== 'secret') return null;
  return {
    label: strongest, code: ROUTE_LOCK_CODE,
    reason: `This task reads ${strongest} data, so its AI steps run on this device only and never in the cloud. Only a reclassification decision can lift this.`,
  };
}

// ---- the effective policy -----------------------------------------------------------------------------------------------------

export interface RoutePolicyInput {
  /** This one call's override. Never stored. */
  readonly call?: RoutePolicyMode | null;
  readonly task: RoutePolicyMode | null;
  readonly run: RoutePolicyMode | null;
  readonly lock: RouteLock | null;
}
export interface EffectiveRoutePolicy {
  /** Null: nothing chosen and nothing locked, so the step is blocked until the owner chooses. */
  readonly mode: RoutePolicyMode | null;
  readonly source: RoutePolicySource;
  /** What the call, the task or the run asked for, before the lock. */
  readonly requested: RoutePolicyMode | null;
  readonly requestedSource: Exclude<RoutePolicySource, 'lock'>;
  /** True when the lock replaced a cloud-capable or missing choice. */
  readonly forced: boolean;
}

/** The call override, else the task override, else the run default; then the lock, which no override relaxes. */
export function effectiveRoutePolicy(input: RoutePolicyInput): EffectiveRoutePolicy {
  const call = input.call ?? null;
  const [requested, requestedSource] = call !== null ? [call, 'call' as const] : input.task !== null ? [input.task, 'task' as const] : input.run !== null ? [input.run, 'run' as const] : [null, 'unset' as const];
  if (input.lock && (requested === null || isCloudCapable(requested))) return { mode: 'ONLY_ON_DEVICE', source: 'lock', requested, requestedSource, forced: true };
  return { mode: requested, source: requestedSource, requested, requestedSource, forced: false };
}

// ---- the suggestion -----------------------------------------------------------------------------------------------------------

export const ROUTE_STEP_KINDS = ['brief', 'criteria', 'plan', 'breakdown', 'patch', 'review', 'triage', 'prDescription'] as const;
export const RouteStepKindSchema = z.enum(ROUTE_STEP_KINDS);
export type RouteStepKind = z.infer<typeof RouteStepKindSchema>;

/**
 * Our policy, stated: a bounded step reads one short input (a brief, its criteria, one change, one failure, one PR description); a broad step reads a whole plan or a
 * whole change. Firebase AI Logic only decides whether the device model is available; it does not judge task size.
 */
export const ROUTE_STEP_SCOPE: Readonly<Record<RouteStepKind, 'bounded' | 'broad'>> = {
  brief: 'bounded', criteria: 'bounded', patch: 'bounded', triage: 'bounded', prDescription: 'bounded', plan: 'broad', breakdown: 'broad', review: 'broad',
};

/** The default input budget for the device model, in characters, when the deployment configures none. About 1,500 tokens: well inside Gemini Nano's context. */
export const DEFAULT_NANO_INPUT_BUDGET_CHARS = 6000;

export const ROUTE_SUGGESTION_RULES = ['restricted', 'offline', 'no_cloud_budget', 'long_input', 'broad_step', 'bounded_step'] as const;
export type RouteSuggestionRule = (typeof ROUTE_SUGGESTION_RULES)[number];

export interface RouteSuggestionTask {
  /** The task's strongest source label. */
  readonly label: unknown;
  readonly stepKind: RouteStepKind;
  /** Estimated input size in characters. Null: not estimated. */
  readonly inputChars: number | null;
}
export interface RouteSuggestionContext {
  /** The configured device-model input budget, in characters. Anything but a positive number leaves no room: missing is never unlimited. */
  readonly nanoBudgetChars: number;
  readonly offline?: boolean;
  /** False: the cloud budget is used up. Null or absent: not known, so this rule does not apply. */
  readonly cloudBudgetAvailable?: boolean | null;
}
export interface RouteSuggestion {
  readonly mode: RoutePolicyMode;
  readonly rule: RouteSuggestionRule;
  readonly reason: string;
  /** True only for the restricted row: the owner cannot pick another mode. */
  readonly locked: boolean;
}

/** Shown beside the policy, never applied by itself. Rows in the order of plan.md §4.1: the data rule first, then availability, then size. */
export function suggestRoute(task: RouteSuggestionTask, context: RouteSuggestionContext): RouteSuggestion {
  const lock = routeLockFor([task.label]);
  if (lock) return { mode: 'ONLY_ON_DEVICE', rule: 'restricted', locked: true, reason: `Local only, fixed: this task's data is labelled ${lock.label}, and restricted input never goes to the cloud. Only a reclassification decision changes this.` };
  if (context.offline === true) return { mode: 'ONLY_ON_DEVICE', rule: 'offline', locked: false, reason: 'Local only: you are offline, so only the model on this device can answer.' };
  if (context.cloudBudgetAvailable === false) return { mode: 'ONLY_ON_DEVICE', rule: 'no_cloud_budget', locked: false, reason: 'Local only: the cloud budget is used up, so only the model on this device can answer.' };
  const budget = Number.isFinite(context.nanoBudgetChars) && context.nanoBudgetChars > 0 ? Math.floor(context.nanoBudgetChars) : 0;
  const size = task.inputChars === null ? null : Math.max(0, Math.round(task.inputChars));
  if (size !== null && size > budget) {
    return { mode: 'PREFER_IN_CLOUD', rule: 'long_input', locked: false, reason: `Cloud first: the estimated input of ${size} characters is more than the ${budget}-character budget set for the on-device model.` };
  }
  if (ROUTE_STEP_SCOPE[task.stepKind] === 'broad') {
    return { mode: 'PREFER_IN_CLOUD', rule: 'broad_step', locked: false, reason: `Cloud first: a ${task.stepKind} step reads a whole plan or change, which is beyond the on-device model's context and quality limits.` };
  }
  const fits = size === null ? 'its input size was not estimated' : `its estimated input of ${size} characters fits the ${budget}-character on-device budget`;
  return { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', locked: false, reason: `Local first: a ${task.stepKind} step is short and bounded, and ${fits}. It falls back to the cloud only if the device model is not ready.` };
}

// ---- where a response ran -----------------------------------------------------------------------------------------------------

export const ROUTE_OBSERVED_SOURCES = ['ON_DEVICE', 'IN_CLOUD', 'UNKNOWN'] as const;
export type RouteObservedSource = (typeof ROUTE_OBSERVED_SOURCES)[number];
/** `violation`: an `only` mode answered from the other side. `unverified`: the source is unknown, or no policy was in force, so nothing can be claimed. */
export const ROUTE_CONFORMANCE = ['conforms', 'violation', 'unverified'] as const;
export type RouteConformance = (typeof ROUTE_CONFORMANCE)[number];

/** The sources each mode allows. A request is stricter than the effective mode when it allows no source the effective mode does not. */
const ALLOWED_SOURCES: Readonly<Record<RoutePolicyMode, readonly RouteObservedSource[]>> = {
  ONLY_ON_DEVICE: ['ON_DEVICE'], PREFER_ON_DEVICE: ['ON_DEVICE', 'IN_CLOUD'], ONLY_IN_CLOUD: ['IN_CLOUD'], PREFER_IN_CLOUD: ['ON_DEVICE', 'IN_CLOUD'],
};
const within = (requested: RoutePolicyMode, effective: RoutePolicyMode): boolean => ALLOWED_SOURCES[requested].every((s) => ALLOWED_SOURCES[effective].includes(s));

export interface RouteOutcome {
  /** Null when the source is unknown or no policy was in force. */
  readonly fellBack: boolean | null;
  readonly conformance: RouteConformance;
  /** The `request_mode_mismatch` flag: the mode asked of the SDK is not the effective mode. Stricter is flagged but conforms; wider is a violation. */
  readonly requestModeMismatch: boolean;
}

/**
 * Whether a response fell back, and whether the call conforms to the effective mode. The requested mode counts as much as the observed source: a cloud-capable request on a
 * device-only or locked route is a violation whatever the source says, and any request wider than the effective mode is one too. An unknown source is never counted as
 * either side.
 */
export function routeOutcome(mode: RoutePolicyMode | null, observed: RouteObservedSource, requested: RoutePolicyMode | null = null, locked = false): RouteOutcome {
  const requestModeMismatch = requested !== null && mode !== null && requested !== mode;
  const wideRequest = requested !== null && (((locked || mode === 'ONLY_ON_DEVICE') && isCloudCapable(requested)) || (mode !== null && !within(requested, mode)));
  if (mode === null || observed === 'UNKNOWN') return { fellBack: null, conformance: wideRequest ? 'violation' : 'unverified', requestModeMismatch };
  const primary = mode === 'ONLY_ON_DEVICE' || mode === 'PREFER_ON_DEVICE' ? 'ON_DEVICE' : 'IN_CLOUD';
  const fellBack = observed !== primary;
  const sourceViolation = fellBack && (mode === 'ONLY_ON_DEVICE' || mode === 'ONLY_IN_CLOUD');
  return { fellBack, conformance: wideRequest || sourceViolation ? 'violation' : 'conforms', requestModeMismatch };
}

export const ROUTE_CALL_STATUSES = ['ok', 'invalid', 'blocked', 'route_violation', 'unverified_source', 'error'] as const;
/** A code the adapter writes: lowercase words and colon-separated arguments. Never a sentence. */
const RouteCode = z.string().max(120).regex(/^[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)*$/);
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/);
const Ms = z.number().finite().min(0).max(86_400_000);

/**
 * What the browser reports about one AI call: identifiers, modes, the observed source, timing and the validation result. There is no field for prompt or response text,
 * so nothing restricted can reach the server this way. Untrusted: the server stores it labelled as reported by the browser and decides nothing from it.
 */
export const RouteRecordReportSchema = z.strictObject({
  kind: z.literal('route'),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  stepKind: RouteStepKindSchema,
  /** The override the person chose for this call, if any. */
  callOverride: RoutePolicyModeSchema.nullable(),
  /** The mode the adapter asked the SDK for. Null: blocked before any request. */
  requestedMode: RoutePolicyModeSchema.nullable(),
  observedSource: z.enum(ROUTE_OBSERVED_SOURCES),
  status: z.enum(ROUTE_CALL_STATUSES),
  model: z.strictObject({ cloudModel: ModelId, sdkVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-.][A-Za-z0-9.]{1,20})?$/) }),
  timing: z.strictObject({ totalMs: Ms, firstOutputMs: Ms.nullable() }),
  validation: z.enum(['passed', 'failed', 'not_run']),
  blockedReason: RouteCode.nullable(),
  /** An ok patch call only (H5): the sha256 of its diff, so an accepted proposal can be tied to the output this call produced. A hash, never the output. */
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type RouteRecordReport = z.infer<typeof RouteRecordReportSchema>;

/** One stored route record, as the server keeps and shows it: the browser's report plus what the server worked out from its own rows. */
export const RouteRecordSchema = z.strictObject({
  recordId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().min(1),
  requestId: z.string().min(1),
  stepKind: RouteStepKindSchema,
  callOverride: RoutePolicyModeSchema.nullable(),
  requestedMode: RoutePolicyModeSchema.nullable(),
  /** The server's effective mode for this call: the call override, task override or run default, after the lock. */
  effectiveMode: RoutePolicyModeSchema.nullable(),
  policySource: z.enum(ROUTE_POLICY_SOURCES),
  locked: z.boolean(),
  observedSource: z.enum(ROUTE_OBSERVED_SOURCES),
  /** Derived by the server from the effective mode and the observed source; never taken from the report. Null when the source is unknown. */
  fellBack: z.boolean().nullable(),
  conformance: z.enum(ROUTE_CONFORMANCE),
  /** The requested mode is not the effective mode (`request_mode_mismatch`). Rows written before the flag read as false. */
  requestModeMismatch: z.boolean().default(false),
  status: z.enum(ROUTE_CALL_STATUSES),
  model: z.strictObject({ cloudModel: z.string(), sdkVersion: z.string() }),
  timing: z.strictObject({ totalMs: z.number().int().min(0), firstOutputMs: z.number().int().min(0).nullable() }),
  validation: z.enum(['passed', 'failed', 'not_run']),
  blockedReason: z.string().nullable(),
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reportedBy: z.literal('browser'),
  trust: z.literal('untrusted'),
  reportedAt: z.string(),
});
export type RouteRecord = z.infer<typeof RouteRecordSchema>;
