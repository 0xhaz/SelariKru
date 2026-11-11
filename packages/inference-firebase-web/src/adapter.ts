import { Ajv } from 'ajv';
import { RoutePolicyModeSchema, effectiveRoutePolicy, routeLockFor, routeOutcome, type RouteConformance, type RoutePolicySource, type RouteRecordReport, type RouteStepKind } from '@selarikru/domain';
import { resolveInferenceMode, type InferenceMode, type Policy, type Source } from '@selarikru/policy';
import {
  MODEL_METADATA,
  composePrompt,
  mapInferenceSource,
  narrowSchema,
  payloadSha256,
  systemInstructionFor,
  type ObservedSource,
  type Operation,
} from './models.ts';
import { ReadinessTracker, type Readiness } from './readiness.ts';
import type { AssistantSdk, SdkModel } from './sdk.ts';

export type { ObservedSource, Operation };

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
}

export interface AdapterOptions {
  readonly sdk: AssistantSdk;
  /** Required: every call with a task route reads it fresh through this, and is blocked if it fails. */
  readonly fetchRoute: FetchRoute;
  /** Monotonic millisecond clock (performance.now). */
  readonly now?: () => number;
  readonly newRequestId?: () => string;
  readonly onTelemetry?: (e: TelemetryEvent) => void;
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
  }

  draftBrief(req: AssistRequest): Promise<AssistantProposal> {
    return this.run('draftBrief', req);
  }
  suggestCriteria(req: AssistRequest): Promise<AssistantProposal> {
    return this.run('suggestCriteria', req);
  }
  draftTaskPlan(req: AssistRequest): Promise<AssistantProposal> {
    return this.run('draftTaskPlan', req);
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

  private async run(op: Operation, req: AssistRequest): Promise<AssistantProposal> {
    if (req.projectId !== this.projectId) this.setProject(req.projectId);
    const requestId = this.newRequestId();
    const start = this.now();
    const proposal = await this.execute(op, req, requestId, start);
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
    });
    return proposal;
  }

  private base(op: Operation, req: AssistRequest, requestId: string, start: number) {
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
      ...over,
    });
  }

  private async execute(op: Operation, req: AssistRequest, requestId: string, start: number): Promise<AssistantProposal> {
    const plain = this.base(op, req, requestId, start);
    // The task's route, read fresh from the server immediately before this call. A failed or unreadable read blocks: no cached or snapshot route is ever used.
    let fresh: FreshRoute | null = null;
    if (req.route) {
      try {
        fresh = await this.fetchRoute(req.projectId, req.route.taskId);
      } catch {
        return plain({ status: 'blocked', blockedReason: 'route_fetch_failed' });
      }
      if (!readableRoute(fresh)) return plain({ status: 'blocked', blockedReason: 'route_unreadable' });
    }
    // The lock follows the strongest label of what this call reads, or the server's word.
    const lock = req.route && fresh ? routeLockFor([...req.sources.map((s) => s.classification), ...(fresh.lock ? ['restricted'] : [])]) : null;
    const effective = req.route && fresh ? effectiveRoutePolicy({ call: req.route.callOverride ?? null, task: fresh.override, run: fresh.runDefault, lock }) : null;
    const make = (over: Partial<Mutable<AssistantProposal>>): AssistantProposal => {
      const p = plain(over);
      if (!req.route || !effective) return p;
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

    // Policy first, before any SDK call.
    const routed = resolveInferenceMode(req.sources, req.policy, effective ? effective.mode : undefined);
    if (routed.blocked) return make({ status: 'blocked', blockedReason: routed.reason });
    if (req.allowedRequirementIds.length === 0) {
      return make({ status: 'blocked', requestedMode: routed.mode, blockedReason: 'no_allowed_requirement_ids' });
    }

    // Never let the SDK choose the cloud when policy has no approved fallback.
    const deviceMustServe = routed.mode === 'ONLY_ON_DEVICE' || (routed.mode === 'PREFER_ON_DEVICE' && !routed.allowFallback);
    if (deviceMustServe) {
      const device = this.readiness.observe(await this.sdk.availability());
      if (device !== 'available') {
        return make({ status: 'blocked', requestedMode: routed.mode, blockedReason: `device_${device}` });
      }
    }

    const systemInstruction = systemInstructionFor(op);
    const schema = narrowSchema(op, req.allowedRequirementIds);
    const prompt = composePrompt(req.taskText, req.allowedRequirementIds);
    const hash = await payloadSha256(systemInstruction, prompt);
    const effectiveMode: InferenceMode = deviceMustServe ? 'ONLY_ON_DEVICE' : routed.mode;
    const key = `${effectiveMode}|${deviceMustServe ? 'nocloud' : 'cloud'}|${op}|${[...req.allowedRequirementIds].join(',')}`;
    let model = this.models.get(key);
    if (!model) {
      model = this.sdk.createModel({ mode: effectiveMode, allowCloud: !deviceMustServe, systemInstruction, schema });
      this.models.set(key, model);
    }
    const m = model;

    let result;
    try {
      // Single-turn, one generation at a time.
      const job = this.queue.then(() => m.generate(prompt));
      this.queue = job.catch(() => undefined);
      result = await job;
    } catch (e) {
      return make({ status: 'error', requestedMode: routed.mode, payloadSha256: hash, errorName: e instanceof Error ? e.name : 'Error', errorCode: errorCodeOf(e) });
    }

    const observedSource = mapInferenceSource(result.inferenceSource);
    const rawInferenceSource = result.inferenceSource ?? null;
    const u = result.usage;
    const usage: ProposalUsage =
      u && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.totalTokens !== undefined)
        ? { status: 'observed', inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null, totalTokens: u.totalTokens ?? null }
        : UNAVAILABLE_USAGE;
    const common = { requestedMode: routed.mode, observedSource, rawInferenceSource, usage, payloadSha256: hash };

    // A response is on-device only if it says so. Withhold data otherwise.
    if (deviceMustServe && observedSource !== 'ON_DEVICE') {
      return observedSource === 'IN_CLOUD'
        ? make({ ...common, status: 'route_violation', blockedReason: 'cloud_source_without_approval' })
        : make({ ...common, status: 'unverified_source', blockedReason: 'source_not_shown_on_device' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return make({ ...common, status: 'invalid', validation: { status: 'failed', errors: ['output is not valid JSON'] } });
    }
    const validate = this.ajv.compile(schema);
    if (!validate(parsed)) {
      const errors = (validate.errors ?? []).map((er) => `${er.instancePath || '/'} ${er.message ?? 'invalid'}`);
      return make({ ...common, status: 'invalid', validation: { status: 'failed', errors } });
    }
    return make({ ...common, status: 'ok', data: parsed, validation: { status: 'passed', errors: [] } });
  }
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
