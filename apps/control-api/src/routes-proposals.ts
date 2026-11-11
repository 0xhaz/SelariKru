import { schema } from '@selarikru/persistence';
import { evaluate } from '@selarikru/policy';
import { redactSecrets } from '@selarikru/protocol';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TaskSpecSchema } from '@selarikru/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { proposalContentSha256, reviewPlanProposal, reviewPmPlan, ProjectPlanConfigSchema, type PlanReviewError, type VerifiedGrant } from './proposals.ts';
import { onboardingPlanSettings } from './routes-onboarding.ts';
import { parseBody } from './routes-owner.ts';
import { newId, requireProject, requireRun } from './store.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

const ReviewBodySchema = z
  .object({
    envelope: z.object({ operation: z.string().max(40), status: z.string().max(40), data: z.unknown() }).strict(),
    acknowledgedIssuePaths: z.array(z.string().max(200)).max(100).optional(),
    /** Present when the content derives from a restricted source: the draft and the grant the owner obtained. */
    restricted: z.object({ draftId: z.string().regex(SAFE_ID), grantId: z.string().regex(SAFE_ID) }).strict().optional(),
  })
  .strict();

/** Identifiers, hash, labels and reason only. Draft text is never sent to the server. */
const ReclassifyBodySchema = z
  .object({
    draftId: z.string().regex(SAFE_ID),
    contentSha256: Sha,
    sourceClassification: z.enum(['restricted', 'secret']),
    targetClassification: z.enum(['public', 'internal']),
    reason: z.string().trim().min(1).max(500),
    /** Optional. When set, the grant is usable only on this run. */
    runId: z.string().regex(SAFE_ID).optional(),
  })
  .strict();

const ownerOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
  return req.principal.uid;
};
const idParam = (req: FastifyRequest): string => (req.params as { id: string }).id;
const context = (draftId: string, sha: string) => `reclassify:${draftId}:${sha}`;
const PM_PLAN_REFUSAL: Readonly<Record<string, string>> = {
  revises_unknown: 'The plan revises a task this run does not have.',
  revises_locked: 'The plan revises a task that holds restricted data; that task is planned on this device only.',
  revises_duplicate: 'Two tasks of the plan revise the same task.',
  revises_role_changed: 'A revision keeps its task\'s role; a new role needs a new task.',
  path_outside_role: 'A task names a path outside its role\'s paths.',
  dependency_unknown: 'A task depends on a key the plan does not have.',
};

function toAppError(e: PlanReviewError): AppError {
  switch (e.code) {
    case 'proposal_not_acceptable': return new AppError(422, 'proposal_not_acceptable', 'this proposal cannot be accepted', { reason: e.reason });
    case 'missing_server_config': return new AppError(422, 'missing_server_config', 'project plan settings are missing or incomplete', e.details);
    case 'proposal_rejected': return new AppError(422, 'proposal_rejected', 'the proposal failed validation', e.issues.map((i) => ({ kind: i.kind, path: i.path, message: i.message })));
    case 'acknowledgement_required': return new AppError(409, 'acknowledgement_required', 'acknowledge the listed issues to continue', { paths: e.paths });
    case 'task_invalid': return new AppError(422, 'plan_invalid', 'a mapped task is not valid', e.details);
  }
}

export function registerProposalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };

  // Non-mutating: re-validates a browser proposal with server configuration and returns TaskSpec candidates. Acceptance is
  // a separate POST of those candidates to the plan-revision route by the owner.
  app.post('/v1/runs/:id/proposals/review', auth, async (req, reply) => {
    ownerOf(req);
    const body = parseBody(ReviewBodySchema, req.body);
    const run = await requireRun(db, config.tenantId, idParam(req));
    const settings = ctx.planConfig?.(run.projectId) ?? await onboardingPlanSettings(db, config.tenantId, run.projectId, ctx.policy, config.caps.attemptTimeoutSeconds);
    const cfg = ProjectPlanConfigSchema.safeParse({ ...(settings ?? {}), tenantId: config.tenantId, projectId: run.projectId, runId: run.runId });
    if (!settings || !cfg.success) {
      throw new AppError(422, 'missing_server_config', 'project plan settings are missing or incomplete', cfg.success ? [] : cfg.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }

    let grant: VerifiedGrant | undefined;
    if (body.restricted) {
      const sha = proposalContentSha256(body.envelope.data);
      const row = sha === null ? undefined : (await db.select().from(schema.decisions).where(and(
        eq(schema.decisions.tenantId, config.tenantId), eq(schema.decisions.projectId, run.projectId), eq(schema.decisions.decisionId, body.restricted.grantId))))[0];
      const a = (row?.affected?.[0] ?? null) as Record<string, unknown> | null;
      // Re-evaluate policy now: the stored allow is not enough once policy has changed or the grant has aged out.
      const current = evaluate({ kind: 'modify_policy', actor: 'administrator' }, ctx.policy);
      const expiresAt = typeof a?.['expiresAt'] === 'string' ? Date.parse(a['expiresAt']) : NaN;
      if (sha !== null && row && a && row.context === context(body.restricted.draftId, sha) && row.supersededBy === null
        && a['outcome'] === 'allow' && a['sourceClassification'] === 'restricted'
        && (a['targetClassification'] === 'public' || a['targetClassification'] === 'internal')
        && current.decision === 'allow' && a['policyVersion'] === current.policyVersion
        && Number.isFinite(expiresAt) && now().getTime() < expiresAt
        && (a['runId'] === null || a['runId'] === run.runId)) {
        grant = { grantId: row.decisionId, draftId: body.restricted.draftId, contentSha256: sha, sourceClassification: 'restricted', targetClassification: a['targetClassification'] };
      }
    }

    // H11 fix round 2 (I4): a Project Manager plan maps onto the run's current tasks (revises), reviewed with the same configuration.
    if (body.envelope.operation === 'pmPlan') {
      if (body.envelope.status !== 'ok') throw new AppError(422, 'proposal_not_acceptable', 'this proposal cannot be accepted', { reason: `status_${body.envelope.status}` });
      const current = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).innerJoin(schema.taskStatus, and(
        eq(schema.taskStatus.tenantId, schema.taskRevisions.tenantId), eq(schema.taskStatus.projectId, schema.taskRevisions.projectId), eq(schema.taskStatus.taskId, schema.taskRevisions.taskId), eq(schema.taskStatus.currentRevision, schema.taskRevisions.revision)))
        .where(and(eq(schema.taskRevisions.tenantId, config.tenantId), eq(schema.taskRevisions.projectId, run.projectId), eq(schema.taskRevisions.runId, run.runId), sql`${schema.taskStatus.status} NOT IN ('cancelled', 'superseded')`));
      const existing = current.flatMap((x) => { const p = TaskSpecSchema.safeParse(x.spec); return p.success ? [p.data] : []; });
      const pm = reviewPmPlan(body.envelope.data, cfg.data, existing, { taskIdPrefix: newId('prop').replace(/_/g, '-') });
      if (!pm.ok) {
        if (pm.error.code === 'pm_plan_refused') throw new AppError(422, 'pm_plan_refused', PM_PLAN_REFUSAL[pm.error.reason] ?? 'this plan cannot be accepted', { reason: pm.error.reason, key: pm.error.key });
        throw toAppError(pm.error as PlanReviewError);
      }
      return reply.code(200).send({ expectedRevision: run.planRevision ?? 0, tasks: pm.value.tasks, needsReview: false, droppedFields: [], issues: [] });
    }
    const r = reviewPlanProposal(body.envelope, cfg.data, {
      taskIdPrefix: newId('prop').replace(/_/g, '-'),
      ...(body.acknowledgedIssuePaths ? { acknowledgedIssuePaths: body.acknowledgedIssuePaths } : {}),
      ...(grant ? { grant } : {}),
      ...(body.restricted ? { declaredRestricted: true } : {}),
    });
    if (!r.ok) throw toAppError(r.error);
    return reply.code(200).send({
      expectedRevision: run.planRevision ?? 0,
      tasks: r.value.tasks,
      needsReview: r.value.needsReview,
      droppedFields: r.value.droppedFields,
      issues: r.value.issues.map((i) => ({ kind: i.kind, path: i.path, message: i.message })),
    });
  });

  // The server, not the browser, evaluates the policy change. The decision is persisted; the grant is bound to the draft
  // ID and content hash. The authenticated owner is the administrator for this single-owner deployment.
  app.post('/v1/projects/:id/draft-reclassifications', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(ReclassifyBodySchema, req.body);
    await requireProject(db, config.tenantId, projectId);
    if (body.sourceClassification === 'secret') throw new AppError(422, 'policy_denied', 'secret drafts are never published', { reason: 'secret_never_published' });

    const decision = evaluate({ kind: 'modify_policy', actor: 'administrator' }, ctx.policy);
    const decisionId = newId('dec');
    const at = now();
    const expiresAt = new Date(at.getTime() + config.reclassificationGrantTtlSeconds * 1000).toISOString();
    await db.insert(schema.decisions).values({
      tenantId: config.tenantId, projectId, decisionId, context: context(body.draftId, body.contentSha256),
      options: [], rationale: redactSecrets(body.reason), author: uid,
      affected: [{ draftId: body.draftId, contentSha256: body.contentSha256, sourceClassification: body.sourceClassification, targetClassification: body.targetClassification, outcome: decision.decision, reason: decision.reason, policyVersion: decision.policyVersion, runId: body.runId ?? null, expiresAt }],
    });
    if (decision.decision === 'allow') {
      // A newer grant for the same draft supersedes the earlier ones.
      const earlier = await db.select().from(schema.decisions).where(and(eq(schema.decisions.tenantId, config.tenantId), eq(schema.decisions.projectId, projectId), isNull(schema.decisions.supersededBy)));
      for (const d of earlier) {
        if (d.decisionId !== decisionId && d.context.startsWith(`reclassify:${body.draftId}:`)) {
          await db.update(schema.decisions).set({ supersededBy: decisionId }).where(and(eq(schema.decisions.tenantId, config.tenantId), eq(schema.decisions.projectId, projectId), eq(schema.decisions.decisionId, d.decisionId)));
        }
      }
    }
    if (decision.decision !== 'allow') {
      throw new AppError(403, 'policy_denied', 'policy does not allow this reclassification', { reason: decision.reason, decision: decision.decision, decisionId });
    }
    return reply.code(201).send({
      grant: {
        grantId: decisionId, draftId: body.draftId, contentSha256: body.contentSha256, sourceClassification: body.sourceClassification,
        targetClassification: body.targetClassification, decision, expiresAt, runId: body.runId ?? null,
      },
    });
  });
}
