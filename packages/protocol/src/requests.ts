import { TaskSpecSchema } from '@selarikru/domain';
import { z } from 'zod';

const Key = z.string().min(1).max(200);
const Revision = z.number().int().min(0);

/** Every request object is strict: unknown fields (including anything secret-shaped) are rejected, not stored. */
export const CreateRunRequestSchema = z
  .object({
    idempotencyKey: Key,
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    /** Run budget ceiling in USD. Absent means the scheduler denies claims for this run until one is set. */
    budgetLimitUsd: z.number().finite().min(0).optional(),
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

export const PlanRevisionRequestSchema = z
  .object({
    /** The run's current plan revision (0 before any plan). A stale value is a 409. */
    expectedRevision: Revision,
    idempotencyKey: Key.optional(),
    tasks: z.array(TaskSpecSchema).min(1).max(200),
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
