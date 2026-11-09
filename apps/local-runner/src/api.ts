import { TaskSpecSchema, type TaskSpec } from '@selarikru/domain';
import { LeaseGrantSchema, type LeaseRef, type ResultRequest } from '@selarikru/protocol';
import { z } from 'zod';

export const ClaimedLeaseSchema = z
  .object({
    attemptId: z.string().min(1),
    fence: z.number().int().min(0),
    leaseToken: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    deadlineAt: z.string(),
    /** Human grants delivered with this lease. A row this runner cannot read as a grant is dropped, so it can never be mistaken for one it holds. */
    grants: z.array(z.unknown()).default([]).transform((rows) => rows.flatMap((r) => { const g = LeaseGrantSchema.safeParse(r); return g.success ? [g.data] : []; })),
  })
  .passthrough();
export type ClaimedLease = z.infer<typeof ClaimedLeaseSchema>;

const ClaimResponseSchema = z.object({ lease: ClaimedLeaseSchema.nullable(), reason: z.string().nullable().optional() }).passthrough();
const HeartbeatResponseSchema = z.object({ cancelRequested: z.boolean() }).passthrough();
const TaskResponseSchema = z.object({ task: TaskSpecSchema });

export type RunnerResult = ResultRequest['result'];

export class LeaseLostError extends Error {
  constructor(detail = 'the lease is no longer current') {
    super(detail);
    this.name = 'LeaseLostError';
  }
}

/** Everything the runner asks of the control plane. Every call is an outbound request. */
export interface RunnerApi {
  claim(): Promise<{ lease: ClaimedLease | null; reason: string | null }>;
  task(lease: LeaseRef): Promise<TaskSpec>;
  heartbeat(lease: LeaseRef): Promise<{ cancelRequested: boolean }>;
  result(lease: LeaseRef, result: RunnerResult): Promise<void>;
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
  ) {
    this.base = assertSafeApiUrl(baseUrl);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(new URL(path, this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 409) throw new LeaseLostError();
    if (!res.ok) throw new Error(`control API ${path} responded ${res.status}`);
    return res.json();
  }

  async claim() {
    const r = ClaimResponseSchema.parse(await this.post('/v1/runners/claim', {}));
    return { lease: r.lease, reason: r.reason ?? null };
  }
  async task(lease: LeaseRef) {
    return TaskResponseSchema.parse(await this.post('/v1/runners/task', { lease })).task;
  }
  async heartbeat(lease: LeaseRef) {
    const r = HeartbeatResponseSchema.parse(await this.post('/v1/runners/heartbeat', { lease }));
    return { cancelRequested: r.cancelRequested };
  }
  async result(lease: LeaseRef, result: RunnerResult) {
    await this.post('/v1/runners/result', { lease, result });
  }
}
