import { Ajv } from 'ajv';
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
}

export type ProposalStatus = 'ok' | 'invalid' | 'blocked' | 'route_violation' | 'error';

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
  readonly payloadSha256: string | null;
  /** For T3.2 semantic checks against the fixture context. */
  readonly allowedRequirementIds: readonly string[];
  readonly blockedReason: string | null;
  readonly errorName: string | null;
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

export class FirebaseHybridAssistantAdapter {
  private readonly sdk: AssistantSdk;
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
      ...over,
    });
  }

  private async execute(op: Operation, req: AssistRequest, requestId: string, start: number): Promise<AssistantProposal> {
    const make = this.base(op, req, requestId, start);

    // Policy first, before any SDK call.
    const routed = resolveInferenceMode(req.sources, req.policy);
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
    const key = `${routed.mode}|${op}|${[...req.allowedRequirementIds].join(',')}`;
    let model = this.models.get(key);
    if (!model) {
      model = this.sdk.createModel({ mode: routed.mode, systemInstruction, schema });
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
      return make({ status: 'error', requestedMode: routed.mode, payloadSha256: hash, errorName: e instanceof Error ? e.name : 'Error' });
    }

    const observedSource = mapInferenceSource(result.inferenceSource);
    const rawInferenceSource = result.inferenceSource ?? null;
    const u = result.usage;
    const usage: ProposalUsage =
      u && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.totalTokens !== undefined)
        ? { status: 'observed', inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null, totalTokens: u.totalTokens ?? null }
        : UNAVAILABLE_USAGE;
    const common = { requestedMode: routed.mode, observedSource, rawInferenceSource, usage, payloadSha256: hash };

    if (observedSource === 'IN_CLOUD' && !routed.allowFallback && (routed.mode === 'ONLY_ON_DEVICE' || routed.mode === 'PREFER_ON_DEVICE')) {
      return make({ ...common, status: 'route_violation', blockedReason: 'cloud_source_without_approval' });
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
