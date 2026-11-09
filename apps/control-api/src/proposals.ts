import { createHash } from 'node:crypto';
import { canonicalJson, CRITERION_DESCRIPTIONS, err, ok, validateProposal, MAX_ATTEMPTS_CAP, MAX_PROPOSAL_BYTES, type ProposalIssue, type Result, type TaskSpec } from '@selarikru/domain';
import { readFileSync } from 'node:fs';
import { PlanTaskSchema } from '@selarikru/protocol';
import { z } from 'zod';

/**
 * Server side of proposal handling. A proposal is browser output and is untrusted; so is the client's claim about
 * its status or route. The server re-runs `validateProposal` with requirement IDs and scope phrases taken from its
 * own project configuration, then builds TaskSpec candidates in which every server-owned field comes from that
 * configuration. A candidate is only ever submitted through the existing plan-revision route by the authenticated owner.
 */

/** Project configuration the server trusts. Nothing here may be defaulted: missing blocks the action. */
/** Project-level settings the server loads from its own configuration. Nothing here may be defaulted: missing blocks. */
export const ProjectPlanSettingsSchema = z
  .object({
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
    /** Required. An empty list is an explicit statement that no phrase is checked. */
    forbiddenMandatoryScope: z.array(z.string().min(1)),
    /** Criteria a run's plan as a whole must carry: the denominator it is judged against. Absent means this configuration fixes none. */
    requiredRequirementIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type ProjectPlanSettings = z.input<typeof ProjectPlanSettingsSchema>;

/** Settings plus the scope the route took from the authenticated request, never from the proposal. */
export const ProjectPlanConfigSchema = ProjectPlanSettingsSchema.extend({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
}).strict();
export type ProjectPlanConfig = z.input<typeof ProjectPlanConfigSchema>;

/** Production source of settings: a JSON file `{ "projects": { "<projectId>": { ...settings } } }`. Absent means blocked. */
export type PlanConfigSource = (projectId: string) => ProjectPlanSettings | undefined;

export function loadPlanConfigFile(path: string): PlanConfigSource {
  const parsed = z
    .object({ projects: z.record(z.string(), ProjectPlanSettingsSchema) })
    .strict()
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  return (projectId) => (Object.hasOwn(parsed.projects, projectId) ? parsed.projects[projectId] : undefined);
}

/** A reclassification grant the route verified against the persisted decision. */
export interface VerifiedGrant {
  readonly grantId: string;
  readonly draftId: string;
  readonly contentSha256: string;
  readonly sourceClassification: 'restricted';
  readonly targetClassification: 'public' | 'internal';
}

/** Null when the data is too large or too deep to hash safely. */
export function proposalContentSha256(data: unknown): string | null {
  try {
    const text = JSON.stringify(data);
    if (text === undefined || text.length > MAX_PROPOSAL_BYTES) return null;
    return createHash('sha256').update(canonicalJson(data)).digest('hex');
  } catch {
    return null;
  }
}

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
  | { code: 'acknowledgement_required'; paths: readonly string[] }
  | { code: 'task_invalid'; details: { path: string; message: string }[] };

export function reviewPlanProposal(
  envelope: ProposalEnvelope,
  rawConfig: ProjectPlanConfig,
  opts: { taskIdPrefix: string; acknowledgedIssuePaths?: readonly string[]; grant?: VerifiedGrant; declaredRestricted?: boolean },
): Result<PlanReview, PlanReviewError> {
  if (typeof envelope?.status !== 'string' || typeof envelope.operation !== 'string') {
    return err({ code: 'proposal_not_acceptable', reason: 'malformed_envelope' });
  }
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

  // Restricted or secret project content never becomes a hosted plan candidate without a server-verified grant bound to this content.
  let classification: 'public' | 'internal' | 'restricted' | 'secret' = c.classification;
  const rank = { public: 0, internal: 1, restricted: 2, secret: 3 } as const;
  const sha = proposalContentSha256(envelope.data);
  const grantOk = (g: VerifiedGrant | undefined): g is VerifiedGrant => !!g && sha !== null && g.sourceClassification === 'restricted' && g.contentSha256 === sha;
  // Content declared restricted needs a verified grant whatever the project label says.
  if (opts.declaredRestricted && !grantOk(opts.grant)) return err({ code: 'proposal_not_acceptable', reason: 'restricted_without_grant' });
  if (c.classification === 'secret') return err({ code: 'proposal_not_acceptable', reason: 'secret_content' });
  if (c.classification === 'restricted') {
    const g = opts.grant;
    if (!grantOk(g)) return err({ code: 'proposal_not_acceptable', reason: 'restricted_without_grant' });
    classification = g.targetClassification;
  } else if (opts.declaredRestricted && opts.grant && rank[opts.grant.targetClassification] > rank[classification]) {
    classification = opts.grant.targetClassification;
  }

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
      dependencies: [], contractRefs: [], allowedPaths: c.allowedPaths, resourceClaims: [], acceptanceCheckIds: t.requirementIds.filter((id) => Object.hasOwn(CRITERION_DESCRIPTIONS, id)),
      classification, policyVersion: c.policyVersion, execution: c.execution, inferencePolicyId: c.inferencePolicyId,
      limits: c.limits,
    });
    if (parsed.success) tasks.push(parsed.data);
    else for (const is of parsed.error.issues) bad.push({ path: `tasks.${i}.${is.path.join('.')}`, message: is.message });
  });
  if (bad.length > 0) return err({ code: 'task_invalid', details: bad });

  const needsReview = v.status === 'needs_review';
  if (needsReview) {
    const acked = new Set(opts.acknowledgedIssuePaths ?? []);
    const missing = v.issues.map((i) => `${i.kind}:${i.path}`).filter((k) => !acked.has(k));
    if (missing.length > 0) return err({ code: 'acknowledgement_required', paths: [...new Set(missing)] });
  }
  return ok({ tasks, needsReview, issues: v.issues, droppedFields: ['description'] });
}
