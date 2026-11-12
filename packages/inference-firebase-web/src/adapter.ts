import { Ajv } from 'ajv';
import {
  DEFAULT_NANO_INPUT_BUDGET_CHARS, RoutePolicyModeSchema, effectiveRoutePolicy, redactSecrets, routeLockFor, routeOutcome, strongerLabel,
  type EffectiveRoutePolicy, type RouteConformance, type RouteLock, type RoutePolicySource, type RouteRecordReport, type RouteStepKind,
} from '@selarikru/domain';
import { FIREBASE_CLOUD_ROUTE, isDestinationGranted, resolveInferenceMode, type InferenceMode, type Policy, type Source } from '@selarikru/policy';
import {
  MODEL_METADATA,
  composePrompt,
  mapInferenceSource,
  narrowSchema,
  payloadSha256,
  systemInstructionFor,
  type ObservedSource,
  type OnboardingOperation,
  type Operation,
} from './models.ts';
import { ReadinessTracker, type Readiness } from './readiness.ts';
import type { AssistantSdk, SdkModel } from './sdk.ts';
import type { SdkGrounding } from './sdk.ts';

export type { ObservedSource, OnboardingOperation, Operation };

export interface AssistRequest {
  readonly projectId: string;
  /** Prompt body. Stays on the request; never copied into telemetry or the proposal. */
  readonly taskText: string;
  readonly allowedRequirementIds: readonly string[];
  /** Classified sources feeding this prompt, supplied by the caller. */
  readonly sources: readonly Source[];
  readonly policy: Policy | undefined;
  /**
   * The task this call is a step of. When present, the adapter reads the task's route fresh from the server (`fetchRoute`) immediately before the call, and the
   * effective policy (this call's override, else the task override, else the run default, after the lock) replaces the policy's preferred mode. Nothing about the
   * route is taken from the caller or a snapshot: only which task, which step, and this call's own override.
   */
  readonly route?: AssistRoute;
}

export interface AssistRoute {
  readonly taskId: string;
  readonly stepKind: RouteStepKind;
  /** This call only. Never stored, and never relaxes the lock. */
  readonly callOverride?: InferenceMode | null;
}

/**
 * One single-turn call as the adapter runs it. The onboarding operations and every catalog agent are one of these. The prompt is built only once the route is
 * known, so what goes into it can depend on where it may run (a cloud-capable call gets only what may leave the device).
 */
export interface CallSpec {
  readonly op: Operation;
  readonly systemInstruction: string;
  /** JSON Schema the SDK constrains the output to; Ajv checks the response against it. Already narrowed to this call's criterion IDs. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** Tells model instances apart: the operation and its narrowing. */
  readonly schemaKey: string;
  /** The output cites criterion IDs, so a call with none is refused. */
  readonly citesCriteria: boolean;
  /** Builds the prompt for the route in force. `cloudCapable`: the model may answer from the cloud. A refusal is a code, and blocks the call. */
  /** `locked`: the call's route is locked to the device (its labels or the server's lock), so restricted input may be read and the result stays here. */
  prompt(at: { readonly mode: InferenceMode; readonly cloudCapable: boolean; readonly locked?: boolean }): { readonly prompt: string } | { readonly refused: string };
  /** Checks a schema-valid response against the call's context. Codes and JSON paths only, never the response's text. Any entry makes the response invalid. */
  check?(data: unknown): readonly string[];
  /** H11: Grounding with Google Search. Only on a cloud-only route that is not locked; anywhere else the call is refused before any model call. */
  readonly grounding?: 'googleSearch';
}

/** A catalog agent's request. It always names its task: there is no agent call without a route. */
export interface AgentCallRequest extends Omit<AssistRequest, 'taskText' | 'route'> {
  readonly route: AssistRoute;
  /** Labels of everything else the prompt reads (the task, the files). Restricted locks the call to the device; secret, or anything that is not a label, blocks it. */
  readonly labels?: readonly unknown[];
  /**
   * The same labels with a device bundle judged by what it holds (H5 fix round 3). Used instead of `labels` only when the route, with them, keeps the call on the device
   * (device only): then nothing reaches the cloud whatever the bundle was built for. Absent: `labels` always.
   */
  readonly deviceLabels?: readonly unknown[];
}

/** The prompt's size against the device model's input budget, in characters (system instruction plus prompt). */
export interface ProposalInput {
  readonly chars: number;
  readonly budgetChars: number;
  readonly overDeviceBudget: boolean;
}

/** What the adapter needs from a fresh route read. A view-protocol `TaskRouteView` is one. */
export interface FreshRoute {
  readonly runDefault: InferenceMode | null;
  readonly override: InferenceMode | null;
  /** Set when the server says restricted or secret data locks the task to the device. */
  readonly lock: { readonly label: string; readonly reason: string } | null;
}
/** Reads one task's route from the server, fresh. A data source's `getTaskRoute(...).route` fits. Any failure blocks the call. */
export type FetchRoute = (projectId: string, taskId: string) => Promise<FreshRoute>;

/** Where this call was meant to run and where it did. Metadata only. */
export interface ProposalRoute {
  readonly taskId: string;
  readonly stepKind: RouteStepKind;
  readonly callOverride: InferenceMode | null;
  /** The effective policy after the lock. Null: unset, so the call was blocked. */
  readonly effectiveMode: InferenceMode | null;
  readonly policySource: RoutePolicySource;
  readonly locked: boolean;
  /** Null when the source is unknown or nothing ran. */
  readonly fellBack: boolean | null;
  readonly conformance: RouteConformance;
  /** The mode asked of the SDK is not the effective mode. */
  readonly requestModeMismatch: boolean;
}

export type ProposalStatus = 'ok' | 'invalid' | 'blocked' | 'route_violation' | 'unverified_source' | 'error';

export interface ProposalUsage {
  readonly status: 'observed' | 'unavailable';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface ProposalValidation {
  /** Schema validation only (Ajv, request schema). Semantic and allowed-ID checks are T3.2. */
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly errors: readonly string[];
}

/** Untrusted browser output. It cannot run commands, grant tools, authorize spend or satisfy verification. */
export interface AssistantProposal {
  readonly trust: 'untrusted_proposal';
  readonly status: ProposalStatus;
  readonly operation: Operation;
  readonly data: unknown;
  readonly requestId: string;
  readonly requestedMode: InferenceMode | null;
  readonly observedSource: ObservedSource;
  /** The SDK's raw `inferenceSource`, kept for evidence. */
  readonly rawInferenceSource: string | null;
  readonly model: { readonly cloudModel: string; readonly sdkVersion: string };
  readonly timing: { readonly totalMs: number; readonly firstOutputMs: number | null };
  readonly usage: ProposalUsage;
  readonly validation: ProposalValidation;
  /** Logical payload digest: SHA-256 of the UTF-8 system instruction, a blank line, then the prompt. Not a hash of SDK wire bytes. */
  readonly payloadSha256: string | null;
  /** For T3.2 semantic checks against the fixture context. */
  readonly allowedRequirementIds: readonly string[];
  readonly blockedReason: string | null;
  readonly errorName: string | null;
  /** The SDK's stable error code (for example `AI/api-not-enabled`) when it gave one. Never the message: that can quote the request. */
  readonly errorCode: string | null;
  /** Where this call was meant to run and where it did. Absent or null: the request carried no task route, or its route could not be read. */
  readonly route?: ProposalRoute | null;
  /** Set once a prompt was built. Local only: never part of the route report. */
  readonly input?: ProposalInput | null;
  /** H11: a grounded call's web sources and Search Suggestions, to show with the answer. Local only: never part of the route report. */
  readonly grounding?: SdkGrounding | null;
}

/**
 * Telemetry carries only these scalar fields. There is deliberately no field that could hold
 * prompt text, output, or free-form messages.
 */
export interface TelemetryEvent {
  readonly kind: 'assistant_request';
  readonly requestId: string;
  readonly operation: Operation;
  readonly requestedMode: InferenceMode | null;
  readonly observedSource: ObservedSource;
  readonly status: ProposalStatus;
  readonly totalMs: number;
  readonly payloadSha256: string | null;
  readonly blockedReason: string | null;
  readonly validationStatus: ProposalValidation['status'];
  /** H9 fix round 1 (I1): the call named a task: its route record lists it. False: an Assistant or onboarding call, listed in this tab only. */
  readonly routed: boolean;
  /** H9 fix round 1 (I1): it read restricted or secret data (or an unknown label): show its labels only. */
  readonly restricted: boolean;
}

export interface AdapterOptions {
  readonly sdk: AssistantSdk;
  /** Required: every call with a task route reads it fresh through this, and is blocked if it fails. */
  readonly fetchRoute: FetchRoute;
  /** Monotonic millisecond clock (performance.now). */
  readonly now?: () => number;
  readonly newRequestId?: () => string;
  readonly onTelemetry?: (e: TelemetryEvent) => void;
  /** The device model's input budget in characters. Default `DEFAULT_NANO_INPUT_BUDGET_CHARS`. Anything but a positive number leaves no room: missing is never unlimited. */
  readonly nanoInputBudgetChars?: number;
  /**
   * H12: whether this browser can reach the cloud now (navigator.onLine, and no recent network failure). A call that needs the cloud while offline is not sent: it is
   * blocked as `offline`, so the caller can keep it as a checkpoint that waits for the connection. Absent: always online.
   */
  readonly isOnline?: () => boolean;
  /** H12: told when a cloud request failed on the network, so the browser counts as offline until it reconnects. */
  readonly onNetworkFailure?: () => void;
  /** H12 fix round 1 (I2): told when an answer came back from the cloud, so a network failure is cleared. */
  readonly onNetworkSuccess?: () => void;
  /**
   * H9: a cap on cloud calls (the hosted demo's per-tab cap, which protects the free-tier quota). H9 fix round 1 (I2): exact. Each call that may go to the cloud
   * reserves one unit synchronously inside the generation queue, right before it is sent, so two calls at once can never both take the last one; the unit is
   * given back only when the answer is observed on this device. A cloud call that fails still costs it. Once nothing is left (`allowed` false, or `reserve`
   * refused), a call that needs the cloud is blocked as `cloud_quota`, so the caller keeps it as a checkpoint, and Local first runs on this device only, never
   * falling back. Absent: no cap.
   */
  readonly cloudCalls?: { allowed(): boolean; reserve(): boolean; refund(): void };
}

/**
 * H12: an SDK error that means the request never reached the cloud: only the SDK's own fetch or network error codes (fix round 1, I2). A plain TypeError is a bug,
 * not the network, and surfaces as an error. A code only; the message is never read.
 */
export function isNetworkFailure(e: unknown): boolean {
  return /(^|\/)(fetch-error|network-error|network-request-failed)$/i.test(errorCodeOf(e) ?? '');
}

export interface AdapterState {
  readonly projectId: string | null;
  readonly modelInstances: number;
  readonly lastProposal: AssistantProposal | null;
}

const UNAVAILABLE_USAGE: ProposalUsage = { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null };

/** The SDK's error code when it is a plain code string. Anything else is dropped, so a message can never reach the UI through this field. */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[\w./-]{1,80}$/.test(code) ? code : null;
}

export class FirebaseHybridAssistantAdapter {
  private readonly sdk: AssistantSdk;
  private readonly fetchRoute: FetchRoute;
  private readonly now: () => number;
  private readonly newRequestId: () => string;
  private readonly onTelemetry: ((e: TelemetryEvent) => void) | undefined;
  private readonly budgetChars: number;
  private readonly isOnline: () => boolean;
  private readonly onNetworkFailure: (() => void) | undefined;
  private readonly onNetworkSuccess: (() => void) | undefined;
  private readonly cloudCalls: AdapterOptions['cloudCalls'];
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly readiness = new ReadinessTracker();
  private models = new Map<string, SdkModel>();
  private projectId: string | null = null;
  private last: AssistantProposal | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AdapterOptions) {
    this.sdk = opts.sdk;
    this.fetchRoute = opts.fetchRoute;
    this.now = opts.now ?? (() => performance.now());
    this.newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());
    this.onTelemetry = opts.onTelemetry;
    const b = opts.nanoInputBudgetChars ?? DEFAULT_NANO_INPUT_BUDGET_CHARS;
    this.budgetChars = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
    this.isOnline = opts.isOnline ?? (() => true);
    this.onNetworkFailure = opts.onNetworkFailure;
    this.onNetworkSuccess = opts.onNetworkSuccess;
    this.cloudCalls = opts.cloudCalls;
  }

  draftBrief(req: AssistRequest): Promise<AssistantProposal> {
    return this.run(onboardingSpec('draftBrief', req), req);
  }
  suggestCriteria(req: AssistRequest): Promise<AssistantProposal> {
    return this.run(onboardingSpec('suggestCriteria', req), req);
  }
  draftTaskPlan(req: AssistRequest): Promise<AssistantProposal> {
    return this.run(onboardingSpec('draftTaskPlan', req), req);
  }

  /** Runs one catalog agent (see agents.ts). The task's route is read before the call and again inside the queue, right before generate. */
  runAgent(spec: CallSpec, req: AgentCallRequest): Promise<AssistantProposal> {
    return this.run(spec, req, true);
  }

  async getReadiness(): Promise<Readiness> {
    return this.readiness.snapshot(this.readiness.observe(await this.sdk.availability()));
  }

  /** Call from a user gesture. First download can take several minutes. */
  async downloadModel(onProgress: (fraction: number) => void): Promise<void> {
    this.readiness.setDownloading(true);
    try {
      await this.sdk.initializeDeviceModel(onProgress);
    } finally {
      this.readiness.setDownloading(false);
      await this.getReadiness();
    }
  }

  /** Clears model instances and task-local state. */
  setProject(projectId: string): void {
    this.projectId = projectId;
    this.models = new Map();
    this.last = null;
  }

  getState(): AdapterState {
    return { projectId: this.projectId, modelInstances: this.models.size, lastProposal: this.last };
  }

  private async run(spec: CallSpec, req: CallRequest, needsRoute = false): Promise<AssistantProposal> {
    const op = spec.op;
    if (req.projectId !== this.projectId) this.setProject(req.projectId);
    const requestId = this.newRequestId();
    const start = this.now();
    const proposal = needsRoute && !req.route
      ? this.base(op, req, requestId, start)({ status: 'blocked', blockedReason: 'route_required' })
      : await this.execute(spec, req, requestId, start);
    this.last = proposal;
    this.onTelemetry?.({
      kind: 'assistant_request',
      requestId,
      operation: op,
      requestedMode: proposal.requestedMode,
      observedSource: proposal.observedSource,
      status: proposal.status,
      totalMs: proposal.timing.totalMs,
      payloadSha256: proposal.payloadSha256,
      blockedReason: proposal.blockedReason,
      validationStatus: proposal.validation.status,
      routed: req.route !== undefined && req.route !== null,
      restricted: proposal.route?.locked === true || [...req.sources.map((x) => x.classification), ...(req.labels ?? [])].some((l) => l !== 'public' && l !== 'internal'),
    });
    return proposal;
  }

  private base(op: Operation, req: CallRequest, requestId: string, start: number) {
    return (over: Partial<Mutable<AssistantProposal>>): AssistantProposal => ({
      trust: 'untrusted_proposal',
      status: 'error',
      operation: op,
      data: null,
      requestId,
      requestedMode: null,
      observedSource: 'UNKNOWN',
      rawInferenceSource: null,
      model: MODEL_METADATA,
      timing: { totalMs: Math.max(0, this.now() - start), firstOutputMs: null },
      usage: UNAVAILABLE_USAGE,
      validation: { status: 'not_run', errors: [] },
      payloadSha256: null,
      allowedRequirementIds: [...req.allowedRequirementIds],
      blockedReason: null,
      errorName: null,
      errorCode: null,
      route: null,
      input: null,
      ...over,
    });
  }

  /** Reads the task's route fresh. Null when the request names no task; a code when the read failed or cannot be acted on. */
  private async readRoute(req: CallRequest): Promise<{ fresh: FreshRoute | null } | { failed: 'route_fetch_failed' | 'route_unreadable' }> {
    if (!req.route) return { fresh: null };
    let fresh: unknown;
    try {
      fresh = await this.fetchRoute(req.projectId, req.route.taskId);
    } catch {
      return { failed: 'route_fetch_failed' };
    }
    return readableRoute(fresh) ? { fresh } : { failed: 'route_unreadable' };
  }

  private async execute(spec: CallSpec, req: CallRequest, requestId: string, start: number): Promise<AssistantProposal> {
    const op = spec.op;
    const plain = this.base(op, req, requestId, start);
    // The task's route, read fresh from the server immediately before this call. A failed or unreadable read blocks: no cached or snapshot route is ever used.
    const read = await this.readRoute(req);
    if ('failed' in read) return plain({ status: 'blocked', blockedReason: read.failed });
    // The lock follows the strongest label of what this call reads, or the server's word. It and the effective policy are replaced if the in-queue read changes them.
    let current = routeOf(req, read.fresh);
    const make = (over: Partial<Mutable<AssistantProposal>>): AssistantProposal => {
      const p = plain(over);
      if (!req.route || !current) return p;
      const { lock, effective } = current;
      const ran = p.status === 'ok' || p.status === 'invalid' || p.status === 'route_violation' || p.status === 'unverified_source';
      const outcome = ran ? routeOutcome(effective.mode, p.observedSource, p.requestedMode, lock !== null) : { fellBack: null, conformance: 'unverified' as const, requestModeMismatch: false };
      return {
        ...p,
        route: {
          taskId: req.route.taskId, stepKind: req.route.stepKind, callOverride: req.route.callOverride ?? null, effectiveMode: effective.mode, policySource: effective.source,
          locked: lock !== null,
          fellBack: outcome.fellBack, conformance: outcome.conformance, requestModeMismatch: outcome.requestModeMismatch,
        },
      };
    };

    // Secret material never goes into a prompt, on any route; a value that is not a label counts as secret.
    if (req.labels && req.labels.length > 0 && req.labels.reduce<string>((acc, l) => strongerLabel(acc, l), 'public') === 'secret') {
      return make({ status: 'blocked', blockedReason: 'secret_excluded_from_model_context' });
    }
    // Policy first, before any SDK call.
    const routed = resolveInferenceMode(req.sources, req.policy, current ? current.effective.mode : undefined);
    if (routed.blocked) return make({ status: 'blocked', blockedReason: routed.reason });
    if (spec.citesCriteria && req.allowedRequirementIds.length === 0) {
      return make({ status: 'blocked', requestedMode: routed.mode, blockedReason: 'no_allowed_requirement_ids' });
    }

    // Every label of what the prompt reads (the task, files, bundle claims, diff paths) must be covered by the policy's cloud grant, as the sources are. If any is not,
    // the cloud is not allowed: a cloud-only route is refused, and a device-capable one runs on the device with no fallback. Unknown never counts as granted.
    let mode: InferenceMode = routed.mode;
    let allowFallback = routed.allowFallback;
    if (mode !== 'ONLY_ON_DEVICE' && !(req.labels ?? []).every((l) => isDestinationGranted('inference', FIREBASE_CLOUD_ROUTE, l, req.policy))) {
      if (mode === 'ONLY_IN_CLOUD') return make({ status: 'blocked', requestedMode: mode, blockedReason: 'cloud_not_granted_for_label' });
      if (mode === 'PREFER_IN_CLOUD') mode = 'ONLY_ON_DEVICE';
      allowFallback = false;
    }

    // H9 fix round 1 (I2): past the cloud call cap, Local first keeps to this device: no fallback is approved for it any more.
    if (mode === 'PREFER_ON_DEVICE' && this.cloudCalls && !this.cloudCalls.allowed()) allowFallback = false;
    // Never let the SDK choose the cloud when policy has no approved fallback.
    const deviceMustServe = mode === 'ONLY_ON_DEVICE' || (mode === 'PREFER_ON_DEVICE' && !allowFallback);
    // H11: web search runs only on a cloud-only route, and never for a locked (restricted) task. Refused before any prompt is built or model called.
    if (spec.grounding) {
      if (current?.lock) return make({ status: 'blocked', requestedMode: mode, blockedReason: 'research_locked' });
      // The owner set this task to device only: research never overrides that, whatever the call asks for.
      // Fix round 2: the route the task would use without this call's override (its own override, else the run default or the seed) is device only.
      if (read.fresh?.override === 'ONLY_ON_DEVICE' || effectiveRoutePolicy({ call: null, task: read.fresh?.override ?? null, run: read.fresh?.runDefault ?? null, lock: null }).mode === 'ONLY_ON_DEVICE') {
        return make({ status: 'blocked', requestedMode: mode, blockedReason: 'research_device_only' });
      }
      if (mode !== 'ONLY_IN_CLOUD' || deviceMustServe) return make({ status: 'blocked', requestedMode: mode, blockedReason: 'research_cloud_only' });
    }
    const built = spec.prompt({ mode, cloudCapable: !deviceMustServe, locked: current?.lock != null });
    if ('refused' in built) return make({ status: 'blocked', requestedMode: mode, blockedReason: built.refused });
    const systemInstruction = spec.systemInstruction;
    const prompt = built.prompt;
    if (redactSecrets(prompt) !== prompt || redactSecrets(systemInstruction) !== systemInstruction) {
      return make({ status: 'blocked', requestedMode: mode, blockedReason: 'secret_in_input' });
    }

    // The device model's input budget. Over it, a call that must run on the device is refused, never cut. Local first with an approved fallback goes to the cloud,
    // as the SDK would when the device cannot serve, and records it: the request says ONLY_IN_CLOUD and the route record shows the fallback.
    const chars = systemInstruction.length + prompt.length;
    const input: ProposalInput = { chars, budgetChars: this.budgetChars, overDeviceBudget: chars > this.budgetChars };
    if (input.overDeviceBudget && deviceMustServe) return make({ status: 'blocked', requestedMode: mode, input, blockedReason: 'input_too_large_for_device' });
    const requestedMode: InferenceMode = input.overDeviceBudget && mode === 'PREFER_ON_DEVICE' ? 'ONLY_IN_CLOUD' : mode;

    if (deviceMustServe) {
      const device = this.readiness.observe(await this.sdk.availability());
      if (device !== 'available') {
        return make({ status: 'blocked', requestedMode, input, blockedReason: `device_${device}` });
      }
    } else if (!this.isOnline()) {
      // H12: offline, a call that needs the cloud is not sent, and never silently answered elsewhere: it waits for the connection. Cloud only, and Local first when
      // the input is over the device budget or the device model is not ready, need the cloud. Cloud first may still be answered on the device, as the SDK does.
      const needsCloud = requestedMode === 'ONLY_IN_CLOUD'
        || (requestedMode === 'PREFER_ON_DEVICE' && this.readiness.observe(await this.sdk.availability()) !== 'available');
      if (needsCloud) return make({ status: 'blocked', requestedMode, input, blockedReason: 'offline' });
    }
    // H9: past the cloud call cap, a call that would go to the cloud is not sent and waits as a checkpoint. Cloud first counts as needing the cloud: it is never
    // quietly answered on the device instead. Local first still runs on a ready device model.
    if (!deviceMustServe && this.cloudCalls && !this.cloudCalls.allowed()) return make({ status: 'blocked', requestedMode, input, blockedReason: 'cloud_quota' });

    const hash = await payloadSha256(systemInstruction, prompt);
    const sdkMode: InferenceMode = deviceMustServe ? 'ONLY_ON_DEVICE' : requestedMode;
    const key = `${sdkMode}|${deviceMustServe ? 'nocloud' : 'cloud'}|${spec.schemaKey}${spec.grounding ? '|grounded' : ''}`;
    let model = this.models.get(key);
    if (!model) {
      model = this.sdk.createModel({ mode: sdkMode, allowCloud: !deviceMustServe, systemInstruction, schema: spec.schema, ...(spec.grounding ? { grounding: spec.grounding } : {}) });
      this.models.set(key, model);
    }
    const m = model;
    const before = current;

    let result;
    let reserved = false;
    try {
      // Single-turn, one generation at a time. The route is read again inside the queue, right before generate: a lock raised, or any other change made, while this
      // call waited blocks it rather than let it run on the route it was built for.
      const job = this.queue.then(async (): Promise<{ recheck: string } | { result: Awaited<ReturnType<SdkModel['generate']>> }> => {
        if (req.route) {
          const again = await this.readRoute(req);
          if ('failed' in again) return { recheck: again.failed };
          const now = routeOf(req, again.fresh);
          if (!now || !before || now.effective.mode !== before.effective.mode || (now.lock === null) !== (before.lock === null)) {
            current = now;
            return { recheck: 'route_changed_in_queue' };
          }
        }
        // H9 fix round 1 (I2): one unit reserved here, synchronously in the queue, before a call that may go to the cloud is sent.
        if (!deviceMustServe && this.cloudCalls) {
          if (!this.cloudCalls.reserve()) return { recheck: 'cloud_quota' };
          reserved = true;
        }
        return { result: await m.generate(prompt) };
      });
      this.queue = job.catch(() => undefined);
      const done = await job;
      if ('recheck' in done) return make({ status: 'blocked', requestedMode, input, payloadSha256: hash, blockedReason: done.recheck });
      result = done.result;
    } catch (e) {
      // H12: a cloud request that failed on the network never reached the cloud. It is offline, not an error: the step can wait for the connection.
      if (!deviceMustServe && isNetworkFailure(e)) {
        this.onNetworkFailure?.();
        return make({ status: 'blocked', requestedMode, input, payloadSha256: hash, blockedReason: 'offline', errorName: e instanceof Error ? e.name : 'Error', errorCode: errorCodeOf(e) });
      }
      return make({ status: 'error', requestedMode, input, payloadSha256: hash, errorName: e instanceof Error ? e.name : 'Error', errorCode: errorCodeOf(e) });
    }

    const observedSource = mapInferenceSource(result.inferenceSource);
    if (observedSource === 'IN_CLOUD') this.onNetworkSuccess?.();
    // Answered on this device: the reserved unit is given back. In the cloud, or not shown, it is spent.
    if (reserved && observedSource === 'ON_DEVICE') this.cloudCalls?.refund();
    const rawInferenceSource = result.inferenceSource ?? null;
    const u = result.usage;
    const usage: ProposalUsage =
      u && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.totalTokens !== undefined)
        ? { status: 'observed', inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null, totalTokens: u.totalTokens ?? null }
        : UNAVAILABLE_USAGE;
    const common = { requestedMode, observedSource, rawInferenceSource, usage, payloadSha256: hash, input, ...(spec.grounding ? { grounding: result.grounding ?? null } : {}) };

    // A response is on-device only if it says so. Withhold data otherwise.
    if (deviceMustServe && observedSource !== 'ON_DEVICE') {
      return observedSource === 'IN_CLOUD'
        ? make({ ...common, status: 'route_violation', blockedReason: 'cloud_source_without_approval' })
        : make({ ...common, status: 'unverified_source', blockedReason: 'source_not_shown_on_device' });
    }

    let parsed: unknown;
    try {
      // A grounded answer is not schema-constrained by the SDK, so it may come in a fenced block; it is still checked against the schema below.
      parsed = JSON.parse(spec.grounding ? result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '') : result.text);
    } catch {
      return make({ ...common, status: 'invalid', validation: { status: 'failed', errors: ['output is not valid JSON'] } });
    }
    const validate = this.ajv.compile(spec.schema);
    if (!validate(parsed)) {
      const errors = (validate.errors ?? []).map((er) => `${er.instancePath || '/'} ${er.message ?? 'invalid'}`);
      return make({ ...common, status: 'invalid', validation: { status: 'failed', errors } });
    }
    const semantic = spec.check?.(parsed) ?? [];
    if (semantic.length > 0) return make({ ...common, status: 'invalid', validation: { status: 'failed', errors: [...semantic] } });
    return make({ ...common, status: 'ok', data: parsed, validation: { status: 'passed', errors: [] } });
  }
}

type CallRequest = Omit<AssistRequest, 'taskText'> & { readonly labels?: readonly unknown[]; readonly deviceLabels?: readonly unknown[] };

/** The lock and the effective policy for a request, from a fresh read. Null when the request names no task. */
function routeOf(req: CallRequest, fresh: FreshRoute | null): { lock: RouteLock | null; effective: EffectiveRoutePolicy } | null {
  if (!req.route || !fresh) return null;
  const lockFrom = (labels: readonly unknown[]) => routeLockFor([...req.sources.map((s) => s.classification), ...labels, ...(fresh.lock ? ['restricted'] : [])]);
  const policyWith = (lock: RouteLock | null) => effectiveRoutePolicy({ call: req.route!.callOverride ?? null, task: fresh.override, run: fresh.runDefault, lock });
  // H5 fix round 3: when the route keeps the call on the device anyway (device only, with the content as it is), what the call reads is judged by its content, so an
  // internal task's device bundle does not lock it. Any cloud-capable route judges a device bundle by where it was built: restricted, so the call locks to the device.
  // "Keeps it on the device anyway" is judged from the route alone (the server's lock and the call's sources, not what this call reads), so a content lock can never be
  // what makes a route device-only and so select the content labels.
  if (req.deviceLabels && policyWith(lockFrom([])).mode === 'ONLY_ON_DEVICE') {
    const lock = lockFrom(req.deviceLabels);
    return { lock, effective: policyWith(lock) };
  }
  const lock = lockFrom(req.labels ?? []);
  return { lock, effective: policyWith(lock) };
}

/** An onboarding operation as a call: its fixed instruction and schema, and the request's own text then the allowed IDs. */
function onboardingSpec(op: OnboardingOperation, req: AssistRequest): CallSpec {
  const ids = req.allowedRequirementIds;
  return {
    op, systemInstruction: systemInstructionFor(op), schema: narrowSchema(op, ids), schemaKey: `${op}|${[...ids].join(',')}`, citesCriteria: true,
    prompt: () => ({ prompt: composePrompt(req.taskText, ids) }),
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const modeOrNull = (v: unknown): boolean => v === null || RoutePolicyModeSchema.safeParse(v).success;
/** A route read the adapter can act on: modes it knows (or null), and a lock that is null or names a reason. Anything else blocks. */
function readableRoute(r: unknown): r is FreshRoute {
  const x = r as Partial<FreshRoute> | null;
  if (!x || typeof x !== 'object' || !modeOrNull(x.runDefault) || !modeOrNull(x.override)) return false;
  return x.lock === null || (typeof x.lock === 'object' && x.lock !== undefined && typeof x.lock.reason === 'string');
}

/** What the browser sends the server about one call with a task route: identifiers, modes, the observed source, timing and validation. Never prompt or output. */
export function routeReportOf(p: AssistantProposal): RouteRecordReport | null {
  if (!p.route) return null;
  const code = p.blockedReason !== null && /^[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)*$/.test(p.blockedReason) && p.blockedReason.length <= 120 ? p.blockedReason : null;
  return {
    kind: 'route', requestId: p.requestId, stepKind: p.route.stepKind, callOverride: p.route.callOverride, requestedMode: p.requestedMode, observedSource: p.observedSource, status: p.status,
    model: { cloudModel: p.model.cloudModel, sdkVersion: p.model.sdkVersion },
    timing: { totalMs: p.timing.totalMs, firstOutputMs: p.timing.firstOutputMs }, validation: p.validation.status, blockedReason: code,
  };
}
