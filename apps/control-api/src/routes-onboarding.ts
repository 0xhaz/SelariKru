import { createHash } from 'node:crypto';
import { BlueprintContentSchema, EXECUTION_CHOICES, pilotAttemptCapUsd, pilotCriteriaProblem, FocusAnswersSchema, GoalAnswersSchema, GoalAssistSchema, SetupSnapshotSchema, SourceAnswersSchema, NO_HARNESS_CATALOG, advanceOnboarding, blueprintFromAnswers, canonicalJson, costPlanFor, routeHonoursRecorded, templateSupport, validateProposal, type BlueprintContent, type CostAssumptions, type CostLine, type ExecutionChoice, type OnboardingEvent, type OnboardingState, type SetupSnapshot } from '@selarikru/domain';
import { recordOnboardingOperation, schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import {
  AcceptBlueprintRequestSchema, ActivateOnboardingRequestSchema, AssistReviewRequestSchema, CancelOnboardingRequestSchema, CreateBlueprintRequestSchema, CreateOnboardingRequestSchema, RunReadinessRequestSchema, SaveAnswersRequestSchema,
  SaveConnectionRequestSchema, SaveCostPlanRequestSchema, SaveExecutionRequestSchema, redactSecrets, type OnboardingView,
} from '@selarikru/protocol';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from './app.ts';
import { DEMO } from './demo.ts';
import { AppError, staleRevision } from './errors.ts';
import { performReadiness, type ReadinessResult } from './onboarding-readiness.ts';
import type { ProjectPlanSettings } from './proposals.ts';
import { parseBody } from './routes-owner.ts';
import { fingerprint, newId, requireProject, writeEvent } from './store.ts';

type Row = typeof schema.projectOnboardings.$inferSelect;
const ASSIST_CRITERIA_IDS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8'] as const;

const ownerOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
  return req.principal.uid;
};
const idParam = (req: FastifyRequest): string => (req.params as { id: string }).id;
const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');
const hashContent = (content: BlueprintContent): string => createHash('sha256').update(canonicalJson(content)).digest('hex');

/** Refuses text that looks like a credential, and names only where it was. This flow stores no credentials, so the value is never echoed or kept. */
export function assertNoCredentials(value: unknown): void {
  const paths: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') { if (redactSecrets(v) !== v) paths.push(path); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, '');
  if (paths.length > 0) throw new AppError(422, 'credential_in_input', 'That looks like a credential. This setup never stores credentials, so it was not saved. Remove it and try again.', { paths });
}

const refuseStep = (reason: string): AppError => new AppError(409, 'step_not_available', reason);
const advance = (state: OnboardingState, event: OnboardingEvent): OnboardingState => {
  const r = advanceOnboarding(state, event);
  if (!r.ok) throw refuseStep(state === 'activated' ? 'This project has started, so its setup can no longer change.' : 'That step is not available yet. Finish the earlier steps first.');
  return r.value;
};

const asExecutionChoice = (row: Row): ExecutionChoice | null => {
  const e = row.execution?.['execution'];
  return (EXECUTION_CHOICES as readonly unknown[]).includes(e) ? (e as ExecutionChoice) : null;
};
const asConnection = (row: Row): { repository: string; defaultBranch: string } | null => {
  const c = row.connection;
  return c && typeof c['repository'] === 'string' && typeof c['defaultBranch'] === 'string' ? { repository: c['repository'], defaultBranch: c['defaultBranch'] } : null;
};
type CostInputs = { agentBudgetUsd: number | null; effort: CostLine[]; production: CostLine[]; agentUsage: CostLine[]; assumptions?: CostAssumptions };
const costInputs = (row: Row): CostInputs | null => row.costInputs as CostInputs | null;
const inferenceOf = (row: Row): SetupSnapshot['inference'] => (row.execution?.['inference'] as SetupSnapshot['inference'] | undefined) ?? null;
const classificationOf = (row: Row): 'public' | 'internal' => { const g = GoalAnswersSchema.safeParse(row.answers['goal']); return g.success ? g.data.classification : 'internal'; };

async function requireOnboarding(db: Executor, tenantId: string, projectId: string, lock = false): Promise<Row> {
  const q = db.select().from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.projectId, projectId)));
  const row = (await (lock ? q.for('update') : q))[0];
  if (!row) throw new AppError(404, 'onboarding_not_found', 'no such setup');
  return row;
}

async function loadBlueprint(db: Executor, row: Row, version: number): Promise<typeof schema.projectBlueprints.$inferSelect | undefined> {
  return (await db.select().from(schema.projectBlueprints).where(and(eq(schema.projectBlueprints.tenantId, row.tenantId), eq(schema.projectBlueprints.projectId, row.projectId), eq(schema.projectBlueprints.version, version))))[0];
}

/** Which project's repository the deployment's one checkout already serves, ignoring the local demo seed. */
async function servedRepository(db: Executor, tenantId: string, exceptProject: string): Promise<{ projectId: string; repository: string } | null> {
  // A project whose setup was cancelled will never run, so it does not hold the checkout.
  const rows = await db.select({ projectId: schema.projects.projectId, repository: schema.projects.repository }).from(schema.projects)
    .where(and(eq(schema.projects.tenantId, tenantId), ne(schema.projects.projectId, exceptProject), ne(schema.projects.projectId, DEMO.projectId),
      sql`NOT EXISTS (SELECT 1 FROM project_onboardings o WHERE o.tenant_id = ${schema.projects.tenantId} AND o.project_id = ${schema.projects.projectId} AND o.cancelled_at IS NOT NULL)`))
    .orderBy(asc(schema.projects.createdAt)).limit(1);
  return rows[0] ?? null;
}

/**
 * Refuses a run on a project that onboarding owns until onboarding is done. Projects created another way (the demo seed, `dev:real`) have no row and are left alone.
 * Called by the run route as well as by activation, so an unsupported template cannot start a run by any route.
 */
export async function assertRunAllowed(db: Executor, tenantId: string, projectId: string, requested: { readonly budgetLimitUsd?: number | undefined; readonly placement?: { readonly mode: string } | undefined }): Promise<void> {
  const row = (await db.select().from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.projectId, projectId))))[0];
  if (!row) return;
  const version = row.acceptedBlueprintVersion ?? row.currentBlueprintVersion;
  const blueprint = version ? await loadBlueprint(db, row, version) : undefined;
  if (blueprint) {
    const support = templateSupport(BlueprintContentSchema.parse(blueprint.content).tracks);
    if (!support.executable) throw new AppError(422, 'template_not_supported', 'This project is a plan only: its template cannot start a run yet.', { unsupported: support.unsupported });
  }
  if (row.state !== 'activated' || row.cancelledAt !== null) throw new AppError(409, 'onboarding_not_activated', 'This project has not finished setup, so it cannot start a run.', { state: row.state });
  // Later runs stay inside what the owner authorised for this project.
  const snapshot = await loadSnapshot(db, row);
  if (!snapshot || snapshot.agentBudgetUsd === null || snapshot.execution === null) throw new AppError(422, 'outside_recorded_limits', 'This project has no recorded limits, so another run cannot start.');
  if (requested.budgetLimitUsd === undefined || requested.budgetLimitUsd > snapshot.agentBudgetUsd) throw new AppError(422, 'outside_recorded_limits', `A run on this project needs a budget of at most $${snapshot.agentBudgetUsd}, the ceiling recorded at setup.`, { agentBudgetUsd: snapshot.agentBudgetUsd });
  const mode = requested.placement?.mode ?? 'L1';
  const allowed = snapshot.execution === 'local' ? mode.startsWith('L') : snapshot.execution === 'cloud' ? mode.startsWith('C') : true;
  if (!allowed) throw new AppError(422, 'outside_recorded_limits', `This project was set up for ${snapshot.execution} execution, so a run cannot be placed elsewhere.`, { execution: snapshot.execution });
}

/** The frozen choices of the pass that currently stands. */
async function loadSnapshot(db: Executor, row: Row): Promise<SetupSnapshot | null> {
  if (row.currentReadinessPass === null) return null;
  const pass = (await db.select({ snapshot: schema.onboardingReadinessPasses.snapshot }).from(schema.onboardingReadinessPasses).where(and(eq(schema.onboardingReadinessPasses.tenantId, row.tenantId), eq(schema.onboardingReadinessPasses.projectId, row.projectId), eq(schema.onboardingReadinessPasses.pass, row.currentReadinessPass))))[0];
  const parsed = SetupSnapshotSchema.safeParse(pass?.snapshot);
  return parsed.success ? parsed.data : null;
}

/** Plan settings for a project that came through onboarding, from its own accepted blueprint and the commit its last readiness pass resolved. Nothing is defaulted. */
export async function onboardingPlanSettings(db: Executor, tenantId: string, projectId: string, policy: Policy | undefined, attemptTimeoutSeconds: number): Promise<ProjectPlanSettings | undefined> {
  const row = (await db.select().from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.projectId, projectId))))[0];
  if (!row || row.state !== 'activated' || !policy || !row.acceptedBlueprintVersion || row.currentReadinessPass === null) return undefined;
  const blueprintRow = await loadBlueprint(db, row, row.acceptedBlueprintVersion);
  const pass = (await db.select().from(schema.onboardingReadinessPasses).where(and(eq(schema.onboardingReadinessPasses.tenantId, tenantId), eq(schema.onboardingReadinessPasses.projectId, projectId), eq(schema.onboardingReadinessPasses.pass, row.currentReadinessPass))))[0];
  const snapshot = await loadSnapshot(db, row);
  const budget = snapshot?.agentBudgetUsd ?? null;
  const execution = snapshot?.execution ?? null;
  if (!blueprintRow || !pass?.baseSha || budget === null || !execution) return undefined;
  const blueprint = BlueprintContentSchema.parse(blueprintRow.content);
  const goal = GoalAnswersSchema.safeParse(row.answers['goal']);
  const maxAttempts = (policy.limits?.repairAttempts ?? 0) + 1;
  return {
    boardId: 'first-milestone', role: 'backend', baseSha: pass.baseSha, allowedPaths: blueprint.allowedPaths,
    classification: goal.success ? goal.data.classification : 'internal', policyVersion: policy.policyVersion, execution: execution === 'hybrid' ? 'eligible_any' : execution, inferencePolicyId: 'onboarding',
    // A claim reserves its task's whole cap, and no hold comes back, so the cap is sized for every attempt of every role.
    limits: { maxAttempts, timeoutSeconds: attemptTimeoutSeconds, maxCostUsd: blueprint.rolePaths ? pilotAttemptCapUsd(budget, maxAttempts) : budget },
    allowedRequirementIds: blueprint.acceptanceCriteria.map((c) => c.id), forbiddenMandatoryScope: blueprint.nonGoals,
    requirementText: Object.fromEntries(blueprint.acceptanceCriteria.map((c) => [c.id, c.text])),
    ...(templateSupport(blueprint.tracks).executable ? { requiredRequirementIds: blueprint.acceptanceCriteria.map((c) => c.id), ...(blueprint.rolePaths ? { rolePaths: blueprint.rolePaths } : {}) } : {}),
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const tenantId = config.tenantId;
  const declared = ctx.catalog ?? NO_HARNESS_CATALOG;

  const viewOf = async (exec: Executor, projectId: string): Promise<OnboardingView> => {
    const row = await requireOnboarding(exec, tenantId, projectId);
    const blueprintRow = row.currentBlueprintVersion ? await loadBlueprint(exec, row, row.currentBlueprintVersion) : undefined;
    const content = blueprintRow ? BlueprintContentSchema.parse(blueprintRow.content) : null;
    const goal = GoalAnswersSchema.safeParse(row.answers['goal']);
    const goalAssist = GoalAssistSchema.safeParse(row.answers['goalAssist']);
    const source = SourceAnswersSchema.safeParse(row.answers['source']);
    const focus = FocusAnswersSchema.safeParse(row.answers['focus']);
    const tracks = content?.tracks ?? (focus.success ? focus.data.tracks : null);
    const inputs = costInputs(row);
    const execution = asExecutionChoice(row);
    const plan = inputs ? costPlanFor({ ...inputs, execution }) : null;
    const pass = row.currentReadinessPass !== null ? (await exec.select().from(schema.onboardingReadinessPasses).where(and(eq(schema.onboardingReadinessPasses.tenantId, tenantId), eq(schema.onboardingReadinessPasses.projectId, projectId), eq(schema.onboardingReadinessPasses.pass, row.currentReadinessPass))))[0] : undefined;
    const served = await servedRepository(exec, tenantId, projectId);
    return {
      projectId, name: row.name, state: row.state as OnboardingState, revision: row.revision,
      condition: row.conditionKind ? { kind: row.conditionKind as 'needs_input' | 'blocked' | 'failed', reason: row.conditionReason ?? '' } : null,
      goal: goal.success ? goal.data : null, goalAssist: goalAssist.success ? goalAssist.data : null, source: source.success ? source.data : null, focus: focus.success ? focus.data : null,
      blueprint: blueprintRow && content ? { version: blueprintRow.version, accepted: row.acceptedBlueprintVersion === blueprintRow.version, origin: blueprintRow.origin as 'controller' | 'owner', contentSha256: blueprintRow.contentSha256, createdAt: blueprintRow.createdAt.toISOString(), content } : null,
      template: tracks ? (() => { const v = templateSupport(tracks); return { executable: v.executable, unsupported: [...v.unsupported] }; })() : null,
      costPlan: plan ? { agentBudgetUsd: plan.agentBudgetUsd, assumptions: plan.assumptions, ledgers: { build_effort: { lines: [...plan.ledgers.build_effort.lines], totals: plan.ledgers.build_effort.totals }, production: { lines: [...plan.ledgers.production.lines], totals: plan.ledgers.production.totals }, agent_usage: { lines: [...plan.ledgers.agent_usage.lines], totals: plan.ledgers.agent_usage.totals } }, confirmed: row.costConfirmedForVersion !== null && row.costConfirmedForVersion === row.currentBlueprintVersion } : null,
      execution: execution ? { execution, inference: row.execution!['inference'] as NonNullable<OnboardingView['execution']>['inference'] } : null,
      connection: asConnection(row),
      readiness: pass ? { blueprintVersion: pass.blueprintVersion, outcome: pass.outcome as 'ready' | 'blocked', checkedAt: pass.checkedAt.toISOString(), baseSha: pass.baseSha, snapshot: SetupSnapshotSchema.safeParse(pass.snapshot).data ?? null, checks: pass.checks as NonNullable<OnboardingView['readiness']>['checks'] } : null,
      firstRunId: row.firstRunId,
      deployment: { sourceCheckout: ctx.readiness?.sourceCheckout ?? null, servesRepository: served?.repository ?? null, checker: ctx.readiness !== undefined, maxAttempts: ctx.policy ? (ctx.policy.limits?.repairAttempts ?? 0) + 1 : null },
    };
  };

  const write = async (tx: Tx, row: Row, set: Partial<typeof schema.projectOnboardings.$inferInsert>): Promise<void> => {
    await tx.update(schema.projectOnboardings).set({ ...set, revision: row.revision + 1, updatedAt: now() }).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.projectId, row.projectId)));
  };

  /** The replay check runs before any lock or revision read, so a resent key returns the first result and does nothing else. */
  const receipt = <T>(tx: Tx, scope: string, key: string, print: string, fn: () => Promise<T>): Promise<T> =>
    recordOnboardingOperation(tx, { tenantId, scope, key }, async () => ({ fingerprint: print, result: await fn() })).then((stored: { fingerprint: string; result: T }) => {
      if (stored.fingerprint !== print) throw new AppError(422, 'idempotency_key_conflict', 'this idempotency key was used for a different request');
      return stored.result;
    });

  const clearReadiness = { currentReadinessPass: null, conditionKind: null, conditionReason: null };

  // ---- list, create and read -------------------------------------------------------------------------------------
  app.get('/v1/onboarding', auth, async (req) => {
    ownerOf(req);
    const rows = await db.select().from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), isNull(schema.projectOnboardings.cancelledAt))).orderBy(desc(schema.projectOnboardings.updatedAt));
    return { items: rows.map((r) => ({ projectId: r.projectId, name: r.name, state: r.state as OnboardingState, condition: (r.conditionKind ?? null) as 'needs_input' | 'blocked' | 'failed' | null, updatedAt: r.updatedAt.toISOString() })) };
  });

  app.post('/v1/onboarding', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const body = parseBody(CreateOnboardingRequestSchema, req.body);
    assertNoCredentials(body.goal);
    const projectId = await withTx(db, (tx) => receipt(tx, '_create', body.idempotencyKey, fingerprint(body), async () => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.onboarding.create:${tenantId}`}, 0))`);
      const key = nameKey(body.goal.name);
      const existing = (await tx.select({ projectId: schema.projectOnboardings.projectId }).from(schema.projectOnboardings)
        .where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.nameKey, key), isNull(schema.projectOnboardings.cancelledAt))))[0];
      if (existing) throw new AppError(409, 'project_already_started', 'A project with this name is already being set up. Resume it instead.', { projectId: existing.projectId });
      const id = newId('proj');
      await tx.insert(schema.projectOnboardings).values({ tenantId, projectId: id, name: body.goal.name, nameKey: key, state: 'draft', answers: { goal: body.goal, ...(body.goalAssist ? { goalAssist: body.goalAssist } : {}) }, createdBy: uid });
      return id;
    }));
    return reply.code(201).send(await viewOf(db, projectId));
  });

  app.get('/v1/onboarding/:id', auth, async (req) => {
    ownerOf(req);
    return viewOf(db, idParam(req));
  });

  /** Registers one owner write: parse, credential scan, replay check, row lock, compare-and-set, apply. A step that throws leaves no receipt and changes nothing. */
  const step = <S extends z.ZodType<{ idempotencyKey: string; expectedRevision: number }>>(path: string, bodySchema: S, apply: (tx: Tx, row: Row, body: z.infer<S>, uid: string) => Promise<void>) => {
    app.post(`/v1/onboarding/:id/${path}`, auth, async (req, reply) => {
      const uid = ownerOf(req);
      const projectId = idParam(req);
      const body = parseBody(bodySchema, req.body);
      assertNoCredentials(body);
      await withTx(db, (tx) => receipt(tx, projectId, `${path}:${body.idempotencyKey}`, fingerprint(body), async () => {
        const row = await requireOnboarding(tx, tenantId, projectId, true);
        if (row.cancelledAt !== null) throw new AppError(409, 'onboarding_cancelled', 'This setup was cancelled.');
        if (body.expectedRevision !== row.revision) throw staleRevision(row.revision, 'this setup');
        await apply(tx, row, body, uid);
        return { projectId };
      }));
      return reply.code(200).send(await viewOf(db, projectId));
    });
  };

  // ---- answers and blueprint --------------------------------------------------------------------------------------
  step('answers', SaveAnswersRequestSchema, async (tx, row, body) => {
    const answers: Record<string, unknown> = { ...row.answers, ...(body.goal ? { goal: body.goal } : {}), ...(body.source ? { source: body.source } : {}), ...(body.focus ? { focus: body.focus } : {}) };
    if (body.goalAssist !== undefined) { if (body.goalAssist === null) delete answers['goalAssist']; else answers['goalAssist'] = body.goalAssist; }
    if (canonicalJson(answers) === canonicalJson(row.answers)) return;
    const name = body.goal?.name ?? row.name;
    if (nameKey(name) !== row.nameKey) {
      const clash = (await tx.select({ projectId: schema.projectOnboardings.projectId }).from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.nameKey, nameKey(name)), isNull(schema.projectOnboardings.cancelledAt), ne(schema.projectOnboardings.projectId, row.projectId))))[0];
      if (clash) throw new AppError(409, 'project_already_started', 'Another project is already being set up with this name.', { projectId: clash.projectId });
    }
    await write(tx, row, { answers, name, nameKey: nameKey(name), state: advance(row.state as OnboardingState, 'answers_saved'), acceptedBlueprintVersion: null, ...clearReadiness });
  });

  step('blueprints', CreateBlueprintRequestSchema, async (tx, row, body, uid) => {
    if (body.content === undefined) {
      const answers = { goal: GoalAnswersSchema.safeParse(row.answers['goal']), source: SourceAnswersSchema.safeParse(row.answers['source']), focus: FocusAnswersSchema.safeParse(row.answers['focus']) };
      const missing = Object.entries(answers).filter(([, a]) => !a.success).map(([k]) => (k === 'source' ? 'starting point' : k));
      if (missing.length > 0) {
        await write(tx, row, { conditionKind: 'needs_input', conditionReason: `Answer the ${missing.join(' and ')} step before a blueprint can be drafted.` });
        return;
      }
      // The controller only drafts when answers have changed, or to restore a pilot blueprint that no longer matches what the verifier judges. Anywhere else this is a re-save, and it must not replace the owner's edits or lose acceptance.
      const existing = row.currentBlueprintVersion !== null ? await loadBlueprint(tx, row, row.currentBlueprintVersion) : undefined;
      const parsed = BlueprintContentSchema.safeParse(existing?.content);
      const stale = parsed.success && pilotCriteriaProblem(parsed.data) !== null;
      if (row.state !== 'discovering' && !stale) return;
    }
    const content = body.content ?? blueprintFromAnswers({ goal: row.answers['goal'], source: row.answers['source'], focus: row.answers['focus'] } as Parameters<typeof blueprintFromAnswers>[0]);
    const criteriaProblem = pilotCriteriaProblem(content);
    if (criteriaProblem !== null) throw new AppError(422, 'pilot_criteria_fixed', criteriaProblem);
    const contentSha256 = hashContent(content);
    if (row.currentBlueprintVersion !== null) {
      const current = await loadBlueprint(tx, row, row.currentBlueprintVersion);
      if (current?.contentSha256 === contentSha256 && row.state === 'blueprint_ready') return;
    }
    const state = advance(row.state as OnboardingState, 'blueprint_created');
    const version = (row.currentBlueprintVersion ?? 0) + 1;
    await tx.insert(schema.projectBlueprints).values({ tenantId, projectId: row.projectId, version, content, contentSha256, origin: body.content === undefined ? 'controller' : 'owner', createdBy: uid });
    await write(tx, row, { state, currentBlueprintVersion: version, acceptedBlueprintVersion: null, costConfirmedForVersion: null, ...clearReadiness });
  });

  step('blueprint/accept', AcceptBlueprintRequestSchema, async (tx, row, body) => {
    if (row.currentBlueprintVersion !== body.version) throw new AppError(409, 'stale_revision', 'That is not the current blueprint version.', { currentVersion: row.currentBlueprintVersion });
    await write(tx, row, { state: advance(row.state as OnboardingState, 'blueprint_accepted'), acceptedBlueprintVersion: body.version, ...clearReadiness });
  });

  // ---- configuration ----------------------------------------------------------------------------------------------
  const CONFIGURABLE = 'Accept the blueprint first.';
  const requireConfigurable = (row: Row): OnboardingState => {
    const r = advanceOnboarding(row.state as OnboardingState, 'configuration_saved');
    if (!r.ok) throw refuseStep(CONFIGURABLE);
    return r.value;
  };

  step('cost-plan', SaveCostPlanRequestSchema, async (tx, row, body) => {
    const state = requireConfigurable(row);
    const inputs = { agentBudgetUsd: body.agentBudgetUsd, effort: body.effort, production: body.production, agentUsage: body.agentUsage, assumptions: body.assumptions };
    const confirmedNow = row.costConfirmedForVersion === row.currentBlueprintVersion;
    if (confirmedNow && row.costInputs !== null && canonicalJson(inputs) === canonicalJson(row.costInputs)) return;
    await write(tx, row, { state, costInputs: inputs, costConfirmedForVersion: row.currentBlueprintVersion, ...clearReadiness });
  });

  step('execution', SaveExecutionRequestSchema, async (tx, row, body) => {
    const state = requireConfigurable(row);
    const execution = { execution: body.execution, inference: body.inference };
    if (row.execution !== null && canonicalJson(execution) === canonicalJson(row.execution)) return;
    // Only a change that alters the cost lines needs the plan looked at again.
    const inputs = costInputs(row);
    const linesOf = (e: ExecutionChoice | null): string => (inputs ? canonicalJson(costPlanFor({ ...inputs, execution: e }).ledgers) : '');
    const linesChanged = linesOf(asExecutionChoice(row)) !== linesOf(body.execution);
    await write(tx, row, { state, execution, ...(linesChanged ? { costConfirmedForVersion: null } : {}), ...clearReadiness });
  });

  step('connections', SaveConnectionRequestSchema, async (tx, row, body) => {
    const state = requireConfigurable(row);
    const connection = { repository: body.repository, defaultBranch: body.defaultBranch };
    if (row.connection !== null && row.projectCreated && canonicalJson(connection) === canonicalJson(row.connection)) return;
    // One checkout (SELARIKRU_SOURCE_REPO) serves every project in this deployment. A second repository would be assembled from the wrong code, so it is refused here.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.onboarding.repository:${tenantId}`}, 0))`);
    const served = await servedRepository(tx, tenantId, row.projectId);
    if (served && served.repository.toLowerCase() !== body.repository.toLowerCase()) {
      throw new AppError(409, 'second_repository_refused', `This deployment builds every project from one source checkout, and it already serves ${served.repository}. A second repository would be built from the wrong code. Use ${served.repository}, or run a separate deployment with its own SELARIKRU_SOURCE_REPO.`, { servesRepository: served.repository, projectId: served.projectId });
    }
    const classification = classificationOf(row);
    await tx.insert(schema.projects).values({ tenantId, projectId: row.projectId, repository: body.repository, defaultBranch: body.defaultBranch, classification })
      .onConflictDoUpdate({ target: [schema.projects.tenantId, schema.projects.projectId], set: { repository: body.repository, defaultBranch: body.defaultBranch } });
    await write(tx, row, { state, connection, projectCreated: true, ...clearReadiness });
  });

  // ---- readiness and activation -------------------------------------------------------------------------------------
  const inputsFor = (row: Row, blueprint: BlueprintContent) => {
    const budget = costInputs(row)?.agentBudgetUsd ?? null;
    return {
      db, tenantId, projectId: row.projectId, now: now(), probes: ctx.readiness, drivers: ctx.drivers?.(), classification: classificationOf(row), policy: ctx.policy, catalog: declared, pullRequestsEnabled: ctx.github?.pullRequests !== undefined,
      blueprint, connection: asConnection(row), execution: asExecutionChoice(row), agentBudgetUsd: budget, costPlanConfirmed: row.costConfirmedForVersion !== null && row.costConfirmedForVersion === row.currentBlueprintVersion,
    };
  };

  const currentBlueprint = async (exec: Executor, row: Row): Promise<BlueprintContent> => {
    const stored = row.currentBlueprintVersion ? await loadBlueprint(exec, row, row.currentBlueprintVersion) : undefined;
    if (!stored) throw refuseStep('There is no blueprint yet.');
    return BlueprintContentSchema.parse(stored.content);
  };

  const snapshotOf = (row: Row, baseSha: string | null): SetupSnapshot => {
    const connection = asConnection(row);
    return { blueprintVersion: row.currentBlueprintVersion!, execution: asExecutionChoice(row), inference: inferenceOf(row), agentBudgetUsd: costInputs(row)?.agentBudgetUsd ?? null, repository: connection?.repository ?? null, defaultBranch: connection?.defaultBranch ?? null, baseSha };
  };

  /** Records one pass under the row lock. The result can only come from `performReadiness`. */
  const recordPass = async (tx: Tx, row: Row, result: ReadinessResult): Promise<void> => {
    const prior = await tx.select({ pass: schema.onboardingReadinessPasses.pass }).from(schema.onboardingReadinessPasses).where(and(eq(schema.onboardingReadinessPasses.tenantId, tenantId), eq(schema.onboardingReadinessPasses.projectId, row.projectId))).orderBy(desc(schema.onboardingReadinessPasses.pass)).limit(1);
    const pass = (prior[0]?.pass ?? 0) + 1;
    const outcome = result.passed ? 'ready' : 'blocked';
    await tx.insert(schema.onboardingReadinessPasses).values({ tenantId, projectId: row.projectId, pass, blueprintVersion: row.currentBlueprintVersion!, outcome, checks: [...result.checks], baseSha: result.baseSha, snapshot: snapshotOf(row, result.baseSha), checkedAt: now() });
    const open = result.checks.filter((c) => c.required && c.status !== 'passed');
    await write(tx, row, {
      state: advance(row.state as OnboardingState, result.passed ? 'readiness_passed' : 'readiness_blocked'), currentReadinessPass: pass,
      conditionKind: result.passed ? null : 'blocked', conditionReason: result.passed ? null : `Not ready: ${open.map((c) => c.label).join(', ')}.`,
    });
  };

  app.post('/v1/onboarding/:id/readiness', auth, async (req, reply) => {
    ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(RunReadinessRequestSchema, req.body);
    const seen = await requireOnboarding(db, tenantId, projectId);
    let result: ReadinessResult | null = null;
    try {
      result = await performReadiness(inputsFor(seen, await currentBlueprint(db, seen)));
    } catch (e) {
      if (e instanceof AppError) throw e;
      result = null;
    }
    await withTx(db, async (tx) => {
      const row = await requireOnboarding(tx, tenantId, projectId, true);
      if (row.cancelledAt !== null) throw new AppError(409, 'onboarding_cancelled', 'This setup was cancelled.');
      if (body.expectedRevision !== row.revision) throw staleRevision(row.revision, 'this setup');
      if (result === null) {
        await write(tx, row, { conditionKind: 'failed', conditionReason: 'The checks could not be completed. Try again.' });
        return;
      }
      await recordPass(tx, row, result);
    });
    return reply.code(200).send(await viewOf(db, projectId));
  });

  app.post('/v1/onboarding/:id/activate', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(ActivateOnboardingRequestSchema, req.body);
    const seen = await requireOnboarding(db, tenantId, projectId);
    // Checked again now: a pass from earlier cannot start a run. Skipped once activated, where the receipt or the state decides.
    let fresh: ReadinessResult | null = null;
    if (seen.state === 'ready') {
      fresh = await performReadiness(inputsFor(seen, await currentBlueprint(db, seen)));
      if (!fresh.passed) {
        await withTx(db, async (tx) => {
          const row = await requireOnboarding(tx, tenantId, projectId, true);
          if (row.state === 'ready' && row.revision === seen.revision) await recordPass(tx, row, fresh!);
        });
        throw new AppError(409, 'readiness_failed', 'A readiness check no longer passes, so the run was not started. Review the checks and try again.');
      }
    }
    await withTx(db, (tx) => receipt(tx, projectId, `activate:${body.idempotencyKey}`, fingerprint(body), async () => {
      const row = await requireOnboarding(tx, tenantId, projectId, true);
      if (row.cancelledAt !== null) throw new AppError(409, 'onboarding_cancelled', 'This setup was cancelled.');
      if (row.state === 'activated') throw new AppError(409, 'already_activated', 'This project already started its first run.', { firstRunId: row.firstRunId });
      const blueprint = await currentBlueprint(tx, row);
      const support = templateSupport(blueprint.tracks);
      if (!support.executable) throw new AppError(422, 'template_not_supported', 'This project is a plan only: its template cannot start a run yet.', { unsupported: support.unsupported });
      const criteriaProblem = pilotCriteriaProblem(blueprint);
      if (criteriaProblem !== null) throw new AppError(422, 'pilot_criteria_fixed', criteriaProblem);
      if (body.expectedRevision !== row.revision) throw staleRevision(row.revision, 'this setup');
      if (row.state !== 'ready' || !fresh) throw new AppError(409, 'not_ready', 'Readiness has not passed for the current blueprint.', { state: row.state });
      if (row.currentBlueprintVersion !== body.blueprintVersion) throw new AppError(409, 'stale_revision', 'The blueprint changed since you reviewed it.', { currentVersion: row.currentBlueprintVersion });
      if (row.acceptedBlueprintVersion !== row.currentBlueprintVersion) throw refuseStep('Accept the current blueprint first.');
      const budget = costInputs(row)?.agentBudgetUsd ?? null;
      if (budget === null) throw refuseStep('A budget ceiling is required.');
      await requireProject(tx, tenantId, projectId);
      const execution = asExecutionChoice(row);
      const destination = ctx.policy?.destinations?.find((d) => d.purpose === 'execution')?.destination ?? null;
      const placement = execution === 'local' || execution === null ? null : { mode: execution === 'cloud' ? 'C1' : 'H2', cloudDestination: destination };
      const runId = newId('run');
      const at = now();
      const budgetJson = { limitUsd: budget };
      const snapshot = snapshotOf(row, fresh.baseSha);
      await tx.insert(schema.runs).values({ tenantId, projectId, runId, lifecycle: 'planning', budget: budgetJson, placement, setupSnapshot: snapshot });
      await writeEvent(tx, at, {
        projectId, runId, taskId: runId, aggregateRevision: 1, type: 'run.created', actor: { kind: 'human', id: uid },
        payload: { title: redactSecrets(blueprint.firstMilestone.title), budget: { status: 'set', limitUsd: budget }, ...(placement ? { placement } : {}), setup: snapshot },
      });
      // The pass that authorised this start was taken a moment ago; record it so the base commit a plan uses is that one.
      const prior = await tx.select({ pass: schema.onboardingReadinessPasses.pass }).from(schema.onboardingReadinessPasses).where(and(eq(schema.onboardingReadinessPasses.tenantId, tenantId), eq(schema.onboardingReadinessPasses.projectId, projectId))).orderBy(desc(schema.onboardingReadinessPasses.pass)).limit(1);
      const pass = (prior[0]?.pass ?? 0) + 1;
      await tx.insert(schema.onboardingReadinessPasses).values({ tenantId, projectId, pass, blueprintVersion: row.currentBlueprintVersion!, outcome: 'ready', checks: [...fresh.checks], baseSha: fresh.baseSha, snapshot, checkedAt: at });
      await write(tx, row, { state: advance(row.state as OnboardingState, 'activated'), firstRunId: runId, currentReadinessPass: pass, conditionKind: null, conditionReason: null });
      return { runId };
    }));
    return reply.code(200).send(await viewOf(db, projectId));
  });

  app.post('/v1/onboarding/:id/cancel', auth, async (req, reply) => {
    ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(CancelOnboardingRequestSchema, req.body);
    await withTx(db, async (tx) => {
      const row = await requireOnboarding(tx, tenantId, projectId, true);
      if (body.expectedRevision !== row.revision) throw staleRevision(row.revision, 'this setup');
      if (row.state === 'activated') throw new AppError(409, 'already_activated', 'An activated project cannot be cancelled here.');
      await write(tx, row, { cancelledAt: now() });
    });
    return reply.code(200).send(await viewOf(db, projectId));
  });

  // ---- assistant proposal review ------------------------------------------------------------------------------------
  // Non-mutating. A proposal is untrusted browser output. It can suggest text for the owner to accept; it never changes a row.
  app.post('/v1/onboarding/assist-review', auth, async (req, reply) => {
    ownerOf(req);
    const body = parseBody(AssistReviewRequestSchema, req.body);
    if (body.restricted === true) throw new AppError(422, 'restricted_stays_on_device', 'A draft made from restricted text stays on your device, so it cannot be applied here.');
    // Once a project has a recorded route, an answer that came by another one is not looked at.
    if (body.projectId !== undefined) {
      const row = await requireOnboarding(db, tenantId, body.projectId);
      const recorded = inferenceOf(row);
      if (recorded !== null && (!body.observed || !routeHonoursRecorded(recorded, body.observed.requestedMode, body.observed.source))) throw new AppError(422, 'route_not_recorded', 'This answer did not come by the route you recorded for this project, so it was not used.');
    }
    if (body.envelope.status !== 'ok' || body.envelope.operation !== 'draftBrief') throw new AppError(422, 'proposal_not_acceptable', 'This proposal cannot be used.', { reason: body.envelope.status === 'ok' ? 'wrong_operation' : `status_${body.envelope.status}` });
    const v = validateProposal(body.envelope.data, { operation: 'draftBrief', allowedRequirementIds: [...ASSIST_CRITERIA_IDS], forbiddenMandatoryScope: [] });
    if (v.status === 'rejected' || v.data === null || !('summary' in v.data)) throw new AppError(422, 'proposal_rejected', 'The proposal failed validation.', v.issues.map((i) => ({ kind: i.kind, path: i.path, message: i.message })));
    assertNoCredentials(v.data);
    return reply.code(200).send({
      status: v.status === 'needs_review' ? ('needs_review' as const) : ('valid' as const),
      summary: v.data.summary,
      acceptanceCriteria: v.data.acceptanceCriteria.map((c) => ({ id: c.requirementId, text: c.text })),
      issues: v.issues.map((i) => ({ kind: i.kind, path: i.path, message: i.message })),
    });
  });
}
