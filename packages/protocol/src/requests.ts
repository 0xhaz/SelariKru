import { TaskSpecSchema } from '@selarikru/domain';
import { z } from 'zod';
import { redactSecrets } from './redact.ts';

const Key = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, 'expected 1-200 characters from A-Z a-z 0-9 . _ : -');
const Revision = z.number().int().min(0);

/** Every request object is strict: unknown fields (including anything secret-shaped) are rejected, not stored. */
/** The named run-level placement modes (docs/demo/benchmark-manifest.json, plus the optional L2 and C2). */
export const PLACEMENT_MODE_NAMES = ['L1', 'L2', 'C1', 'C2', 'H2'] as const;
export const RunPlacementSchema = z
  .object({
    mode: z.enum(PLACEMENT_MODE_NAMES),
    /** Execution destination ID (the region is part of the ID). Absent means no cloud destination: cloud starts are denied. */
    cloudDestination: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,127}$/).optional(),
  })
  .strict();
export type RunPlacement = z.infer<typeof RunPlacementSchema>;

export const CreateRunRequestSchema = z
  .object({
    idempotencyKey: Key,
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    /** Run budget ceiling in USD. Absent means the scheduler denies claims for this run until one is set. */
    budgetLimitUsd: z.number().finite().min(0).optional(),
    /** Where this run's tasks may run. Absent: local-only defaults, with cloud disabled. */
    placement: RunPlacementSchema.optional(),
    /** A benchmark trial: the run never opens an external pull request. Default false. */
    trial: z.boolean().optional(),
  })
  .strict();
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const BudgetStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), limitUsd: z.number() }).strict(),
  z.object({ status: z.literal('missing'), limitUsd: z.null(), claimsDenied: z.literal(true), reason: z.literal('missing_limit:budget.limitUsd') }).strict(),
]);
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const CreateRunResponseSchema = z.object({ runId: z.string(), budget: BudgetStatusSchema }).strict();
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,127}$/;
const SAFE_PATH = /^[A-Za-z0-9._:@+*\/-]{1,300}$/;

/**
 * A plan task as the API accepts it. The domain schema only requires non-empty strings, so everything that ends up in
 * events, snapshots and stored specs is held to an identifier alphabet here, and any secret-shaped value is refused.
 * `title` is the one free-text field; the API redacts it before storing.
 */
export const PlanTaskSchema = TaskSpecSchema.superRefine((spec, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const check = (value: string, path: (string | number)[], re: RegExp) => {
    if (!re.test(value)) bad(path, 'contains characters not allowed in an identifier');
    else if (redactSecrets(value) !== value) bad(path, 'looks like a secret');
  };
  const walk = (value: unknown, path: (string | number)[]): void => {
    if (typeof value === 'string') {
      if (path[0] === 'title') return;
      check(value, path, path[0] === 'allowedPaths' ? SAFE_PATH : SAFE_ID);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
  };
  walk(spec, []);
});

export const PlanRevisionRequestSchema = z
  .object({
    /** The run's current plan revision (0 before any plan). A stale value is a 409. */
    expectedRevision: Revision,
    idempotencyKey: Key.optional(),
    tasks: z.array(PlanTaskSchema).min(1).max(200),
  })
  .strict();
export type PlanRevisionRequest = z.infer<typeof PlanRevisionRequestSchema>;

export const TASK_COMMANDS = ['pause', 'cancel', 'retry', 'replan'] as const;
export const TaskCommandRequestSchema = z
  .object({
    command: z.enum(TASK_COMMANDS),
    /** The task's aggregate revision as shown in the snapshot. */
    expectedRevision: Revision,
    idempotencyKey: Key,
  })
  .strict();
export type TaskCommandRequest = z.infer<typeof TaskCommandRequestSchema>;

export const COMMAND_STATES = ['applied', 'cancel_requested'] as const;
export const TaskCommandResponseSchema = z
  .object({
    operationId: z.string(),
    command: z.enum(TASK_COMMANDS),
    /** `cancel_requested` is a request for active attempts, not confirmed termination. */
    state: z.enum(COMMAND_STATES),
    taskStatus: z.string(),
  })
  .strict();
export type TaskCommandResponse = z.infer<typeof TaskCommandResponseSchema>;

export const ApprovalResolveRequestSchema = z
  .object({
    decision: z.enum(['grant', 'deny']),
    scopeHash: z.string().min(1).max(200),
    expectedRevision: Revision,
    idempotencyKey: Key,
  })
  .strict();
export type ApprovalResolveRequest = z.infer<typeof ApprovalResolveRequestSchema>;

/** Accepts a budget-stopped run as delivered at reduced scope. The stopped criteria stay listed as not delivered. */
export const AcceptReducedScopeRequestSchema = z
  .object({
    /** The run's plan revision as the owner reviewed it. A stale value is a 409. */
    expectedPlanRevision: Revision,
    idempotencyKey: Key,
    note: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type AcceptReducedScopeRequest = z.infer<typeof AcceptReducedScopeRequestSchema>;

/** Sends a run's finished work, blocked by a verifier or assembly failure, back for another verdict. No worker runs. */
export const ReverifyRunRequestSchema = z
  .object({
    /** The run's plan revision as the owner saw it. A stale value is a 409. */
    expectedPlanRevision: Revision,
    idempotencyKey: Key,
  })
  .strict();
export type ReverifyRunRequest = z.infer<typeof ReverifyRunRequestSchema>;

export const INFERENCE_MODES = ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const;
export const INFERENCE_SOURCES = ['on_device', 'in_cloud', 'unknown'] as const;

/** What the browser says about its own inference. Stored as `untrusted`; never an input to task state or policy. */
export const ClientInferenceReportSchema = z
  .object({
    kind: z.literal('inference'),
    mode: z.enum(INFERENCE_MODES),
    observedSource: z.enum(INFERENCE_SOURCES),
    model: z.string().max(100).optional(),
  })
  .strict();
export type ClientInferenceReport = z.infer<typeof ClientInferenceReportSchema>;

export const PairingCodeRequestSchema = z.object({ location: z.enum(['local', 'cloud']) }).strict();
export const PairingCodeResponseSchema = z.object({ pairingCode: z.string(), location: z.enum(['local', 'cloud']), expiresAt: z.string() }).strict();

export const EnrollRequestSchema = z.object({ label: z.string().min(1).max(64).optional() }).strict();
export const EnrollResponseSchema = z
  .object({ runnerId: z.string(), token: z.string(), location: z.enum(['local', 'cloud']), tenantId: z.string() })
  .strict();
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;
