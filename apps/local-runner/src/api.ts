import { BrainBundleSchema, TaskSpecSchema, type BaseFileAnswer, type TaskSpec } from '@selarikru/domain';
import { LeaseGrantSchema, RecordedAssignmentSchema, type CheckpointUpload, type LeaseRef, type RepoManifest, type StackDetectionReport, type ResultRequest, type RunnerHarnessReport, type TerminalUploadRequest } from '@selarikru/protocol';
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
    /** The Project Brain's context for this task, filtered by the server for this runner's location. Data for the worker to read, never an instruction. Absent or unreadable: none. */
    context: BrainBundleSchema.nullable().catch(null).default(null),
    /** The knowledge packs the claim resolved, with their content. Absent: an older server, so none. Anything else is checked before start, and a delivery that cannot be read starts nothing. */
    skills: z.unknown().optional(),
    /** Set on a handover's successor: the checkpoint it starts from (ids and hashes), or a restart from the persisted input. Absent: an ordinary attempt. */
    handover: z.object({
      checkpointId: z.string().min(1), mode: z.enum(['resume', 'restart']), priorAttemptId: z.string().min(1), baseSha: z.string().min(1),
      patchSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), fileCount: z.number().int().min(0).nullable(),
    }).optional(),
    /** Set on an apply attempt (H5): the accepted proposal it applies, by id and hashes. The results are fetched with the lease and checked against these. */
    proposal: z.object({ proposalId: z.string().min(1), digest: z.string().regex(/^[0-9a-f]{64}$/), fileCount: z.number().int().min(1), baseSha: z.string().min(1) }).optional(),
  })
  .passthrough();
export type ClaimedLease = z.infer<typeof ClaimedLeaseSchema>;

const ClaimResponseSchema = z.object({ lease: ClaimedLeaseSchema.nullable(), reason: z.string().nullable().optional(), config: z.unknown().optional() }).passthrough();
const HandoverStopSchema = z.object({ checkpointId: z.string().min(1), mode: z.enum(['resume', 'restart']) }).nullable().catch(null).default(null);
const HeartbeatResponseSchema = z.object({ cancelRequested: z.boolean(), handover: HandoverStopSchema, config: z.unknown().optional() }).passthrough();
/** What the successor fetches: the checkpoint's files with their bytes and the hashes to check them against. Checked again here before anything is written. */
export const FetchedCheckpointSchema = z.object({
  checkpointId: z.string().min(1), baseSha: z.string().min(1), patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.object({ path: z.string().min(1), status: z.enum(['added', 'modified', 'deleted']), sha256: z.string().nullable(), size: z.number().int().nullable(), executable: z.boolean(), content: z.string().nullable() })).max(500),
});
export type FetchedCheckpoint = z.infer<typeof FetchedCheckpointSchema>;
/** A stop the server says is a handover to another location. */
export type HandoverStop = { readonly checkpointId: string; readonly mode: 'resume' | 'restart' };
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
  heartbeat(lease: LeaseRef, activity?: string): Promise<{ cancelRequested: boolean; handover?: HandoverStop | null }>;
  /** The sandbox is ready and the worker is about to start. Returns the attempt's deadline, restarted from now. */
  setupComplete(lease: LeaseRef): Promise<{ deadlineAt: string }>;
  result(lease: LeaseRef, result: RunnerResult): Promise<void>;
  /** One batch of the attempt's live output. Rejects with `LeaseLostError` when this attempt is no longer the runner's. Never awaited in the attempt's own path. */
  terminal(lease: LeaseRef, batch: Omit<TerminalUploadRequest, 'lease'>): Promise<void>;
  /** What this checkout holds at the task's base commit, for the Project Brain. Counts and hashes only. Absent: this runner sends none. */
  brainManifest?(lease: LeaseRef, manifest: RepoManifest): Promise<void>;
  /** What static detection found in this checkout at the task's base commit: proposals for the owner to confirm. Absent: this runner sends none. */
  stackDetection?(lease: LeaseRef, detection: StackDetectionReport): Promise<void>;
  /** After its own digest check, before the worker starts: the packs this runner materialized, by version and digest. Absent: the server never learns they were delivered. */
  skillsConfirmed?(lease: LeaseRef, packs: readonly { versionId: string; digest: string }[]): Promise<void>;
  /** A handover's prior attempt, stopped: its change set against the base, every file hashed, the paths it left out with the reason. Absent: this runner sends none. */
  checkpoint?(lease: LeaseRef, body: Omit<CheckpointUpload, 'lease'>): Promise<void>;
  /** A handover's successor: the checkpoint its lease names, before the worker starts. Absent: this runner cannot resume one. */
  fetchCheckpoint?(lease: LeaseRef): Promise<unknown>;
  /** An apply attempt: the accepted proposal its lease names. Absent: this runner cannot apply one. */
  fetchProposal?(lease: LeaseRef): Promise<unknown>;
  /** Base file reads waiting for a runner with one of these checkouts. Absent: this runner serves none. */
  fileRequests?(): Promise<unknown>;
  /** The answer to one base file read. */
  answerFiles?(answer: BaseFileAnswer): Promise<void>;
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
    // This build materializes knowledge packs read-only and confirms their digests, so the server may give it tasks that have packs.
    const r = ClaimResponseSchema.parse(await this.post('/v1/runners/claim', { ...(harnesses === undefined ? {} : { harnesses }), ...(projects === undefined ? {} : { projects }), ...this.ack(), capabilities: { skills: true } }));
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
    return { cancelRequested: r.cancelRequested, handover: r.handover };
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
  async brainManifest(lease: LeaseRef, manifest: RepoManifest) {
    await this.post('/v1/runners/brain/manifest', { lease, manifest }, 10_000);
  }
  async skillsConfirmed(lease: LeaseRef, packs: readonly { versionId: string; digest: string }[]) {
    await this.post('/v1/runners/skills/confirm', { lease, packs }, 10_000);
  }
  async stackDetection(lease: LeaseRef, detection: StackDetectionReport) {
    await this.post('/v1/runners/stack/detection', { lease, detection }, 10_000);
  }
  async checkpoint(lease: LeaseRef, body: Omit<CheckpointUpload, 'lease'>) {
    await this.post('/v1/runners/checkpoint', { lease, ...body }, 60_000);
  }
  async fetchCheckpoint(lease: LeaseRef) {
    return this.post('/v1/runners/checkpoint/fetch', { lease }, 60_000);
  }
  async fetchProposal(lease: LeaseRef) {
    return ((await this.post('/v1/runners/proposal/fetch', { lease }, 30_000)) as { proposal?: unknown }).proposal;
  }
  async fileRequests() {
    return ((await this.post('/v1/runners/files/poll', {}, 10_000)) as { requests?: unknown }).requests;
  }
  async answerFiles(answer: BaseFileAnswer) {
    await this.post('/v1/runners/files/answer', answer, 30_000);
  }
}
