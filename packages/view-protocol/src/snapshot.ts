import { z } from 'zod';
import { ASSIGNMENT_SCOPES, ASSIGNMENT_SOURCES, CATALOG_STATUSES, CheckStatusSchema, ModelSelectionSchema, RUN_SETTING_FIELDS, RUNNER_SETTING_FIELDS, RUN_STATUSES, SETTING_SCOPES, TASK_STATUSES } from '@selarikru/domain';
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

/** The model an attempt was launched with, as recorded at claim. It never changes afterwards. Null means no record exists, and the route stays unknown. */
export const RecordedModelSchema = z.object({ provider: Id, model: Id, source: z.enum(ASSIGNMENT_SOURCES) }).strict();
export type RecordedModel = z.infer<typeof RecordedModelSchema>;

/** What the installed harness adapters declare, and what policy says about each model. `none` and `unknown` carry no providers. */
export const ModelCatalogViewSchema = z
  .object({
    status: z.enum(CATALOG_STATUSES),
    detail: z.string().nullable(),
    /** What a role with no assignment runs. Null: the project has no default. */
    projectDefault: ModelSelectionSchema.nullable().default(null),
    providers: z.array(z.object({
      provider: Id, label: z.string().min(1), harnessVersion: z.string().nullable(),
      models: z.array(z.object({ modelId: Id, label: z.string().min(1), route: ModelRouteSchema, allowedByPolicy: z.boolean(), policyReason: z.string().nullable() }).strict()),
    }).strict()),
  })
  .strict();
export type ModelCatalogView = z.infer<typeof ModelCatalogViewSchema>;
export const UNKNOWN_MODEL_CATALOG: ModelCatalogView = { status: 'unknown', detail: null, projectDefault: null, providers: [] };

/**
 * Whether a saved change is in force. `applied`: its enforcer acknowledged it. `applying`: saved, and the server already gates claims on it, but the runner
 * has not confirmed it yet. `waiting_for_runner`: no runner is connected to confirm it. `waiting_for_runner_update`: a connected runner runs a build that never
 * acknowledges, so it must be updated; it is named in `waitingOn`. A save is never `applied` by being saved.
 */
export const SETTING_STATES = ['applied', 'applying', 'waiting_for_runner', 'waiting_for_runner_update'] as const;
export type SettingState = (typeof SETTING_STATES)[number];

/** The current assignment for a role or task. `revision` is what a change must send back. Null provider and model: removed, listed only for its revision. */
export const ModelAssignmentViewSchema = z
  .object({
    scope: z.enum(ASSIGNMENT_SCOPES), key: Id, provider: Id.nullable(), model: Id.nullable(), revision: z.number().int().min(1), updatedBy: z.string().min(1), updatedAt: Iso,
    /** Whether the runners have acknowledged this revision. Absent: the source has no acknowledgements at all (the demo's seeded assignments), and it reads as in force. */
    state: z.enum(SETTING_STATES).optional(),
    /** The runners a `waiting_for_runner_update` assignment waits on. */
    waitingOn: z.array(Id).optional(),
  })
  .strict();
export type ModelAssignmentView = z.infer<typeof ModelAssignmentViewSchema>;

/** A setting the owner saved, for a run or a worker, with what is in force. Values are closed shapes: a boolean, a number, plan paths. */
export const SettingViewSchema = z
  .object({
    scope: z.enum(SETTING_SCOPES),
    /** The run id for a run setting, the runner id for a worker setting. */
    key: Id,
    field: z.enum([...RUN_SETTING_FIELDS, ...RUNNER_SETTING_FIELDS]),
    desired: z.unknown(),
    /** What is in force now. Null: nothing saved has been acknowledged yet, so the configured value still applies. */
    effective: z.unknown(),
    desiredRevision: z.number().int().min(1),
    effectiveRevision: z.number().int().min(0),
    enforcer: z.enum(['server', 'runner']),
    state: z.enum(SETTING_STATES),
    /** The runners a `waiting_for_runner_update` setting waits on. */
    waitingOn: z.array(Id).optional(),
    updatedBy: z.string().min(1),
    updatedAt: Iso,
    appliedAt: Iso.nullable(),
  })
  .strict();
export type SettingView = z.infer<typeof SettingViewSchema>;

export const POLICY_BASES = ['configured', 'recommended', 'unresolved'] as const;
export type PolicyBasis = (typeof POLICY_BASES)[number];
const policyValue = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), basis: z.enum(POLICY_BASES) }).strict();

/**
 * A run's effective policy, from the server: what it may change, where it may run, its worker, repair and time limits, its budget, and how it merges. Each value
 * says whether it is configured, only recommended, or unresolved. Nothing here is computed in the browser.
 */
export const BoundedAutonomySchema = z
  .object({
    allowedPaths: policyValue(z.array(z.string())),
    /** Every path the accepted plan lists: the widest `allowedPaths` can be set to. A setting narrows the plan; it never widens it. */
    planPaths: z.array(z.string()).default([]),
    cloudEligible: policyValue(z.boolean()),
    cloudDestination: policyValue(z.string()),
    destinations: policyValue(z.array(z.object({ destination: z.string(), purpose: z.string() }).strict())),
    maxConcurrentWorkers: policyValue(z.number()),
    repairAttempts: policyValue(z.number()),
    attemptTimeoutSeconds: policyValue(z.number()),
    budgetLimitUsd: policyValue(z.number()),
    merge: policyValue(z.literal('human')),
    schedulingPaused: policyValue(z.boolean()),
  })
  .strict();
export type BoundedAutonomy = z.infer<typeof BoundedAutonomySchema>;

export const EvidenceRefSchema = z
  .object({ kind: z.string().min(1), ref: Id, at: Iso })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** What a run has not delivered: every current task not verified, merged or superseded, and what those tasks carry. Never counted as verified. */
export const NotDeliveredSchema = z
  .object({
    tasks: z.array(z.object({ taskId: Id, revision: z.number().int().min(1), status: z.string().min(1), budgetStopped: z.boolean() }).strict()),
    requirementIds: z.array(z.string()),
    acceptanceCheckIds: z.array(z.string()),
  })
  .strict();
export type NotDelivered = z.infer<typeof NotDeliveredSchema>;

/** Where a run stands against its plan after a budget stop, before anyone has accepted it. It comes only from a snapshot. */
export const ScopeAssessmentSchema = z
  .object({
    notDelivered: NotDeliveredSchema,
    /** The digest of `notDelivered`. An acceptance sends it back, so it can only record the list that was shown. */
    notDeliveredHash: Id,
    deliveredRequirementIds: z.array(z.string()),
    stopped: z.array(z.object({ taskId: Id, revision: z.number().int().min(1) }).strict()),
    /** Tasks with a budget stop still in flight: the scope is not final and cannot be accepted yet. */
    stoppingTaskIds: z.array(Id),
  })
  .strict();
export type ScopeAssessment = z.infer<typeof ScopeAssessmentSchema>;

/** A recorded acceptance of a budget-stopped run. It changes no task and verifies nothing. */
export const ReducedScopeViewSchema = z
  .object({
    decisionId: Id,
    runId: Id,
    planRevision: z.number().int().min(0),
    notDelivered: NotDeliveredSchema,
    deliveredRequirementIds: z.array(z.string()),
    acceptedAt: Iso,
    acceptedBy: z.string().min(1),
    note: z.string().nullable().default(null),
  })
  .strict();
export type ReducedScopeView = z.infer<typeof ReducedScopeViewSchema>;

/** One acceptance criterion and what the trusted verifier last said about it. `candidateSha` and `check` are both null, or both set: no check is `not_run`, or `not_delivered` for work that was stopped. */
export const CriterionEvidenceViewSchema = z
  .object({
    criterionId: Id,
    /** What the criterion asks for. Null when none is known. */
    description: z.string().nullable().default(null),
    state: z.union([CheckStatusSchema, z.literal('not_run'), z.literal('not_delivered')]),
    /** Counted in `criteria.verified`: a pass at the current revision on a live candidate. */
    verified: z.boolean(),
    taskIds: z.array(Id),
    check: z.object({ checkRunId: Id, checkId: Id, checkVersion: Id, taskId: Id, revision: z.number().int().min(1), attemptId: Id.nullable(), recordId: Id.nullable(), verificationAttempt: z.number().int().min(1), at: Iso }).strict().nullable(),
    candidateSha: Id.nullable(),
  })
  .strict();
export type CriterionEvidenceView = z.infer<typeof CriterionEvidenceViewSchema>;

/** The candidate the report is about and the record that judged it. Identifiers and hashes only. */
export const CandidateEvidenceViewSchema = z
  .object({
    sha: Id,
    status: z.string().min(1),
    /** False once the candidate was rejected or replaced: its passes count for nothing. */
    live: z.boolean(),
    baseSha: Id,
    treeSha: Id.nullable(),
    target: Id,
    recordedAt: Iso,
    recordId: Id.nullable(),
    /** The record still stands on the pull-request route's bar. False: nothing on this candidate counts, whatever its checks said. */
    recordValid: z.boolean().default(false),
    verifierHost: Id.nullable(),
    checkManifestSha256: Id.nullable(),
    verifierSha256: Id.nullable(),
    /** Criteria whose result changed between suite retries. A flaky pass stays visible. */
    flaky: z.array(Id),
  })
  .strict();
export type CandidateEvidenceView = z.infer<typeof CandidateEvidenceViewSchema>;

/** One failed test's words from the sealed verification record, redacted and bounded by the server. Candidate code influences this text: it is only ever shown as text. */
export const CriterionFailureViewSchema = z.object({ criterionId: Id, test: z.string(), status: CheckStatusSchema, message: z.string() }).strict();
export type CriterionFailureView = z.infer<typeof CriterionFailureViewSchema>;

/** `available` is false when the record is no longer valid, so there is nothing that can honestly be quoted. */
export const RunFailuresViewSchema = z.object({ candidateSha: Id.nullable(), available: z.boolean(), failures: z.array(CriterionFailureViewSchema) }).strict();
export type RunFailuresView = z.infer<typeof RunFailuresViewSchema>;

export const RunEvidenceViewSchema = z.object({ candidate: CandidateEvidenceViewSchema.nullable(), criteria: z.array(CriterionEvidenceViewSchema) }).strict();
export type RunEvidenceView = z.infer<typeof RunEvidenceViewSchema>;

export const RunViewSchema = z
  .object({
    runId: Id,
    /** Main moved, but rebuilding now would take a claim another task holds. Nothing was touched. */
    rebuildDeferred: z.object({ message: z.string(), at: Iso }).strict().nullable().optional(),
    /** A rebuild failed its verdict, main has moved since, and the automatic retry could not start. `run.reverify` can send it back. */
    failedRebuildMainMoved: z.boolean().optional(),
    lifecycle: z.enum(RUN_STATUSES),
    planRevision: z.number().int().min(0),
    /** Latest run-level evidence (candidate assembled, change proposed or merged). Run-level events never create tasks. */
    latestEvidence: EvidenceRefSchema.nullable(),
    /**
     * Acceptance criteria (FB-IDs) with qualifying evidence at this run's current revision. Null means per-criterion evidence is not connected:
     * a task count is then the most that can be said. Nothing derived from liveness or activity ever feeds this.
     */
    criteria: z.object({ verified: z.number().int().min(0), total: z.number().int().min(0) }).strict().refine((c) => c.verified <= c.total, { message: 'verified criteria cannot exceed the total' }).nullable().default(null),
    /** The per-criterion evidence behind `criteria`. Null exactly when `criteria` is: per-criterion evidence is not connected. */
    evidence: RunEvidenceViewSchema.nullable().default(null),
    /** Set once the owner accepted a budget stop. Null means nobody has. */
    reducedScope: ReducedScopeViewSchema.nullable().default(null),
    /** Null means the source has not reported one (or the run has no budget stop): the not-delivered list is then unknown, and is never read as empty. */
    scopeAssessment: ScopeAssessmentSchema.nullable().default(null),
    /** A benchmark trial's one model. Set, no assignment can change it. */
    pinnedModel: ModelSelectionSchema.nullable().default(null),
    /** The USD limit this run was created with. Absent or null: the source does not report it. */
    budgetLimitUsd: z.number().nullable().optional(),
    /** Set once the owner asked to cancel the run. The run is cancelled only when `lifecycle` says so: until then, active attempts are still stopping. */
    cancel: z.object({ requestedAt: Iso, requestedBy: z.string().nullable() }).strict().nullable().optional(),
    /** The effective policy. Absent or null: the source does not report it, and nothing is shown in its place. */
    policy: BoundedAutonomySchema.nullable().optional(),
    /** Every attempt of this run a person opened a shell in, older task revisions included. Absent: the source does not report it. */
    humanInterventions: z.array(z.object({ attemptId: Id, taskId: Id, at: Iso }).strict()).optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    // The count and its rows travel together: both or neither, and one row per approved criterion. A record that disagrees with itself is refused,
    // so no view can read a verified count that its own rows do not back.
    if ((run.criteria === null) !== (run.evidence === null)) {
      ctx.addIssue({ code: 'custom', path: [run.criteria === null ? 'criteria' : 'evidence'], message: 'criteria and evidence are both set or both null' });
      return;
    }
    if (run.criteria !== null && run.evidence !== null && run.evidence.criteria.length !== run.criteria.total) {
      ctx.addIssue({ code: 'custom', path: ['evidence', 'criteria'], message: `evidence lists ${run.evidence.criteria.length} criteria but the count says ${run.criteria.total}` });
    }
  });
export type RunView = z.infer<typeof RunViewSchema>;

export const TaskViewSchema = z
  .object({
    taskId: Id,
    runId: Id,
    revision: z.number().int().min(1),
    aggregateRevision: z.number().int().min(0),
    title: z.string().nullable(),
    role: z.string().nullable(),
    /** Null means unknown (events do not carry dependencies): it is filled from a snapshot. An empty list means no dependencies. */
    dependsOn: z.array(Id).nullable(),
    status: z.enum(TASK_STATUSES),
    /** Why the task is in its status, when the scheduler said (block reason, failure reason). Null means nothing was said. */
    statusReason: z.string().nullable(),
    /** Permanent placement block (restricted data, missing grant or limit, approval required); null when none. */
    placementBlock: z.string().nullable(),
    /** Set once a cancel is requested; termination is not confirmed until the status is `cancelled`. */
    /** `reason` `policy_revoked:...`: the owner narrowed a grant; the attempt stops and the task goes back to ready, blocked by policy, rather than cancelled. */
    cancelRequested: z.object({ at: Iso, operationId: z.string().nullable(), reason: z.string().nullable().optional() }).strict().nullable(),
    cancelReason: z.enum(['cancel_requested', 'budget_exhausted']).nullable(),
    supersededByRevision: z.number().int().min(1).nullable(),
    attemptIds: z.array(Id),
    activeAttemptId: Id.nullable(),
    enteredStatusAt: Iso,
    latestEvidence: EvidenceRefSchema.nullable(),
    /**
     * Derived when the snapshot is read, never recorded: the recent runners that could take this task are on a build that cannot deliver its knowledge packs, so it waits.
     * Absent or empty: not waiting for that.
     */
    skillRunnerWait: z.array(Id).optional(),
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
    /** The model recorded on this attempt at claim. */
    assignment: RecordedModelSchema.nullable().default(null),
    /** When a person first entered control mode on this attempt. Set durably, and never cleared. Absent or null: no person typed into its sandbox. */
    humanIntervenedAt: Iso.nullable().optional(),
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
    /** The model recorded on this worker's current attempt or, once idle, its previous one (see `attemptId`). Null: none recorded, and the provider stays unknown. */
    assignment: RecordedModelSchema.nullable().default(null),
    blockedByTaskIds: z.array(Id),
    blockedByApprovalId: Id.nullable(),
  })
  .strict();
export type WorkerView = z.infer<typeof WorkerViewSchema>;

export const APPROVAL_STATES = ['pending', 'granted', 'denied', 'expired', 'superseded'] as const;
export const ApprovalViewSchema = z
  .object({
    approvalId: Id,
    taskId: Id.nullable(),
    taskRevision: z.number().int().min(1).nullable(),
    runId: Id,
    scopeHash: z.string().nullable(),
    /** The worker's or policy's words about the request. For a worker's operation this text is worker-supplied and proves nothing. */
    reason: z.string().nullable(),
    /** What is being approved. Null means the request named no operation, which can never be granted. */
    operation: z.string().nullable().default(null),
    /** The structured destination the scope is bound to, when there is one. Never parsed from `reason`. */
    destination: z.string().nullable().default(null),
    requester: z.string().nullable().default(null),
    state: z.enum(APPROVAL_STATES),
    requestedAt: Iso,
    /** A sweep stores `expired`; until it runs the stored state stays `pending` and `approvalStateAt` reports it as expired. Expiry is explicit, never a grant. */
    expiresAt: Iso.nullable(),
    resolvedAt: Iso.nullable(),
  })
  .strict();
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

/** A request that was resolved. Snapshots return the recent ones; the open ones are in `approvals`. A grant is a record: `consumedAt` is when an attempt used it. */
export const ApprovalHistoryEntrySchema = z
  .object({
    approvalId: Id,
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    revision: z.number().int().min(1).nullable(),
    outcome: z.enum(['granted', 'denied', 'expired', 'superseded']),
    approver: z.string().nullable(),
    scopeHash: z.string().nullable(),
    operation: z.string().nullable(),
    destination: z.string().nullable(),
    requestedAt: Iso,
    resolvedAt: Iso.nullable(),
    consumedAt: Iso.nullable(),
    consumedBy: z.string().nullable(),
  })
  .strict();
export type ApprovalHistoryEntry = z.infer<typeof ApprovalHistoryEntrySchema>;

export const CheckViewSchema = z
  .object({
    checkId: Id,
    /** Null for a run-level check (a failed candidate). */
    taskId: Id.nullable(),
    state: z.enum(['running', 'passed', 'failed']),
    summary: z.string().nullable(),
    updatedAt: Iso,
    evidenceRef: Id,
  })
  .strict();
export type CheckView = z.infer<typeof CheckViewSchema>;

/** An enrolled, unrevoked runner. Its token is never part of this. Null `lastSeenAt`: it has not been seen since freshness was recorded. */
export const RunnerViewSchema = z
  .object({ runnerId: Id, location: z.enum(['local', 'cloud']), label: z.string().nullable(), lastSeenAt: Iso.nullable() })
  .strict();
export type RunnerView = z.infer<typeof RunnerViewSchema>;

/** Scheduler limits the source reports. Null: not reported, which is never read as unlimited. */
export const LimitsViewSchema = z.object({ maxConcurrentTotal: z.number().int().min(1).nullable() }).strict();
export type LimitsView = z.infer<typeof LimitsViewSchema>;

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

/** The reviewable change opened for a run. `status` is what the last authoritative read of GitHub said, and is kept as a string so a new status cannot break a snapshot. */
export const ChangeRequestViewSchema = z
  .object({
    runId: Id,
    prNumber: z.number().int().min(1),
    url: z.string().min(1),
    status: z.string().min(1),
    candidateSha: z.string().min(1),
    baseRef: z.string().min(1),
    observedHeadSha: z.string().nullable(),
    mergeCommitSha: z.string().nullable(),
    observedAt: Iso.nullable(),
    /** This open pull request no longer holds the run's live candidate: `main_moved` when a rebuild for a newer main retired it, `superseded` for any other reason. `rebuiltSha` is null until a newer commit exists. Null: it still holds the run's code. */
    outOfDate: z.object({ reason: z.enum(['main_moved', 'superseded']), at: Iso, rebuiltSha: Id.nullable(), rebuild: z.enum(['building', 'verifying', 'verified', 'failed', 'conflicted']) }).strict().nullable().default(null),
  })
  .strict();
export type ChangeRequestView = z.infer<typeof ChangeRequestViewSchema>;

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
    /** One per run at most. Merge reconciliation has no event of its own, so this slot arrives by snapshot and the refresh carries it. */
    changeRequests: z.array(ChangeRequestViewSchema).default([]),
    /** Recent resolved approvals, newest first and bounded by the source. */
    approvalHistory: z.array(ApprovalHistoryEntrySchema).default([]),
    modelCatalog: ModelCatalogViewSchema.default(UNKNOWN_MODEL_CATALOG),
    modelAssignments: z.array(ModelAssignmentViewSchema).default([]),
    runners: z.array(RunnerViewSchema).default([]),
    limits: LimitsViewSchema.default({ maxConcurrentTotal: null }),
    /** Every run and worker setting the owner saved. Empty: none saved, so every configured value stands. */
    settings: z.array(SettingViewSchema).default([]),
  })
  .strict();
export type ProjectViewSnapshot = z.infer<typeof ProjectViewSnapshotSchema>;

export function emptySnapshot(init: { projectId: string; observedAt: string; provenance: z.infer<typeof ProvenanceSchema> }): ProjectViewSnapshot {
  return {
    meta: { schemaVersion: VIEW_SCHEMA_VERSION, projectId: init.projectId, cursor: '0', observedAt: init.observedAt, provenance: init.provenance },
    assistant: { mode: null, observedSource: 'unknown' },
    runs: {}, tasks: {}, attempts: {}, workers: {}, approvals: {}, checks: {}, usage: [], changeRequests: [], approvalHistory: [], modelCatalog: UNKNOWN_MODEL_CATALOG, modelAssignments: [], runners: [], limits: { maxConcurrentTotal: null }, settings: [],
  };
}
