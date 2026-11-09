import { z } from 'zod';
import { RUN_STATUSES, TASK_STATUSES } from '@selarikru/domain';
import { INFERENCE_MODES } from '@selarikru/policy';
import { CursorSchema, ProvenanceSchema, VIEW_SCHEMA_VERSION } from './common.ts';
import { UsageEntrySchema } from './usage.ts';

const Id = z.string().min(1);
const Iso = z.iso.datetime();

/** Separate fields, never one state (architecture.md section 12). */
export const WORKER_AVAILABILITY = ['idle', 'assigned', 'offline'] as const;
export const WORKER_ACTIVITY = ['planning', 'coding', 'testing', 'reviewing', 'waiting_dependency', 'waiting_human', 'waiting_resource', 'blocked_policy'] as const;
export const WORKER_HEALTH = ['healthy', 'suspected_stall', 'disconnected', 'failed'] as const;
export type WorkerAvailability = (typeof WORKER_AVAILABILITY)[number];
export type WorkerActivity = (typeof WORKER_ACTIVITY)[number];
export type WorkerHealth = (typeof WORKER_HEALTH)[number];

export const ExecutionLocationSchema = z.enum(['local', 'cloud', 'unknown']);
export const ModelRouteSchema = z.enum(['device', 'cloud', 'unknown']);
export const ObservedSourceSchema = z.enum(['on_device', 'in_cloud', 'unknown']);

export const EvidenceRefSchema = z
  .object({ kind: z.string().min(1), ref: Id, at: Iso })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const RunViewSchema = z
  .object({
    runId: Id,
    lifecycle: z.enum(RUN_STATUSES),
    planRevision: z.number().int().min(0),
  })
  .strict();
export type RunView = z.infer<typeof RunViewSchema>;

export const TaskViewSchema = z
  .object({
    taskId: Id,
    runId: Id,
    revision: z.number().int().min(1),
    aggregateRevision: z.number().int().min(0),
    title: z.string().nullable(),
    role: z.string().nullable(),
    dependsOn: z.array(Id),
    status: z.enum(TASK_STATUSES),
    /** Why the task is in its status, when the scheduler said (block reason, failure reason). Null means nothing was said. */
    statusReason: z.string().nullable(),
    /** Permanent placement block (restricted data, missing grant or limit, approval required); null when none. */
    placementBlock: z.string().nullable(),
    /** Set once a cancel is requested; termination is not confirmed until the status is `cancelled`. */
    cancelRequested: z.object({ at: Iso, operationId: z.string().nullable() }).strict().nullable(),
    cancelReason: z.enum(['cancel_requested', 'budget_exhausted']).nullable(),
    supersededByRevision: z.number().int().min(1).nullable(),
    attemptIds: z.array(Id),
    activeAttemptId: Id.nullable(),
    enteredStatusAt: Iso,
    latestEvidence: EvidenceRefSchema.nullable(),
  })
  .strict();
export type TaskView = z.infer<typeof TaskViewSchema>;

export const AttemptViewSchema = z
  .object({
    attemptId: Id,
    taskId: Id,
    number: z.number().int().min(1),
    fence: z.number().int().min(0).nullable(),
    outcome: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    exitReason: z.string().nullable(),
    runnerId: z.string().nullable(),
    startedAt: Iso,
    endedAt: Iso.nullable(),
    lastHeartbeatAt: Iso.nullable(),
  })
  .strict();
export type AttemptView = z.infer<typeof AttemptViewSchema>;

export const WorkerViewSchema = z
  .object({
    workerId: Id,
    taskId: Id.nullable(),
    taskRevision: z.number().int().min(1).nullable(),
    attemptId: Id.nullable(),
    availability: z.enum(WORKER_AVAILABILITY),
    activity: z.enum(WORKER_ACTIVITY).nullable(),
    /** The last confirmed health. `suspected_stall` and `disconnected` are also derived from heartbeat age: see `effectiveWorkerHealth`. */
    health: z.enum(WORKER_HEALTH),
    /** True while the worker holds an attempt lease. Heartbeat age means nothing without one (waiting for a person, idle, offline). */
    leaseHeld: z.boolean(),
    stateReason: z.string().nullable(),
    enteredStateAt: Iso,
    latestAction: z.object({ tool: z.string().min(1), summary: z.string().nullable(), longRunning: z.boolean(), at: Iso }).strict().nullable(),
    latestEvidence: EvidenceRefSchema.nullable(),
    lastHeartbeatAt: Iso.nullable(),
    /** Axis one: where the worker's sandbox runs. */
    execution: ExecutionLocationSchema,
    /** Axis two: where the worker's model calls go. A local worker may call a cloud model. Unknown stays unknown. */
    modelRoute: ModelRouteSchema,
    blockedByTaskIds: z.array(Id),
    blockedByApprovalId: Id.nullable(),
  })
  .strict();
export type WorkerView = z.infer<typeof WorkerViewSchema>;

export const APPROVAL_STATES = ['pending', 'granted', 'denied'] as const;
export const ApprovalViewSchema = z
  .object({
    approvalId: Id,
    taskId: Id.nullable(),
    taskRevision: z.number().int().min(1).nullable(),
    runId: Id,
    scopeHash: z.string().nullable(),
    reason: z.string().nullable(),
    state: z.enum(APPROVAL_STATES),
    requestedAt: Iso,
    /** The stored state stays `pending` after this time; `approvalStateAt` reports it as expired. Expiry is explicit, never a grant. */
    expiresAt: Iso.nullable(),
    resolvedAt: Iso.nullable(),
  })
  .strict();
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const CheckViewSchema = z
  .object({
    checkId: Id,
    taskId: Id,
    state: z.enum(['running', 'passed', 'failed']),
    summary: z.string().nullable(),
    updatedAt: Iso,
    evidenceRef: Id,
  })
  .strict();
export type CheckView = z.infer<typeof CheckViewSchema>;

export const SnapshotMetaSchema = z
  .object({
    schemaVersion: z.literal(VIEW_SCHEMA_VERSION),
    projectId: Id,
    /** The sequence of the last event folded into this snapshot, as a string. Subscribe replays events after it. */
    cursor: CursorSchema,
    observedAt: Iso,
    provenance: ProvenanceSchema,
  })
  .strict();
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

/** The browser assistant's inference, on its own axis. Null mode means the assistant has not been used. */
export const AssistantViewSchema = z
  .object({
    mode: z.enum(INFERENCE_MODES).nullable(),
    observedSource: ObservedSourceSchema,
  })
  .strict();
export type AssistantView = z.infer<typeof AssistantViewSchema>;

export const ProjectViewSnapshotSchema = z
  .object({
    meta: SnapshotMetaSchema,
    assistant: AssistantViewSchema,
    runs: z.record(z.string(), RunViewSchema),
    tasks: z.record(z.string(), TaskViewSchema),
    attempts: z.record(z.string(), AttemptViewSchema),
    workers: z.record(z.string(), WorkerViewSchema),
    approvals: z.record(z.string(), ApprovalViewSchema),
    checks: z.record(z.string(), CheckViewSchema),
    usage: z.array(UsageEntrySchema),
  })
  .strict();
export type ProjectViewSnapshot = z.infer<typeof ProjectViewSnapshotSchema>;

export function emptySnapshot(init: { projectId: string; observedAt: string; provenance: z.infer<typeof ProvenanceSchema> }): ProjectViewSnapshot {
  return {
    meta: { schemaVersion: VIEW_SCHEMA_VERSION, projectId: init.projectId, cursor: '0', observedAt: init.observedAt, provenance: init.provenance },
    assistant: { mode: null, observedSource: 'unknown' },
    runs: {}, tasks: {}, attempts: {}, workers: {}, approvals: {}, checks: {}, usage: [],
  };
}
