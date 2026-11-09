import {
  BlueprintContentSchema, COST_CADENCES, CostLineSchema, ExecutionChoiceSchema, FocusAnswersSchema, GoalAnswersSchema, INFERENCE_CHOICES, SourceAnswersSchema, type CostLine,
} from '@selarikru/domain';
import { z } from 'zod';

const Key = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const Revision = z.number().int().min(1);
const ownerWrite = { idempotencyKey: Key, expectedRevision: Revision };

/** Every request is strict: a client field the server did not ask for, such as a check result or a state, is rejected rather than ignored. */
export const CreateOnboardingRequestSchema = z.strictObject({ idempotencyKey: Key, goal: GoalAnswersSchema });
export const SaveAnswersRequestSchema = z.strictObject({ ...ownerWrite, goal: GoalAnswersSchema.optional(), source: SourceAnswersSchema.optional(), focus: FocusAnswersSchema.optional() })
  .refine((b) => b.goal !== undefined || b.source !== undefined || b.focus !== undefined, { message: 'nothing to save' });
/** Without `content` the controller drafts from the saved answers. With it, this is an owner edit and becomes a new version. */
export const CreateBlueprintRequestSchema = z.strictObject({ ...ownerWrite, content: BlueprintContentSchema.optional() });
export const AcceptBlueprintRequestSchema = z.strictObject({ ...ownerWrite, version: z.number().int().min(1) });

const OwnerCostLine = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,60}$/), label: z.string().trim().min(1).max(120), cadence: z.enum(COST_CADENCES),
  lowUsd: z.number().finite().min(0).nullable(), baseUsd: z.number().finite().min(0).nullable(), highUsd: z.number().finite().min(0).nullable(),
  /** The owner can estimate or say unknown. Only the server names a reference price, so a browser cannot dress a guess up as a sourced figure. */
  provenance: z.enum(['user_estimate', 'unknown']),
  basis: z.string().trim().min(1).max(300),
}).transform((l): CostLine => ({ ...l, source: null })).pipe(CostLineSchema);
export const SaveCostPlanRequestSchema = z.strictObject({
  ...ownerWrite,
  agentBudgetUsd: z.number().finite().positive().nullable(),
  provider: z.array(OwnerCostLine).max(20),
  app: z.array(OwnerCostLine).max(20),
});
export const SaveExecutionRequestSchema = z.strictObject({ ...ownerWrite, execution: ExecutionChoiceSchema, inference: z.enum(INFERENCE_CHOICES) });
/** No token, key, password or path field exists. The checkout is the deployment's own, read from its configuration. */
export const SaveConnectionRequestSchema = z.strictObject({
  ...ownerWrite,
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'expected owner/repository'),
  defaultBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/).refine((b) => !b.includes('..'), 'not a usable branch name'),
});
export const RunReadinessRequestSchema = z.strictObject({ expectedRevision: Revision });
export const ActivateOnboardingRequestSchema = z.strictObject({ ...ownerWrite, blueprintVersion: z.number().int().min(1) });
export const CancelOnboardingRequestSchema = z.strictObject({ expectedRevision: Revision });
export const AssistReviewRequestSchema = z.strictObject({
  envelope: z.strictObject({ operation: z.string().max(40), status: z.string().max(40), data: z.unknown() }),
  /** Set when the draft came from restricted text. Such a draft stays on the device, so the server refuses to look at it. */
  restricted: z.boolean().optional(),
});

export { OnboardingViewSchema, OnboardingListSchema, OnboardingCostPlanViewSchema, ReadinessCheckViewSchema, AssistReviewResponseSchema, type OnboardingView, type OnboardingList, type ReadinessCheckView, type AssistReviewResponse } from '@selarikru/domain';
