import { TaskSpecSchema, type TaskSpec } from '@selarikru/domain';
import { LeaseGrantSchema, RecordedAssignmentSchema, type LeaseRef, type ResultRequest, type RunnerHarnessReport, type TerminalUploadRequest } from '@selarikru/protocol';
import { z } from 'zod';
import type { RunnerSettings } from './settings.ts';

export const ClaimedLeaseSchema = z
  .object({
    /** On a repair: why the last attempt did not stand, redacted and bounded by the server. */
    priorFailure: z.string().max(1000).optional(),
    attemptId: z.string().min(1),
    fence: z.number().int().min(0),
    leaseToken: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    deadlineAt: z.string(),
    /** Human grants delivered with this lease. A row this runner cannot read as a grant is dropped, so it can never be mistaken for one it holds. */
    grants: z.array(z.unknown()).default([]).transform((rows) => rows.flatMap((r) => { const g = LeaseGrantSchema.safeParse(r); return g.success ? [g.data] : []; })),
    /** The model this attempt was recorded with. The runner launches exactly this, or nothing. Null on a lease with no recorded model, which cannot run. */
    assignment: RecordedAssignmentSchema.nullable().default(null),
    /** Whether this attempt's output may leave the machine, decided at claim from every source's label. Absent: it may not. */
    streamable: z.boolean().default(false),
    /** Whether this attempt can host a control session at all. The control API still re-checks policy and the rest for every ticket. Absent: it cannot. */
    controllable: z.boolean().default(false),
  })
  .passthrough();
export type ClaimedLease = z.infer<typeof ClaimedLeaseSchema>;

const ClaimResponseSchema = z.object({ lease: ClaimedLeaseSchema.nullable(), reason: z.string().nullable().optional(), config: z.unknown().optional() }).passthrough();
const HeartbeatResponseSchema = z.object({ cancelRequested: z.boolean(), config: z.unknown().optional() }).passthrough();
const SetupCompleteResponseSchema = z.object({ deadlineAt: z.string() }).passthrough();
const TaskResponseSchema = z.object({ task: TaskSpecSchema });

export type RunnerResult = ResultRequest['result'];

export class LeaseLostError extends Error {
  constructor(detail = 'the lease is no longer current') {
    super(detail);
    this.name = 'LeaseLostError';
  }
}

/** The control API answered with an error. `permanent`: a refusal that a retry cannot change. */
export class ApiStatusError extends Error {
  constructor(readonly status: number, path: string) {
    super(`control API ${path} responded ${status}`);
    this.name = 'ApiStatusError';
  }
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

/** Everything the runner asks of the control plane. Every call is an outbound request. */
export interface RunnerApi {
  /** `harnesses`: what this runner can launch now. `projects`: the project ids it has a checkout for. */
  claim(harnesses?: readonly RunnerHarnessReport[], projects?: readonly string[]): Promise<{ lease: ClaimedLease | null; reason: string | null }>;
  task(lease: LeaseRef): Promise<TaskSpec>;
  heartbeat(lease: LeaseRef, activity?: string): Promise<{ cancelRequested: boolean }>;
  /** The sandbox is ready and the worker is about to start. Returns the attempt's deadline, restarted from now. */
  setupComplete(lease: LeaseRef): Promise<{ deadlineAt: string }>;
  result(lease: LeaseRef, result: RunnerResult): Promise<void>;
  /** One batch of the attempt's live output. Rejects with `LeaseLostError` when this attempt is no longer the runner's. Never awaited in the attempt's own path. */
  terminal(lease: LeaseRef, batch: Omit<TerminalUploadRequest, 'lease'>): Promise<void>;
}

export const leaseRef = (l: ClaimedLease): LeaseRef => ({ attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken });

/** Only https, or http to loopback for local development: the bearer token must not cross a network in clear. */
export function assertSafeApiUrl(raw: string): URL {
  const u = new URL(raw);
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('the API URL must be https (http is allowed only for localhost)');
  return u;
}

export class HttpRunnerApi implements RunnerApi {
  private readonly base: URL;
  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Present: every claim and heartbeat acknowledges the config revision applied, and applies the one the server answers with. */
    private readonly settings?: RunnerSettings,
  ) {
    this.base = assertSafeApiUrl(baseUrl);
  }

  private async post(path: string, body: unknown, timeoutMs = 30_000): Promise<unknown> {
    const res = await this.fetchImpl(new URL(path, this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 409) throw new LeaseLostError();
    if (!res.ok) throw new ApiStatusError(res.status, path);
    return res.json();
  }

  async claim(harnesses?: readonly RunnerHarnessReport[], projects?: readonly string[]) {
    const r = ClaimResponseSchema.parse(await this.post('/v1/runners/claim', { ...(harnesses === undefined ? {} : { harnesses }), ...(projects === undefined ? {} : { projects }), ...this.ack() }));
    this.settings?.apply(r.config);
    return { lease: r.lease, reason: r.reason ?? null };
  }
  private ack(): { config?: ReturnType<RunnerSettings['ack']> } {
    return this.settings ? { config: this.settings.ack() } : {};
  }
  async task(lease: LeaseRef) {
    return TaskResponseSchema.parse(await this.post('/v1/runners/task', { lease })).task;
  }
  async heartbeat(lease: LeaseRef, activity?: string) {
    const r = HeartbeatResponseSchema.parse(await this.post('/v1/runners/heartbeat', { lease, ...(activity === undefined ? {} : { activity }), ...this.ack() }));
    this.settings?.apply(r.config);
    return { cancelRequested: r.cancelRequested };
  }
  async setupComplete(lease: LeaseRef) {
    const r = SetupCompleteResponseSchema.parse(await this.post('/v1/runners/heartbeat', { lease, setupComplete: true }));
    return { deadlineAt: r.deadlineAt };
  }
  async result(lease: LeaseRef, result: RunnerResult) {
    await this.post('/v1/runners/result', { lease, result });
  }
  async terminal(lease: LeaseRef, batch: Omit<TerminalUploadRequest, 'lease'>) {
    await this.post('/v1/runners/terminal', { lease, ...batch }, 5_000);
  }
}
