import { err, ok, validateProposal, MAX_ATTEMPTS_CAP, type ProposalIssue, type Result, type TaskSpec } from '@selarikru/domain';
import { PlanTaskSchema } from '@selarikru/protocol';
import { z } from 'zod';

/**
 * Server side of proposal handling. A proposal is browser output and is untrusted; so is the client's claim about
 * its status or route. The server re-runs `validateProposal` with requirement IDs and scope phrases taken from its
 * own project configuration, then builds TaskSpec candidates in which every server-owned field comes from that
 * configuration. A candidate is only ever submitted through the existing plan-revision route by the authenticated owner.
 */

/** Project configuration the server trusts. Nothing here may be defaulted: missing blocks the action. */
export const ProjectPlanConfigSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    boardId: z.string().min(1),
    role: z.string().min(1),
    baseSha: z.string().min(1),
    allowedPaths: z.array(z.string().min(1)),
    classification: z.enum(['public', 'internal', 'restricted', 'secret']),
    policyVersion: z.string().min(1),
    execution: z.enum(['local', 'cloud', 'eligible_any']),
    inferencePolicyId: z.string().min(1),
    limits: z
      .object({
        maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CAP),
        timeoutSeconds: z.number().int().min(1),
        maxCostUsd: z.number().min(0),
      })
      .strict(),
    allowedRequirementIds: z.array(z.string().min(1)).min(1),
    forbiddenMandatoryScope: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProjectPlanConfig = z.input<typeof ProjectPlanConfigSchema>;

/** As the browser reports it. `status` is a claim, not a fact. */
export interface ProposalEnvelope {
  readonly operation: string;
  readonly status: string;
  readonly data: unknown;
}

export interface PlanReview {
  readonly tasks: TaskSpec[];
  /** True when a heuristic scope finding needs the engineer's explicit acknowledgement before acceptance. */
  readonly needsReview: boolean;
  readonly issues: readonly ProposalIssue[];
  /** Proposal fields with no TaskSpec counterpart. They are not carried. */
  readonly droppedFields: readonly string[];
}

export type PlanReviewError =
  | { code: 'proposal_not_acceptable'; reason: string }
  | { code: 'missing_server_config'; details: { path: string; message: string }[] }
  | { code: 'proposal_rejected'; issues: readonly ProposalIssue[] }
  | { code: 'task_invalid'; details: { path: string; message: string }[] };

export function reviewPlanProposal(
  envelope: ProposalEnvelope,
  rawConfig: ProjectPlanConfig,
  opts: { taskIdPrefix: string },
): Result<PlanReview, PlanReviewError> {
  if (envelope.status === 'route_violation' || envelope.status === 'unverified_source') {
    return err({ code: 'proposal_not_acceptable', reason: envelope.status });
  }
  if (envelope.status !== 'ok') return err({ code: 'proposal_not_acceptable', reason: `status_${envelope.status}` });
  if (envelope.operation !== 'draftTaskPlan') return err({ code: 'proposal_not_acceptable', reason: 'not_a_task_plan' });

  const cfg = ProjectPlanConfigSchema.safeParse(rawConfig);
  if (!cfg.success) {
    return err({ code: 'missing_server_config', details: cfg.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  const c = cfg.data;

  const v = validateProposal(envelope.data, {
    operation: 'draftTaskPlan',
    allowedRequirementIds: c.allowedRequirementIds,
    forbiddenMandatoryScope: c.forbiddenMandatoryScope,
  });
  if (v.status === 'rejected' || v.data === null || !('tasks' in v.data)) return err({ code: 'proposal_rejected', issues: v.issues });

  const tasks: TaskSpec[] = [];
  const bad: { path: string; message: string }[] = [];
  v.data.tasks.forEach((t, i) => {
    // Resource claims in a proposal are never carried; claims are server-owned.
    const parsed = PlanTaskSchema.safeParse({
      schemaVersion: 1, tenantId: c.tenantId, projectId: c.projectId, runId: c.runId, taskId: `${opts.taskIdPrefix}-${i + 1}`,
      boardId: c.boardId, revision: 1, role: c.role, title: t.title, baseSha: c.baseSha, requirementIds: [...t.requirementIds],
      dependencies: [], contractRefs: [], allowedPaths: c.allowedPaths, resourceClaims: [], acceptanceCheckIds: [],
      classification: c.classification, policyVersion: c.policyVersion, execution: c.execution, inferencePolicyId: c.inferencePolicyId,
      limits: c.limits,
    });
    if (parsed.success) tasks.push(parsed.data);
    else for (const is of parsed.error.issues) bad.push({ path: `tasks.${i}.${is.path.join('.')}`, message: is.message });
  });
  if (bad.length > 0) return err({ code: 'task_invalid', details: bad });

  return ok({ tasks, needsReview: v.status === 'needs_review', issues: v.issues, droppedFields: ['description'] });
}
