import { z } from 'zod';
import { ClassificationSchema } from './classification.ts';

export const TREATMENTS = ['allow', 'deny', 'require_approval'] as const;
export type Treatment = (typeof TREATMENTS)[number];

/** Operations whose treatment is hard-coded deny. No config or approval can change them. */
export const HARD_DENY_KINDS = [
  'production_data',
  'production_infrastructure',
  'deploy',
  'merge_protected_branch',
] as const;

export const OPERATION_KINDS = [
  'read_approved_docs',
  'run_scoped_tests',
  'edit_scoped_dev_branch',
  'create_draft_pr',
  'repair_within_limits',
  'start_cloud_worker',
  'new_domain',
  'new_connector',
  'broader_scope',
  'breaking_api_change',
  'scope_change',
  'budget_increase',
  'production_data',
  'production_infrastructure',
  'deploy',
  'merge_protected_branch',
  'modify_policy',
  'modify_credentials',
  'modify_org_permissions',
  'append_artifacts',
  'assign_replan_tasks',
  'assign_model',
  'destructive_data_migration',
  'terminal_control',
] as const;

/** Kinds needing a human decision: configurable to `require_approval` or `deny`, never `allow`. */
export const HUMAN_DECISION_KINDS = [
  'new_domain',
  'new_connector',
  'broader_scope',
  'breaking_api_change',
  'scope_change',
  'budget_increase',
  'destructive_data_migration',
] as const;

/** Administrator-only kinds. */
export const ADMIN_KINDS = ['modify_policy', 'modify_credentials', 'modify_org_permissions'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const PURPOSES = ['execution', 'inference', 'storage', 'telemetry', 'integration'] as const;
export const PurposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof PurposeSchema>;

/**
 * A grant for one destination and one purpose. It never implies another purpose.
 * Region is encoded in the destination ID (e.g. `cloud-sandbox-eu`); there is no separate region field.
 * `secret` cannot appear in a grant.
 */
export const DestinationGrantSchema = z
  .object({
    destination: z.string().min(1),
    purpose: PurposeSchema,
    classifications: z.array(ClassificationSchema.exclude(['secret'])),
  })
  .strict();
export type DestinationGrant = z.infer<typeof DestinationGrantSchema>;

const TreatmentSchema = z.enum(TREATMENTS);

const ModelSelectionSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();

/** Which provider models this project permits. Absent, no model can be assigned or launched. `default` is also the rate reference for budget holds. */
const ModelsPolicySchema = z.object({ allowed: z.array(ModelSelectionSchema), default: ModelSelectionSchema.optional() }).strict();

export const PolicySchema = z
  .object({
    policyVersion: z.string().min(1),
    operations: z.record(z.string(), TreatmentSchema).optional(),
    limits: z
      .object({
        maxConcurrentTotal: z.number().int().positive().optional(),
        maxIntegrationWorkers: z.number().int().positive().optional(),
        maxBrowserGenerations: z.number().int().positive().optional(),
        repairAttempts: z.number().int().nonnegative().optional(),
        attemptTimeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    destinations: z.array(DestinationGrantSchema).optional(),
    selectedSources: z.array(z.string()).optional(),
    models: ModelsPolicySchema.optional(),
    preferredMode: z.enum(['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD']).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const k of Object.keys(p.operations ?? {})) {
      if (!(OPERATION_KINDS as readonly string[]).includes(k)) {
        ctx.addIssue({ code: 'custom', message: `unknown operation ${k}`, path: ['operations', k] });
      }
    }
    for (const k of HUMAN_DECISION_KINDS) {
      if (p.operations?.[k] === 'allow') {
        ctx.addIssue({ code: 'custom', message: `${k} needs a human decision`, path: ['operations', k] });
      }
    }
    for (const k of HARD_DENY_KINDS) {
      const t = p.operations?.[k];
      if (t !== undefined && t !== 'deny') {
        ctx.addIssue({ code: 'custom', message: `${k} is a hard deny`, path: ['operations', k] });
      }
    }
  });
export type Policy = z.infer<typeof PolicySchema>;

export function parsePolicy(json: unknown): Policy {
  return PolicySchema.parse(json);
}
