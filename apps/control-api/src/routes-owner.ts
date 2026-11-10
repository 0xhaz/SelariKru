import { NO_HARNESS_CATALOG, OPEN_HANDOVER_STATES, isHandoverReason, availableCatalog, restrictedStoredPayload, restrictedStoredReason, newTaskStateFromSpec, transition, validatePlanRevision, TaskSpecSchema, budgetUsed, type AttemptRecord, type PlanError, type TaskSpec, type TaskStatus } from '@selarikru/domain';
import { readUsageEntries, schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import { evaluate, type Operation } from '@selarikru/policy';
import {
  AcceptReducedScopeRequestSchema, ApprovalResolveRequestSchema, ClientInferenceReportSchema, CreateRunRequestSchema, ModelAssignmentRequestSchema, PlanRevisionRequestSchema, ReverifyRunRequestSchema, TaskCommandRequestSchema,
  redactSecrets, type BudgetStatus,
} from '@selarikru/protocol';
import { assignmentRevision, catalogView, loadModelAssignments, loadRecentRunnerReports, loadRunEvidence, validateSelection, acceptanceCovers, assessRunScope, modelOverRunBudget, planCapMicros, leaseHealth, loadAcceptedReducedScope, notDeliveredHash, reducedScopeContext, leaveReviewForPlan, lockBeforeRunRow, lockStaleCandidate, lockPartsForClaims, releaseTaskClaims, retireStaleCandidate, reverifyRun, type AcceptedReducedScope, type ReverifyOutcome, type StaleCandidate } from '@selarikru/workflow';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from './app.ts';
import { AppError, invalidRequest, staleRevision } from './errors.ts';
import { assertRunAllowed, onboardingPlanSettings, recordedBudgetCeiling } from './routes-onboarding.ts';
import { assignmentState, boundedAutonomy, bumpConfigRevision, eventRunFor, loadSettingsView } from './settings.ts';
import { skillRunnerWaits } from './skills.ts';
import {
  bumpStatus, fingerprint, idempotent, loadSpecRow, newId, requireProject, requireRun, requireTaskStatus, writeEvent,
} from './store.ts';

export function parseBody<S extends z.ZodType>(schemaDef: S, body: unknown): z.infer<S> {
  const r = schemaDef.safeParse(body ?? {});
  if (!r.success) {
    throw invalidRequest('request body failed validation', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const budgetStatus = (budget: Record<string, unknown>): BudgetStatus => {
  const limit = budget['limitUsd'];
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
    ? { status: 'set', limitUsd: limit }
    : { status: 'missing', limitUsd: null, claimsDenied: true, reason: 'missing_limit:budget.limitUsd' };
};

const ownerOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
  return req.principal.uid;
};
const idParam = (req: FastifyRequest): string => (req.params as { id: string }).id;

const SYSTEM_ACTOR = { kind: 'system', id: 'control-api' } as const;
// Nothing holds a live attempt in any of these: `blocked` and `awaiting_approval` tasks wait on a person, and a replan is one of the ways they can move on.
const REPLANNABLE: readonly string[] = ['planned', 'ready', 'blocked', 'awaiting_approval'];
// Only a running task has a live attempt to stop. Every other active status has none, so cancel is immediate.
const IMMEDIATE_CANCEL: readonly string[] = ['planned', 'ready', 'awaiting_approval', 'blocked', 'verifying'];
const CANCEL_REQUEST: readonly string[] = ['running'];
const APPROVAL_HISTORY_LIMIT = 50;
/** Finished runs whose scope and evidence a snapshot reads, the newest ones. An older finished run keeps its rows but reports neither, so the cost of a refresh does not grow with the project's history. */
const SNAPSHOT_EVIDENCE_RUNS = 20;
const TERMINAL_RUN: readonly string[] = ['merged', 'failed', 'cancelled'];
const FAILURE_LIMIT = 200;
const FAILURE_TEXT_LIMIT = 2000;
/** Redacted before it is bounded, so a cut can never split a secret past the pattern. */
const failureText = (text: string): string => redactSecrets(text).slice(0, FAILURE_TEXT_LIMIT);
/** Events that move a task to a new status, in time order they say when it entered it. */
const STATUS_EVENTS = ['task.ready', 'attempt.started', 'attempt.completed', 'attempt.failed', 'approval.requested', 'approval.granted', 'approval.denied', 'task.blocked', 'verification.started', 'verification.passed', 'verification.failed', 'change.merged', 'task.cancelled', 'task.superseded', 'task.reopened'] as const;
const TASK_EVIDENCE_EVENTS = ['attempt.started', 'attempt.completed', 'attempt.failed', 'approval.granted', 'approval.denied', 'verification.started', 'verification.passed', 'verification.failed', 'change.merged', 'change.proposed', 'candidate.assembled', 'candidate.failed', 'task.reopened'] as const;
const RUN_EVIDENCE_EVENTS = ['candidate.assembled', 'candidate.failed', 'change.proposed', 'change.merged', 'run.reverted'] as const;
const eventTime = (row: Record<string, unknown>): string => new Date(row['occurred_at'] as string | Date).toISOString();

/** An open request for a task that was replaced or cancelled can no longer be resolved. */
async function supersedePendingApprovals(tx: Tx, tenantId: string, projectId: string, taskId: string, at: Date): Promise<void> {
  await tx.update(schema.approvals).set({ outcome: 'superseded', resolvedAt: at }).where(and(
    eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.projectId, projectId), eq(schema.approvals.taskId, taskId), eq(schema.approvals.outcome, 'pending')));
}


/**
 * `approvals.expected_revisions` maps what the approver saw to its revision: `planRevision` for the run's plan, any other
 * key for a task id's current revision. A key that cannot be checked fails closed.
 */
async function checkExpectedRevisions(tx: Tx, expected: Record<string, unknown>, projectId: string, runId: string, tenantId: string): Promise<void> {
  for (const [key, want] of Object.entries(expected)) {
    let have: number | null = null;
    if (key === 'planRevision') {
      const run = (await tx.select().from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, runId))))[0];
      have = run ? (run.planRevision ?? 0) : null;
    } else {
      const task = (await tx.select().from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, key))))[0];
      have = task ? task.currentRevision : null;
    }
    if (typeof want !== 'number' || have === null || want !== have) {
      throw new AppError(409, 'stale_revision', 'the approval was granted against revisions that have changed', { key, expected: want ?? null, current: have });
    }
  }
}

/** `task.blocked` names its reason; a reopen blocked by a claim conflict names it as `blocked`; a denied approval has no separate reason. */
function blockedReasonOf(rows: readonly Record<string, unknown>[], taskId: string): string | null {
  const row = rows.find((r) => r['task_id'] === taskId);
  if (!row) return null;
  if (row['type'] === 'approval.denied') return 'approval_denied';
  const payload = row['payload'] as Record<string, unknown>;
  const reason = row['type'] === 'task.reopened' ? payload['blocked'] : payload['reason'];
  return typeof reason === 'string' ? reason : null;
}

/** A task can still get an attempt in any of these. A closed task has none left, so an override on it would be a record of nothing. */
const ASSIGNABLE_TASK: readonly string[] = ['planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying', 'failed'];

export function registerOwnerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const declared = ctx.catalog ?? NO_HARNESS_CATALOG;
  /** What can actually be launched: the adapters this build declares, narrowed to what recently seen runners report. A model only an old enrolment reports cannot start. */
  const liveCatalog = async (tx: Executor) => availableCatalog(declared, await loadRecentRunnerReports(tx, config.tenantId, now()));

  /** A refused selection as a typed error, so the screen can say which check failed. */
  const refuseSelection = async (tx: Executor, selection: { provider: string; model: string }): Promise<AppError | null> => {
    const verdict = validateSelection(selection, await liveCatalog(tx), ctx.policy);
    if (verdict.ok) return null;
    if (verdict.reason === 'model_not_allowed') return new AppError(403, 'model_not_allowed', 'policy does not allow this model', { reason: verdict.decision?.reason, provider: selection.provider, model: selection.model });
    return new AppError(422, verdict.reason === 'no_provider_detected' ? 'no_provider_detected' : verdict.reason === 'unsupported_provider' ? 'unsupported_provider' : 'unsupported_model', `cannot assign ${selection.provider}/${selection.model}: ${verdict.reason}`, { provider: selection.provider, model: selection.model });
  };

  /**
   * The SHA of a run's current candidate when its record no longer stands, else null. Read before a transaction, as the pull-request route does: loading a record takes its own
   * connection. With no evidence wiring nothing can be judged, so nothing is reported stale. Under the locks `lockStaleCandidate` checks it is still this candidate.
   */
  const staleCandidateOf = async (projectId: string, runId: string): Promise<string | null> => {
    if (!ctx.evidence) return null;
    const [latest] = await db.execute(sql`
      SELECT sha, status FROM candidates WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND sha IS NOT NULL AND status IN ('assembled', 'rejected')
      ORDER BY created_at DESC, candidate_id DESC LIMIT 1`);
    if (!latest || latest['status'] !== 'assembled') return null;
    const sha = String(latest['sha']);
    return (await ctx.evidence.loadRecord({ tenantId: config.tenantId, projectId, sha })) === null ? sha : null;
  };
  /** A verified task may only leave through cancel or replan while it is a part, at this revision, of a candidate whose record no longer stands. */
  const isStalePart = (candidate: StaleCandidate | null, taskId: string, status: string, revision: number): boolean =>
    status === 'verified' && candidate !== null && candidate.parts.some((p) => p.taskId === taskId && p.revision === revision);

  // ---- model assignments -------------------------------------------------------------------------------------
  app.post('/v1/projects/:id/model-assignments', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(ModelAssignmentRequestSchema, req.body);
    await requireProject(db, config.tenantId, projectId);
    const gate = evaluate({ kind: 'assign_model', selection: body.selection }, ctx.policy);
    if (gate.decision === 'deny' && gate.reason !== 'model_not_allowed') throw new AppError(403, 'policy_denied', 'policy does not allow assigning models', { reason: gate.reason, decision: gate.decision });
    if (gate.decision === 'require_approval') throw new AppError(403, 'policy_denied', 'policy does not allow assigning models here', { reason: gate.reason, decision: gate.decision });
    const at = now();
    const result = await withTx(db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.model_assignment:${config.tenantId}:${projectId}:${body.scope}:${body.key}`}, 0))`);
      return idempotent(tx, { tenantId: config.tenantId, projectId, key: `model.assign:${body.scope}:${body.key}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        const current = await assignmentRevision(tx, config.tenantId, projectId, body.scope, body.key);
        if (body.expectedRevision !== current) throw staleRevision(current, 'this assignment');
        if (body.scope === 'task') {
          const [row] = await tx.select().from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, config.tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, body.key)));
          if (!row) throw new AppError(404, 'task_not_found', 'no such task in this project');
          const specRow = await loadSpecRow(tx, { tenantId: config.tenantId, projectId, taskId: body.key, revision: row.currentRevision });
          const run = specRow ? await requireRun(tx, config.tenantId, specRow.runId) : null;
          if (!run) throw new AppError(404, 'task_not_found', 'task revision is missing');
          if (run.trial) throw new AppError(409, 'trial_model_pinned', 'a benchmark trial pins one model and refuses overrides', { pinnedModel: run.pinnedModel });
          if (!ASSIGNABLE_TASK.includes(row.status)) throw new AppError(403, 'command_not_allowed', `cannot assign a model to a task that is ${row.status}`, { status: row.status });
        }
        if (body.selection !== null) {
          const refused = await refuseSelection(tx, body.selection);
          if (refused) throw refused;
        }
        if (body.selection !== null) {
          const settings = ctx.planConfig?.(projectId) ?? await onboardingPlanSettings(tx, config.tenantId, projectId, ctx.policy, config.caps.attemptTimeoutSeconds);
          if (settings?.rolePaths) {
            const over = await modelOverRunBudget(tx, { tenantId: config.tenantId, projectId, change: { scope: body.scope, key: body.key, selection: body.selection }, catalog: ctx.catalog ?? NO_HARNESS_CATALOG, policy: ctx.policy });
            if (over) throw new AppError(422, 'model_over_run_budget', `With the caps frozen on this plan, this model needs a run budget of at least $${over.neededUsd}, and this run has $${over.limitUsd}: every attempt holds its worst case, so a worker could not start. Choose a cheaper model, or set the model before a plan is accepted so the caps are sized for it.`, over);
          }
        }
        const revision = current + 1;
        // The runner config revision that carries it: the assignment is in force once every recent runner acknowledges it (`acknowledgeRunnerConfig`).
        // Lock order: this assignment's advisory lock, the runner config row, then the event sequence.
        const configRevision = await bumpConfigRevision(tx, config.tenantId);
        const previous = current > 0 ? (await tx.select().from(schema.modelAssignments).where(and(eq(schema.modelAssignments.tenantId, config.tenantId), eq(schema.modelAssignments.projectId, projectId), eq(schema.modelAssignments.scopeKind, body.scope), eq(schema.modelAssignments.scopeKey, body.key), eq(schema.modelAssignments.revision, current))))[0] : undefined;
        await tx.insert(schema.modelAssignments).values({
          tenantId: config.tenantId, projectId, scopeKind: body.scope, scopeKey: body.key, revision,
          provider: body.selection?.provider ?? null, model: body.selection?.model ?? null, updatedBy: uid, updatedAt: at, configRevision,
        });
        const eventRun = await eventRunFor(tx, config.tenantId, projectId, body.scope === 'task' ? body.key : null);
        // Identifiers only: a provider and a model id, both checked against the catalog above.
        if (eventRun !== null) {
          await writeEvent(tx, at, {
            projectId, runId: eventRun, taskId: eventRun, aggregateRevision: revision, type: 'settings.changed', actor: { kind: 'human', id: uid },
            payload: { scope: 'assignment', key: `${body.scope}:${body.key}`, field: 'model', from: previous?.provider ? { provider: previous.provider, model: previous.model } : null, to: body.selection, revision, enforcer: 'runner', configRevision, reduction: false },
          });
        }
        return { scope: body.scope, key: body.key, revision, selection: body.selection, appliesTo: 'next_attempt' as const, state: 'applying' as const, configRevision };
      });
    });
    return reply.code(200).send(result);
  });

  // ---- runs -------------------------------------------------------------------------------------------------
  app.post('/v1/projects/:id/runs', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const projectId = idParam(req);
    const body = parseBody(CreateRunRequestSchema, req.body);
    await requireProject(db, config.tenantId, projectId);
    const at = now();
    const result = await withTx(db, (tx) =>
      idempotent(tx, { tenantId: config.tenantId, projectId, key: `run.create:${body.idempotencyKey}` }, fingerprint(body), async () => {
        await assertRunAllowed(tx, config.tenantId, projectId, { budgetLimitUsd: body.budgetLimitUsd, placement: body.placement });
        const runId = newId('run');
        const budget: Record<string, unknown> = body.budgetLimitUsd !== undefined ? { limitUsd: body.budgetLimitUsd } : {};
        const placement = body.placement === undefined ? null : { mode: body.placement.mode, cloudDestination: body.placement.cloudDestination ?? null };
        const pinnedModel = body.pinnedModel ?? null;
        if (pinnedModel !== null) {
          const refused = await refuseSelection(tx, pinnedModel);
          if (refused) throw refused;
        }
        await tx.insert(schema.runs).values({ tenantId: config.tenantId, projectId, runId, lifecycle: 'planning', budget, placement, trial: body.trial === true, pinnedModel });
        await writeEvent(tx, at, {
          projectId, runId, taskId: runId, aggregateRevision: 1, type: 'run.created',
          actor: { kind: 'human', id: uid },
          payload: {
            title: redactSecrets(body.title),
            ...(body.description !== undefined ? { description: redactSecrets(body.description) } : {}),
            budget: budgetStatus(budget),
            ...(placement ? { placement } : {}),
            ...(pinnedModel !== null ? { pinnedModel } : {}),
          },
        });
        return { runId, budget: budgetStatus(budget) };
      }),
    );
    return reply.code(201).send(result);
  });

  // ---- plan revisions ----------------------------------------------------------------------------------------
  app.post('/v1/runs/:id/plan-revisions', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const body = parseBody(PlanRevisionRequestSchema, req.body);
    const run = await requireRun(db, config.tenantId, idParam(req));
    const projectId = run.projectId;

    const gate = evaluate({ kind: 'assign_replan_tasks' }, ctx.policy);
    if (gate.decision !== 'allow') throw new AppError(403, 'policy_denied', 'policy does not allow planning', { reason: gate.reason, decision: gate.decision });

    const extra: PlanError[] = body.tasks.filter((t) => t.tenantId !== config.tenantId).map((t) => ({ kind: 'scope_mismatch', taskId: t.taskId, field: 'projectId' }));
    // A dependent on a merge could never start: the run cannot reach a pull request while it has an unfinished task, so nothing would ever merge.
    for (const t of body.tasks) for (const d of t.dependencies) if (d.condition === 'change_merged') extra.push({ kind: 'unsupported_dependency_condition', taskId: t.taskId, dependsOn: d.taskId, condition: d.condition });
    const validation = validatePlanRevision({ projectId, runId: run.runId, revision: body.expectedRevision + 1, tasks: body.tasks }, { projectId, runId: run.runId });
    const errors = [...extra, ...(validation.ok ? [] : validation.errors)];
    if (errors.length > 0) throw new AppError(422, 'plan_invalid', 'the proposed plan is not valid', errors);

    // Titles are free text; everything else in a spec is an identifier, hash or limit.
    let tasks: TaskSpec[] = body.tasks.map((t) => TaskSpecSchema.parse({ ...t, title: redactSecrets(t.title), ...(t.description !== undefined ? { description: redactSecrets(t.description) } : {}), ...(t.criteria !== undefined ? { criteria: t.criteria.map((c) => ({ ...c, text: redactSecrets(c.text) })) } : {}) }));
    const at = now();

    // Only a verified task needs its record judged, and the record is read outside the transaction.
    const verified = await db.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, config.tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.status, 'verified'), inArray(schema.taskStatus.taskId, tasks.map((t) => t.taskId))));
    const staleSha = verified.length > 0 ? await staleCandidateOf(projectId, run.runId) : null;
    const runScope = { tenantId: config.tenantId, projectId, runId: run.runId };

    const persist = (tx: Tx, stale: StaleCandidate | null) => async () => {
      const [locked] = await tx.select().from(schema.runs)
        .where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, run.runId))).for('update');
      const current = locked?.planRevision ?? 0;
      if (body.expectedRevision !== current) throw staleRevision(current, 'the plan');
      // The owner narrowed this run's approved paths: a plan cannot bring one back. Refused here, naming the path, rather than blocked later at claim.
      const [narrowed] = await tx.select({ desired: schema.runSettings.desired }).from(schema.runSettings).where(and(eq(schema.runSettings.tenantId, config.tenantId), eq(schema.runSettings.projectId, projectId), eq(schema.runSettings.runId, run.runId), eq(schema.runSettings.field, 'allowed_paths')));
      if (narrowed) {
        const allowed = Array.isArray(narrowed.desired) ? narrowed.desired.filter((p): p is string => typeof p === 'string') : [];
        const offending = tasks.filter((t) => t.allowedPaths.some((p) => !allowed.includes(p)));
        if (offending.length > 0) {
          const paths = [...new Set(offending.flatMap((t) => t.allowedPaths.filter((p) => !allowed.includes(p))))].sort();
          throw new AppError(422, 'path_not_allowed', `This run's approved paths no longer include ${paths.join(', ')}. Give the path back under Bounded autonomy first, or plan the task without it.`, { paths, taskIds: offending.map((t) => t.taskId).sort() });
        }
      }

      // A criterion the plan leaves out would simply leave the denominator: the run could read "4 of 4" while the suite judged eight.
      const settings = ctx.planConfig?.(projectId) ?? await onboardingPlanSettings(tx, config.tenantId, projectId, ctx.policy, config.caps.attemptTimeoutSeconds);
      if (settings?.requiredRequirementIds !== undefined || settings?.rolePaths !== undefined) {
        const replaced = new Set(tasks.map((t) => t.taskId));
        const kept = await tx.select({ taskId: schema.taskStatus.taskId, spec: schema.taskRevisions.spec }).from(schema.taskRevisions).innerJoin(schema.taskStatus, and(eq(schema.taskStatus.tenantId, schema.taskRevisions.tenantId), eq(schema.taskStatus.projectId, schema.taskRevisions.projectId), eq(schema.taskStatus.taskId, schema.taskRevisions.taskId), eq(schema.taskStatus.currentRevision, schema.taskRevisions.revision)))
          .where(and(eq(schema.taskRevisions.tenantId, config.tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.runId, run.runId), sql`${schema.taskStatus.status} NOT IN ('cancelled', 'superseded')`));
        const plan = [...tasks, ...kept.filter((k) => !replaced.has(k.taskId)).map((k) => k.spec as TaskSpec)];
        const carried = new Set(plan.flatMap((t) => t.requirementIds));
        const missing = (settings.requiredRequirementIds ?? []).filter((id) => !carried.has(id));
        if (missing.length > 0) throw new AppError(422, 'criteria_not_covered', `This plan leaves out ${missing.join(', ')}. A run on this project is judged on every criterion.`, { missing });
        const roles = new Set(plan.map((t) => t.role));
        const absent = Object.keys(settings.rolePaths ?? {}).filter((r) => !roles.has(r));
        if (absent.length > 0) throw new AppError(422, 'roles_not_covered', `This plan has no ${absent.join(' or ')} task. This project is built by one worker per role, so each role needs its own task. Draft the plan again from the whole-board brief.`, { missing: absent });
        const crowded = Object.keys(settings.rolePaths ?? {}).filter((r) => plan.filter((t) => t.role === r).length > 1);
        if (crowded.length > 0) throw new AppError(422, 'role_has_many_tasks', `This plan has more than one ${crowded.join(' and ')} task. Each role has one worker with one set of paths: merge them, or cancel the task this one replaces.`, { roles: crowded });
        // Sized here, on the models recorded now: a dearer model fits by shrinking the caps, and every attempt's worst-case hold still fits the budget.
        if (settings.rolePaths !== undefined) {
          const cap = await planCapMicros(tx, { tenantId: config.tenantId, projectId, runId: run.runId, tasks: tasks.map((t) => ({ taskId: t.taskId, role: t.role, attempts: t.limits.maxAttempts })), catalog: ctx.catalog ?? NO_HARNESS_CATALOG, policy: ctx.policy });
          if (cap === 0) throw new AppError(422, 'plan_over_run_budget', 'This run has no budget left for these tasks, once what is already held is counted. What a run holds is not released, so start a new run under the recorded ceiling.');
          if (cap !== null) tasks = tasks.map((t) => ({ ...t, limits: { ...t.limits, maxCostUsd: cap / 1_000_000 } }));
        }
      }

      const existing = new Map<string, { currentRevision: number; status: string; rowRevision: number; projectId: string }>();
      for (const t of tasks) {
        const rows = await tx.select().from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, config.tenantId), eq(schema.taskStatus.taskId, t.taskId))).for('update');
        const row = rows[0];
        if (!row) continue;
        const sameRun = (await loadSpecRow(tx, { tenantId: config.tenantId, projectId: row.projectId, taskId: t.taskId, revision: row.currentRevision }))?.runId === run.runId;
        if (row.projectId !== projectId || !sameRun) throw new AppError(409, 'task_not_replannable', `task ${t.taskId} belongs to another run`, { taskId: t.taskId });
        // A verified task is closed work, unless the record behind it no longer stands: then replanning is one of the ways out.
        if ((!REPLANNABLE.includes(row.status) && !isStalePart(stale, t.taskId, row.status, row.currentRevision)) || t.revision <= row.currentRevision) {
          throw new AppError(409, 'task_not_replannable', `task ${t.taskId} cannot take this revision`, { taskId: t.taskId, status: row.status, currentRevision: row.currentRevision });
        }
        existing.set(t.taskId, row);
      }
      const leaving = [...existing].filter(([taskId, row]) => isStalePart(stale, taskId, row.status, row.currentRevision)).map(([taskId]) => taskId);
      // Pending approvals for a replaced task revision are void; they can no longer be resolved.
      for (const taskId of existing.keys()) await supersedePendingApprovals(tx, config.tenantId, projectId, taskId, at);
      for (const t of tasks) {
        await tx.insert(schema.taskRevisions).values({ tenantId: config.tenantId, projectId, runId: run.runId, taskId: t.taskId, revision: t.revision, boardId: t.boardId, spec: t });
      }
      for (const t of tasks) {
        const prior = existing.get(t.taskId);
        if (prior) {
          await tx.update(schema.taskStatus)
            .set({ currentRevision: t.revision, status: 'planned', placementBlock: null, rowRevision: prior.rowRevision + 1, updatedAt: at })
            .where(and(eq(schema.taskStatus.tenantId, config.tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, t.taskId)));
        } else {
          await tx.insert(schema.taskStatus).values({ tenantId: config.tenantId, projectId, taskId: t.taskId, currentRevision: t.revision, status: 'planned' });
        }
        for (const d of t.dependencies) {
          await tx.insert(schema.dependencies).values({
            tenantId: config.tenantId, projectId, taskId: t.taskId, revision: t.revision,
            dependsOnTaskId: d.taskId, dependsOnRevision: d.revision, condition: d.condition,
          });
        }
      }
      if (stale !== null && leaving.length > 0) await retireStaleCandidate({ now }, tx, runScope, stale, leaving, 'owner_replanned_stale_record');
      const planRevision = current + 1;
      // Accepting the first plan is what starts a run: `planning` becomes `running`, the state readiness and the PR gate require. A later plan keeps the run's lifecycle,
      // except that a run in review leaves it: every task this plan names is `planned` now, unfinished work the review never saw.
      await tx.update(schema.runs).set({ planRevision, lifecycle: sql`CASE WHEN lifecycle = 'planning' THEN 'running' ELSE lifecycle END` })
        .where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, run.runId)));
      // The API accepts the plan; the actor is the control plane acting for the authenticated owner, who is named in the payload.
      await writeEvent(tx, at, {
        projectId, runId: run.runId, taskId: run.runId, aggregateRevision: planRevision, type: 'plan.accepted', actor: SYSTEM_ACTOR,
        payload: { planRevision, taskIds: tasks.map((t) => t.taskId), acceptedFor: uid },
      });
      await leaveReviewForPlan(tx, at, runScope, SYSTEM_ACTOR, planRevision, tasks.map((t) => t.taskId));
      return { planRevision, taskIds: tasks.map((t) => t.taskId) };
    };

    const result = await withTx(db, async (tx) => {
      // The candidate and the scheduler lock come before the run row `persist` takes: the claim poll holds the scheduler lock and a ready task's status row, then takes the run row.
      const stale = await lockBeforeRunRow(tx, runScope, staleSha);
      return body.idempotencyKey === undefined
        ? persist(tx, stale)()
        : idempotent(tx, { tenantId: config.tenantId, projectId, key: `plan.revise:${run.runId}:${body.idempotencyKey}` }, fingerprint(body), persist(tx, stale));
    });
    return reply.code(201).send(result);
  });

  // ---- task commands -----------------------------------------------------------------------------------------
  app.post('/v1/tasks/:id/commands', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const taskId = idParam(req);
    const body = parseBody(TaskCommandRequestSchema, req.body);
    if (body.command === 'pause' || body.command === 'replan') {
      throw new AppError(403, 'command_not_supported', `${body.command} is not available yet`, { command: body.command });
    }
    const at = now();
    // Only a cancel of a verified task needs its record judged, and the record is read outside the transaction.
    const seen = body.command === 'cancel' ? await requireTaskStatus(db, config.tenantId, taskId) : null;
    // Filled in the transaction and acted on only once it has committed: a rollback must not have closed anyone's session.
    let cancelledAttempts: readonly string[] = [];
    const seenRun = seen?.status === 'verified' ? (await loadSpecRow(db, { tenantId: config.tenantId, projectId: seen.projectId, taskId, revision: seen.currentRevision }))?.runId : undefined;
    const staleSha = seen && seenRun ? await staleCandidateOf(seen.projectId, seenRun) : null;
    const result = await withTx(db, async (tx) => {
      const stale = seen && seenRun && staleSha ? await lockStaleCandidate(tx, { tenantId: config.tenantId, projectId: seen.projectId, runId: seenRun }, staleSha) : null;
      const row = await requireTaskStatus(tx, config.tenantId, taskId, true);
      const key = { tenantId: config.tenantId, projectId: row.projectId, taskId };
      return idempotent(tx, { tenantId: config.tenantId, projectId: row.projectId, key: `task.command:${taskId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        if (body.expectedRevision !== row.rowRevision) throw staleRevision(row.rowRevision, 'the task');
        const specRow = await loadSpecRow(tx, { ...key, revision: row.currentRevision });
        if (!specRow) throw new AppError(404, 'task_not_found', 'task revision is missing');
        const operationId = newId('op');
        const scope = { projectId: row.projectId, runId: specRow.runId, taskId };

        if (body.command === 'cancel') {
          if (CANCEL_REQUEST.includes(row.status)) {
            const pending = await tx.select().from(schema.taskCommands).where(and(
              eq(schema.taskCommands.tenantId, config.tenantId), eq(schema.taskCommands.projectId, row.projectId),
              eq(schema.taskCommands.taskId, taskId), eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'),
              eq(schema.taskCommands.revision, row.currentRevision)));
            if (pending[0]) {
              // A stop the owner caused by narrowing a grant would leave the task blocked by policy. Asked to cancel now, it is a cancel: the task ends cancelled.
              // A handover's stop, asked to cancel now, is a cancel: the task ends cancelled, and the handover is closed rather than left waiting for a successor.
              if (isHandoverReason(pending[0].detail['reason'] as string | null)) {
                await tx.update(schema.taskCommands).set({ detail: { ...pending[0].detail, reason: 'cancel_requested', handoverOf: pending[0].detail['reason'] } }).where(and(eq(schema.taskCommands.tenantId, config.tenantId), eq(schema.taskCommands.projectId, row.projectId), eq(schema.taskCommands.operationId, pending[0].operationId)));
                await tx.update(schema.checkpoints).set({ state: 'closed', updatedAt: at }).where(and(eq(schema.checkpoints.tenantId, config.tenantId), eq(schema.checkpoints.projectId, row.projectId), eq(schema.checkpoints.taskId, taskId), eq(schema.checkpoints.state, 'stopping')));
              }
              if (typeof pending[0].detail['reason'] === 'string' && pending[0].detail['reason'].startsWith('policy_revoked:')) {
                await tx.update(schema.taskCommands).set({ detail: { ...pending[0].detail, reason: 'cancel_requested', narrowedBy: pending[0].detail['reason'] } }).where(and(eq(schema.taskCommands.tenantId, config.tenantId), eq(schema.taskCommands.projectId, row.projectId), eq(schema.taskCommands.operationId, pending[0].operationId)));
              }
              return { operationId: pending[0].operationId, command: 'cancel' as const, state: 'cancel_requested' as const, taskStatus: row.status };
            }
            const open = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts).where(and(
              eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, row.projectId), eq(schema.attempts.taskId, taskId), isNull(schema.attempts.endedAt)));
            await tx.insert(schema.taskCommands).values({
              tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
              command: 'cancel', state: 'cancel_requested', requestedBy: uid, requestedAt: at,
              detail: { attemptIds: open.map((a) => a.attemptId) },
            });
            // The status is unchanged, but clients following snapshot + cursor must learn of the request: bump the aggregate revision and record it.
            const rev = await bumpStatus(tx, key, row.rowRevision, row.status, at);
            await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancel_requested', actor: { kind: 'human', id: uid }, payload: { operationId, attemptIds: open.map((a) => a.attemptId) } });
            cancelledAttempts = open.map((a) => a.attemptId);
            return { operationId, command: 'cancel' as const, state: 'cancel_requested' as const, taskStatus: row.status };
          }
          // A verified task is closed work, unless the record behind it no longer stands: then cancelling is one of the ways out.
          const staleExit = isStalePart(stale, taskId, row.status, row.currentRevision);
          if (!IMMEDIATE_CANCEL.includes(row.status) && !staleExit) {
            throw new AppError(403, 'command_not_allowed', `cannot cancel a task that is ${row.status}`, { status: row.status });
          }
          // Retiring a stale candidate touches its other parts: their status rows come before the claim lock the release below takes.
          if (staleExit) await lockPartsForClaims(tx, { tenantId: config.tenantId, projectId: row.projectId }, stale!.parts.map((p) => p.taskId));
          const rev = await bumpStatus(tx, key, row.rowRevision, 'cancelled', at);
          await supersedePendingApprovals(tx, config.tenantId, row.projectId, taskId, at);
          // A handover waiting for its successor or the owner's choice ends with the task.
          await tx.update(schema.checkpoints).set({ state: 'closed', updatedAt: at }).where(and(eq(schema.checkpoints.tenantId, config.tenantId), eq(schema.checkpoints.projectId, row.projectId), eq(schema.checkpoints.taskId, taskId), inArray(schema.checkpoints.state, [...OPEN_HANDOVER_STATES])));
          // A verifying task still holds the claims of its completed attempt; cancelling is the verification's end.
          await releaseTaskClaims(tx, { tenantId: config.tenantId, projectId: row.projectId, taskId }, row.currentRevision, at);
          await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancelled', actor: { kind: 'human', id: uid }, payload: { operationId } });
          if (staleExit) await retireStaleCandidate({ now }, tx, { tenantId: config.tenantId, projectId: row.projectId, runId: specRow.runId }, stale!, [taskId], 'owner_cancelled_stale_record');
          // Nothing is left to reap, so any request still open for this revision is closed with it.
          await tx.update(schema.taskCommands).set({ state: 'cancelled' }).where(and(
            eq(schema.taskCommands.tenantId, config.tenantId), eq(schema.taskCommands.projectId, row.projectId), eq(schema.taskCommands.taskId, taskId),
            eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'), eq(schema.taskCommands.revision, row.currentRevision)));
          await tx.insert(schema.taskCommands).values({
            tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
            command: 'cancel', state: 'applied', requestedBy: uid, requestedAt: at,
          });
          return { operationId, command: 'cancel' as const, state: 'applied' as const, taskStatus: 'cancelled' };
        }

        // retry
        const gate = evaluate({ kind: 'assign_replan_tasks' }, ctx.policy);
        if (gate.decision !== 'allow') throw new AppError(403, 'policy_denied', 'policy does not allow retrying', { reason: gate.reason, decision: gate.decision });
        // The scheduler owns the transition and emits `task.ready` under its own actor; we only say who asked.
        const retried = await ctx.scheduler.retry(key, uid, operationId, tx);
        if (!retried.ok && retried.error.reason === 'cancel_requested') throw new AppError(403, 'cancel_pending', 'a cancel request is open for this task; retry is refused until it resolves', { status: row.status });
        if (!retried.ok) throw new AppError(403, 'command_not_allowed', retried.error.reason, { status: row.status, attemptsUsed: retried.error.attemptsUsed });
        await tx.insert(schema.taskCommands).values({
          tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
          command: 'retry', state: 'applied', requestedBy: uid, requestedAt: at,
        });
        return { operationId, command: 'retry' as const, state: 'applied' as const, taskStatus: retried.value.taskStatus };
      });
    });
    // A cancel means the worker is stopping, so no one should be typing into it.
    for (const attemptId of cancelledAttempts) ctx.control.endForAttempt(attemptId, 'attempt_fenced');
    return reply.code(202).send(result);
  });

  // ---- client-reported metadata (untrusted) -------------------------------------------------------------------
  app.post('/v1/tasks/:id/client-reports', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const body = parseBody(ClientInferenceReportSchema, req.body);
    const row = await requireTaskStatus(db, config.tenantId, idParam(req));
    const reportId = newId('rpt');
    await db.insert(schema.clientReports).values({
      tenantId: config.tenantId, projectId: row.projectId, reportId, subjectKind: 'task', subjectId: row.taskId, kind: body.kind,
      trust: 'untrusted',
      payload: { mode: body.mode, observedSource: body.observedSource, ...(body.model !== undefined ? { model: redactSecrets(body.model) } : {}) },
      reportedBy: uid,
    });
    return reply.code(201).send({ reportId, trust: 'untrusted' });
  });

  // ---- approvals ---------------------------------------------------------------------------------------------
  app.post('/v1/approvals/:id/resolve', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const approvalId = idParam(req);
    const body = parseBody(ApprovalResolveRequestSchema, req.body);
    const at = now();
    const result = await withTx(db, async (tx) => {
      // Lock order is task status, then approval row, the same as the plan route and the scheduler. Read first, unlocked, to learn the task.
      const lookup = () => tx.select().from(schema.approvals).where(and(eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.approvalId, approvalId)));
      const seen = await lookup();
      if (seen.length === 0) throw new AppError(404, 'approval_not_found', 'no such approval');
      if (seen.length > 1) throw new AppError(409, 'ambiguous_id', 'the id exists in more than one project');
      const task = seen[0]!.taskId ? await requireTaskStatus(tx, config.tenantId, seen[0]!.taskId, true) : null;
      const found = await lookup().for('update');
      if (found.length === 0) throw new AppError(404, 'approval_not_found', 'no such approval');
      const approval = found[0]!;
      return idempotent(tx, { tenantId: config.tenantId, projectId: approval.projectId, key: `approval.resolve:${approvalId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        // An expired request is never a grant, but the owner may still record a denial for it.
        const expired = approval.outcome === 'expired' || (approval.outcome === 'pending' && approval.expiresAt !== null && approval.expiresAt.getTime() <= at.getTime());
        if (approval.outcome !== 'pending' && approval.outcome !== 'expired') throw new AppError(409, 'approval_already_resolved', 'this approval already has an outcome', { outcome: approval.outcome });
        if (expired && body.decision === 'grant') throw new AppError(409, 'approval_expired', 'this approval has expired');
        if (approval.scopeHash !== body.scopeHash) throw new AppError(409, 'scope_mismatch', 'the scope hash does not match the approval');
        if (!approval.runId) throw new AppError(422, 'invalid_request', 'approval is not run-scoped');

        // An approval is for one exact revision. A decision about revision 1 can never release revision 2.
        if (task && approval.revision !== task.currentRevision) {
          throw new AppError(409, 'stale_revision', 'the approval is for a different task revision', { approvalRevision: approval.revision, currentRevision: task.currentRevision });
        }
        // The request's task must still be waiting on this decision; anything else (cancelled, replanned away) cannot be released by it.
        if (task && task.status !== 'awaiting_approval' && approval.outcome !== 'expired') {
          throw new AppError(409, 'stale_revision', 'the task is no longer waiting on this approval', { status: task.status });
        }
        await checkExpectedRevisions(tx, approval.expectedRevisions, approval.projectId, approval.runId, config.tenantId);
        const expected = task ? task.rowRevision : 0;
        if (body.expectedRevision !== expected) throw staleRevision(expected, 'the approval target');

        // Policy may have changed since the request, so a grant cannot outrun a deny. A stored parameterless operation is re-judged here; the scheduler
        // re-judges cloud starts and repairs at claim. A row that names no operation cannot be judged, so it cannot be granted.
        const operation = approval.detail['operation'];
        if (body.decision === 'grant') {
          if (typeof operation !== 'string') throw new AppError(403, 'policy_denied', 'this approval names no operation', { reason: 'approval_operation_missing' });
          if (operation !== 'start_cloud_worker' && operation !== 'repair_within_limits') {
            const current = evaluate({ kind: operation, actor: 'agent' } as unknown as Operation, ctx.policy);
            if (current.decision !== 'require_approval') throw new AppError(403, 'policy_denied', 'policy no longer allows granting this', { reason: current.reason, decision: current.decision });
          }
        }

        const granted = body.decision === 'grant';
        await tx.update(schema.approvals).set({ outcome: granted ? 'granted' : 'denied', approver: uid, resolvedAt: at })
          .where(and(eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.projectId, approval.projectId), eq(schema.approvals.approvalId, approvalId)));

        let taskStatus: string | null = task?.status ?? null;
        let revision = expected;
        if (task && task.status === 'awaiting_approval') {
          const specRow = await loadSpecRow(tx, { tenantId: config.tenantId, projectId: task.projectId, taskId: task.taskId, revision: task.currentRevision });
          const spec = TaskSpecSchema.safeParse(specRow?.spec);
          const init = spec.success ? newTaskStateFromSpec(spec.data, 'repository') : null;
          if (!init?.ok) throw new AppError(422, 'invalid_request', 'task spec is invalid');
          const moved = transition({ ...init.value, status: 'awaiting_approval' }, { type: granted ? 'approval_granted' : 'approval_denied' });
          if (!moved.ok) throw new AppError(403, 'command_not_allowed', moved.error.reason);
          revision = await bumpStatus(tx, { tenantId: config.tenantId, projectId: task.projectId, taskId: task.taskId }, task.rowRevision, moved.value.status, at);
          taskStatus = moved.value.status;
        }
        await writeEvent(tx, at, {
          projectId: approval.projectId, runId: approval.runId, taskId: approval.taskId ?? approval.runId, aggregateRevision: revision,
          type: granted ? 'approval.granted' : 'approval.denied', actor: { kind: 'human', id: uid },
          payload: { approvalId, scopeHash: approval.scopeHash, actionHash: approval.actionHash },
        });
        return { approvalId, outcome: granted ? 'granted' : 'denied', taskStatus };
      });
    });
    return reply.code(200).send(result);
  });

  // ---- budget-stopped runs -----------------------------------------------------------------------------------
  /**
   * Records the owner accepting a budget-stopped run at reduced scope. It changes no task and verifies nothing: stopped tasks stay `cancelled`,
   * and their criteria stay listed as not delivered in the decision, the event and the snapshot.
   */
  app.post('/v1/runs/:id/accept-reduced-scope', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const body = parseBody(AcceptReducedScopeRequestSchema, req.body);
    const runId = idParam(req);
    const at = now();
    const result = await withTx(db, async (tx) => {
      const run = await requireRun(tx, config.tenantId, runId, true);
      return idempotent(tx, { tenantId: config.tenantId, projectId: run.projectId, key: `run.accept_reduced_scope:${runId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        const planRevision = run.planRevision ?? 0;
        if (body.expectedPlanRevision !== planRevision) throw staleRevision(planRevision, 'the plan');
        const scope = { tenantId: config.tenantId, projectId: run.projectId, runId };
        const assessed = await assessRunScope(tx, scope);
        if (assessed.stopped.length === 0) throw new AppError(403, 'command_not_allowed', 'this run has no budget-stopped work to accept', { reason: 'not_budget_stopped' });
        // A stop still in flight is not yet the final reduced scope.
        if (assessed.stopping.length > 0) throw new AppError(403, 'cancel_pending', 'a budget stop is still in progress', { taskIds: assessed.stopping });
        if (acceptanceCovers(await loadAcceptedReducedScope(tx, scope), assessed.stopped)) throw new AppError(403, 'command_not_allowed', 'reduced scope was already accepted for this run', { reason: 'already_accepted' });

        const { notDelivered, deliveredRequirementIds } = assessed;
        // The list the owner read must still be the list that is true now. A stop landing after the render changes it, and the owner has to look again.
        const currentHash = notDeliveredHash(notDelivered);
        if (body.notDeliveredHash !== currentHash) throw new AppError(409, 'reduced_scope_changed', 'what was not delivered changed since it was shown', { currentHash });
        const decisionId = newId('dec');
        const note = body.note === undefined ? null : redactSecrets(body.note);
        const accepted: AcceptedReducedScope = { decisionId, runId, planRevision, notDelivered, deliveredRequirementIds, acceptedAt: at.toISOString(), acceptedBy: uid };
        await tx.insert(schema.decisions).values({
          tenantId: config.tenantId, projectId: run.projectId, decisionId, context: reducedScopeContext(runId), options: [], rationale: note ?? 'Accepted the run at reduced scope after a budget stop.', author: uid, affected: [accepted],
        });
        await writeEvent(tx, at, { projectId: run.projectId, runId, taskId: runId, aggregateRevision: planRevision, type: 'run.reduced_scope_accepted', actor: { kind: 'human', id: uid }, payload: { decisionId, notDelivered, deliveredRequirementIds, ...(note !== null ? { note } : {}) } });
        return accepted;
      });
    });
    return reply.code(201).send(result);
  });

  // ---- re-verification ---------------------------------------------------------------------------------------
  /**
   * Sends finished work back for a verdict: work blocked by a verifier or assembly failure, and a current candidate whose record no longer stands. No worker runs; the assembly and
   * verification drivers do the rest. Task status during a stale-record re-verify: `verifying` until a new valid record is applied (see `reopenStaleVerification`).
   */
  app.post('/v1/runs/:id/reverify', auth, async (req, reply) => {
    const uid = ownerOf(req);
    const body = parseBody(ReverifyRunRequestSchema, req.body);
    const runId = idParam(req);
    const seen = await requireRun(db, config.tenantId, runId);
    // The same gate as retry: re-verifying is work sent back to the drivers, so a policy that withholds replanning withholds it.
    const gate = evaluate({ kind: 'assign_replan_tasks' }, ctx.policy);
    if (gate.decision !== 'allow') throw new AppError(403, 'policy_denied', 'policy does not allow re-verifying', { reason: gate.reason, decision: gate.decision });
    const staleSha = await staleCandidateOf(seen.projectId, runId);
    const trusted = ctx.evidence?.trusted() ?? null;
    // A failed rebuild can be sent back only because main has moved since its verdict. A tip that cannot be read cannot say so.
    const [latestCandidate] = await db.execute(sql`SELECT c.status, c.base_sha, c.target, p.repository FROM candidates c JOIN projects p ON p.tenant_id = c.tenant_id AND p.project_id = c.project_id WHERE c.tenant_id = ${config.tenantId} AND c.project_id = ${seen.projectId} AND c.run_id = ${runId} AND c.sha IS NOT NULL AND c.status IN ('assembled', 'rejected') ORDER BY c.created_at DESC, c.candidate_id DESC LIMIT 1`);
    const tip = latestCandidate?.['status'] === 'rejected' && ctx.tipOf ? await ctx.tipOf({ repository: String(latestCandidate['repository']), target: String(latestCandidate['target']) }).catch(() => null) : null;
    const baseMoved = tip !== null && tip !== latestCandidate!['base_sha'];
    const scope = { tenantId: config.tenantId, projectId: seen.projectId, runId };
    const result = await withTx(db, async (tx) => {
      // The candidate and the scheduler lock come before the run row: the claim poll and a stale replan take them first and the run row after.
      await lockBeforeRunRow(tx, scope, staleSha);
      const run = await requireRun(tx, config.tenantId, runId, true);
      return idempotent(tx, { tenantId: config.tenantId, projectId: run.projectId, key: `run.reverify:${runId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        if (body.expectedPlanRevision !== (run.planRevision ?? 0)) throw staleRevision(run.planRevision ?? 0, 'the plan');
        const outcome: ReverifyOutcome = await reverifyRun({ now }, tx, scope, { requestedBy: uid, staleSha, trusted, baseMoved, operationId: () => newId('op') });
        if (!outcome.ok) throw new AppError(outcome.reason === 'resource_conflict' ? 409 : 403, 'command_not_allowed', 'this run cannot be re-verified', { reason: outcome.reason, ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}) });
        return { runId, reopened: outcome.reopened };
      });
    });
    return reply.code(200).send(result);
  });

  // ---- verification failures ---------------------------------------------------------------------------------
  /** Why a run's criteria failed, in the verifier's words. Candidate code influences those words, so they are redacted and bounded here and only ever rendered as text. */
  app.get('/v1/projects/:id/runs/:runId/failures', auth, async (req) => {
    const projectId = idParam(req);
    const runId = (req.params as { runId: string }).runId;
    await requireProject(db, config.tenantId, projectId);
    const [run] = await db.select({ runId: schema.runs.runId }).from(schema.runs).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, runId)));
    if (!run) throw new AppError(404, 'run_not_found', 'no such run in this project');
    const [candidate] = await db.execute(sql`
      SELECT sha FROM candidates WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND sha IS NOT NULL AND status IN ('assembled', 'rejected')
      ORDER BY created_at DESC, candidate_id DESC LIMIT 1`);
    const sha = candidate ? String(candidate['sha']) : null;
    const record = sha !== null ? await ctx.evidence?.loadRecord({ tenantId: config.tenantId, projectId, sha }) : null;
    if (!record) return { candidateSha: sha, available: false, failures: [] };
    return {
      candidateSha: sha, available: true,
      failures: record.results.flatMap((r) => r.failures.map((f) => ({ criterionId: r.checkId, test: failureText(f.test), status: f.status, message: failureText(f.message) }))).slice(0, FAILURE_LIMIT),
    };
  });

  // ---- snapshot ----------------------------------------------------------------------------------------------
  app.get('/v1/projects/:id/snapshot', auth, async (req) => {
    const projectId = idParam(req);
    await requireProject(db, config.tenantId, projectId);
    const at = now();
    // One snapshot-isolated read: the cursor and every row below belong to the same instant.
    return db.transaction(
      async (tx) => {
        const seq = await tx.execute(sql`SELECT last_sequence FROM project_sequences WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId}`);
        const cursor = Number(seq[0]?.['last_sequence'] ?? 0);
        const scope = (t: { tenantId: unknown; projectId: unknown }) => and(eq(t.tenantId as never, config.tenantId), eq(t.projectId as never, projectId));

        const runs = await tx.select().from(schema.runs).where(scope(schema.runs)).orderBy(asc(schema.runs.createdAt));
        const statuses = await tx.select().from(schema.taskStatus).where(scope(schema.taskStatus)).orderBy(asc(schema.taskStatus.taskId));
        const revisions = await tx.select().from(schema.taskRevisions).where(scope(schema.taskRevisions));
        const attempts = await tx.select({
          attemptId: schema.attempts.attemptId, taskId: schema.attempts.taskId, revision: schema.attempts.revision, attemptNumber: schema.attempts.attemptNumber, humanIntervenedAt: schema.attempts.humanIntervenedAt,
          runner: schema.attempts.runner, leaseFence: schema.attempts.leaseFence, lastHeartbeatAt: schema.attempts.lastHeartbeatAt,
          leaseExpiresAt: schema.attempts.leaseExpiresAt, deadlineAt: schema.attempts.deadlineAt, outcome: schema.attempts.outcome,
          exitReason: schema.attempts.exitReason, startedAt: schema.attempts.startedAt, endedAt: schema.attempts.endedAt,
          lastTool: schema.attempts.lastTool, lastToolAt: schema.attempts.lastToolAt,
          // Decided at claim. Anything but a clear yes is restricted, and its reasons are read through `restrictedStoredReason`.
          streamable: sql<boolean>`coalesce(${schema.attempts.detail} ->> 'terminalStreamable' = 'true', false)`,
          modelRoute: schema.attempts.modelRoute, modelProvider: schema.attempts.modelProvider, modelId: schema.attempts.modelId, assignmentSource: schema.attempts.assignmentSource,
        }).from(schema.attempts).where(scope(schema.attempts)).orderBy(asc(schema.attempts.attemptNumber));
        const commands = await tx.select().from(schema.taskCommands).where(scope(schema.taskCommands)).orderBy(desc(schema.taskCommands.requestedAt));
        const approvals = await tx.select().from(schema.approvals).where(and(scope(schema.approvals), inArray(schema.approvals.outcome, ['pending', 'expired'])));
        // Bounded and project-scoped. Resolved rows are for the record: only the open ones above can still be acted on.
        const resolved = await tx.select().from(schema.approvals)
          .where(and(scope(schema.approvals), inArray(schema.approvals.outcome, ['granted', 'denied', 'expired', 'superseded'])))
          .orderBy(sql`${schema.approvals.resolvedAt} DESC NULLS LAST`, desc(schema.approvals.createdAt)).limit(APPROVAL_HISTORY_LIMIT);
        const reports = await tx.select().from(schema.clientReports).where(scope(schema.clientReports)).orderBy(desc(schema.clientReports.createdAt)).limit(50);
        const changes = await tx.select().from(schema.changeRequests).where(scope(schema.changeRequests));
        // A rebuild for a moved main retires the pull request's candidate first, so this is true from the moment the rebuild starts. Read from candidates, not the evidence report: a run with no requirement ids has none.
        const retiredForMain = await tx.execute(sql`SELECT run_id, sha, updated_at FROM candidates WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND status = 'invalidated' AND reason = 'base_changed' AND sha IS NOT NULL`);
        const candidateRows = await tx.execute(sql`SELECT run_id, sha, status, updated_at, detail -> 'rebuildDeferred' AS deferred, detail -> 'retryRefused' AS retry_refused FROM candidates WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND status IN ('assembled', 'rejected', 'failed', 'conflicted')`);
        const whenOf = (v: unknown): number => new Date(v as string | Date).getTime();
        // What each open pull request's candidate is now, and when each run last took a plan: an open pull request on anything but the run's live candidate is out of date.
        const prCandidates = await tx.execute(sql`SELECT run_id, sha, status, parts, updated_at FROM candidates WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND sha IN (SELECT candidate_sha FROM change_requests WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND status = 'open')`);
        const planAccepted = await tx.execute(sql`SELECT DISTINCT ON (run_id) run_id, occurred_at FROM events WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type = 'plan.accepted' ORDER BY run_id, sequence DESC`);
        /** How the rebuild that left this pull request behind is going. A failed or conflicted one is said as such; only a run actually building says it is. */
        const rebuildState = (runId: string, retiredAt: unknown, liveSha: string | null): 'building' | 'verifying' | 'verified' | 'failed' | 'conflicted' => {
          if (liveSha !== null) return runs.find((r) => r.runId === runId)?.lifecycle === 'ready_for_review' ? 'verified' : 'verifying';
          const after = candidateRows.filter((c) => c['run_id'] === runId && c['status'] !== 'assembled' && whenOf(c['updated_at']) >= whenOf(retiredAt)).sort((x, y) => whenOf(y['updated_at']) - whenOf(x['updated_at']))[0];
          return !after ? 'building' : after['status'] === 'conflicted' ? 'conflicted' : 'failed';
        };
        const reducedScopes = (await tx.select().from(schema.decisions).where(scope(schema.decisions))).filter((d) => d.context.startsWith(reducedScopeContext('')));
        // Why each blocked task stopped: the latest blocking event names it. Statuses alone can't say.
        const blockEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, type, payload, attempt_id FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ('task.blocked', 'task.reopened', 'approval.denied')
          ORDER BY task_id, sequence DESC`);
        // A restricted attempt's block reason is read through the same rule as its exit reason: rows from before the closed list may hold a runner's sentence.
        const restrictedIds = new Set(attempts.filter((a) => !a.streamable).map((a) => a.attemptId));
        for (const b of blockEvents) if (typeof b['attempt_id'] === 'string' && restrictedIds.has(b['attempt_id'])) b['payload'] = restrictedStoredPayload(b['payload'] as Record<string, unknown>);
        // An approval's reason is read the same way when the attempt that asked for it is restricted: rows from before T7.4a hold the agent's own words. The request event names
        // that attempt; one whose attempt is not on record counts as restricted.
        const streamableIds = new Set(attempts.filter((a) => a.streamable).map((a) => a.attemptId));
        const askedBy = new Map((await tx.execute(sql`SELECT payload ->> 'approvalId' AS approval_id, attempt_id FROM events WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type = 'approval.requested' AND attempt_id IS NOT NULL`))
          .map((r) => [String(r['approval_id']), String(r['attempt_id'])] as const));
        const approvalReason = (a: { approvalId: string; detail: Record<string, unknown> }): string | null => {
          const reason = typeof a.detail['reason'] === 'string' ? a.detail['reason'] : null;
          const by = askedBy.get(a.approvalId);
          return reason !== null && by !== undefined && !streamableIds.has(by) ? restrictedStoredReason(reason) : reason;
        };

        // The status a task is in now came with its latest status event; a row bumped for any other reason keeps its time.
        const statusEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, occurred_at FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ${sql.raw(`(${STATUS_EVENTS.map((t) => `'${t}'`).join(',')})`)}
          ORDER BY task_id, sequence DESC`);
        // The latest event of the kinds a reader treats as evidence, per task or run. Each carries its id and type: a reference to the fact, never its content.
        const evidenceEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, type, event_id, occurred_at FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ${sql.raw(`(${[...new Set([...TASK_EVIDENCE_EVENTS, ...RUN_EVIDENCE_EVENTS])].map((t) => `'${t}'`).join(',')})`)}
          ORDER BY task_id, sequence DESC`);
        // The latest verdict per task, under the same check id the reducer folds from the event, so a resync keeps the check it had.
        const checkEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, run_id, type, event_id, occurred_at, payload FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ('verification.started', 'verification.passed', 'verification.failed', 'candidate.failed')
          ORDER BY task_id, sequence DESC`);
        const runners = await tx.select({ runnerId: schema.runners.runnerId, location: schema.runners.location, label: schema.runners.label, lastSeenAt: schema.runners.lastSeenAt }).from(schema.runners)
          .where(and(eq(schema.runners.tenantId, config.tenantId), isNull(schema.runners.revokedAt))).orderBy(asc(schema.runners.createdAt));
        const usage = (await Promise.all(runs.map((r) => readUsageEntries(tx, { tenantId: config.tenantId, projectId, runId: r.runId })))).flat();
        const settingsView = await loadSettingsView(tx, config.tenantId, projectId, at);
        const assignmentRows = await tx.select({ scopeKind: schema.modelAssignments.scopeKind, scopeKey: schema.modelAssignments.scopeKey, revision: schema.modelAssignments.revision, configRevision: schema.modelAssignments.configRevision, appliedAt: schema.modelAssignments.appliedAt }).from(schema.modelAssignments).where(scope(schema.modelAssignments));
        const ceiling = await recordedBudgetCeiling(tx, config.tenantId, projectId);
        const pathsOf = (runId: string): string[] => [...new Set(statuses.flatMap((st) => {
          const row = revisions.find((r) => r.taskId === st.taskId && r.revision === st.currentRevision);
          const paths = (row?.spec as { allowedPaths?: unknown } | undefined)?.allowedPaths;
          return row?.runId === runId && Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
        }))].sort();

        const specOf = (taskId: string, revision: number) => revisions.find((r) => r.taskId === taskId && r.revision === revision);
        // Derived on read, never recorded: tasks waiting for a runner that can deliver their knowledge packs.
        const skillWaits = await skillRunnerWaits(tx, config.tenantId, projectId, statuses.map((s) => ({ taskId: s.taskId, status: s.status, spec: specOf(s.taskId, s.currentRevision)?.spec })), at);
        // What a budget stop left undelivered, so the owner can read it before accepting. A spec that no longer parses leaves it null: unknown, never empty.
        const assessments = new Map<string, { notDelivered: unknown; notDeliveredHash: string; deliveredRequirementIds: readonly string[]; stopped: readonly unknown[]; stoppingTaskIds: readonly string[] } | null>();
        const evidence = new Map<string, Awaited<ReturnType<typeof loadRunEvidence>>>();
        // Every run still in play is in the window, so a live run cannot fall out of it, plus the latest finished ones.
        for (const r of runs.filter((r, i) => !TERMINAL_RUN.includes(r.lifecycle) || i >= runs.length - SNAPSHOT_EVIDENCE_RUNS)) {
          const assessed = await assessRunScope(tx, { tenantId: config.tenantId, projectId, runId: r.runId }).catch(() => null);
          assessments.set(r.runId, assessed && assessed.stopped.length + assessed.stopping.length > 0
            ? { notDelivered: assessed.notDelivered, notDeliveredHash: notDeliveredHash(assessed.notDelivered), deliveredRequirementIds: assessed.deliveredRequirementIds, stopped: assessed.stopped, stoppingTaskIds: assessed.stopping }
            : null);
          // Per-requirement, from the verifier's own check rows. A task count never stands in for a criterion: no requirement ids means null, not a number.
          evidence.set(r.runId, await loadRunEvidence(tx, { tenantId: config.tenantId, projectId, runId: r.runId }, statuses.flatMap((s) => {
            const row = specOf(s.taskId, s.currentRevision);
            if (row?.runId !== r.runId) return [];
            const requirementIds = (row.spec as { requirementIds?: unknown }).requirementIds;
            return [{ taskId: s.taskId, revision: s.currentRevision, status: s.status, requirementIds: Array.isArray(requirementIds) ? requirementIds.filter((x): x is string => typeof x === 'string') : [] }];
          }), ctx.evidence ? { trusted: ctx.evidence.trusted(), artifacts: ctx.evidence.artifacts } : null).catch(() => null));
        }
        const refOf = (row: Record<string, unknown> | undefined) => (row ? { kind: String(row['type']), ref: String(row['event_id']), at: eventTime(row) } : null);
        return {
          projectId,
          cursor,
          generatedAt: at.toISOString(),
          /** What this machine's harness adapters declare, and what policy says about each model. Identifiers only. */
          modelCatalog: catalogView(await liveCatalog(tx), ctx.policy),
          /** Scheduler limits, so a screen can state the slot limit rather than saying it was not reported. */
          limits: { maxConcurrentTotal: config.caps.maxConcurrentTotal },
          /** Enrolled, unrevoked runners with when each last called in. Never a token. */
          runners: runners.map((r) => ({ runnerId: r.runnerId, location: r.location, label: r.label ?? null, lastSeenAt: r.lastSeenAt?.toISOString() ?? null })),
          /** The latest verdict per task. A failed candidate, addressed to the run, is a run-level check. */
          checks: checkEvents.map((c) => {
            const failedCandidate = c['type'] === 'candidate.failed';
            const taskId = String(c['task_id']);
            const payload = c['payload'] as Record<string, unknown>;
            const runLevel = failedCandidate && taskId === c['run_id'];
            const summary = typeof payload['summary'] === 'string' ? payload['summary'] : typeof payload['reason'] === 'string' ? payload['reason'] : null;
            const checkId = failedCandidate ? `candidate:${taskId}` : (typeof payload['checkId'] === 'string' ? payload['checkId'] : `${taskId}:verification`);
            return { checkId, taskId: runLevel ? null : taskId, state: c['type'] === 'verification.started' ? 'running' : c['type'] === 'verification.passed' ? 'passed' : 'failed', summary, updatedAt: eventTime(c), evidenceRef: String(c['event_id']) };
          }),
          /** The ledger's current figures. Unknown stays null; nothing is summed here. */
          usage: usage.map((u) => ({ entryId: u.entryId, runId: u.runId, taskId: u.taskId, attemptId: u.attemptId, metric: u.metric, quantity: u.quantity, provenance: u.provenance, source: u.source })),
          /** The current assignment per role and task; each carries the revision a change must send back. */
          modelAssignments: (await loadModelAssignments(tx, config.tenantId, projectId)).map((a) => {
            const row = assignmentRows.find((r) => r.scopeKind === a.scope && r.scopeKey === a.key && r.revision === a.revision);
            /** Whether the runners have acknowledged it: `applying` until every recent runner has, `waiting_for_runner` with none connected. */
            const pending = row ? assignmentState(row, settingsView.everyone) : { state: 'applied' as const };
            return { ...a, state: pending.state, ...(pending.waitingOn ? { waitingOn: [...pending.waitingOn] } : {}) };
          }),
          /** Every run and worker setting the owner saved, with what is in force and whether its enforcer has acknowledged it. Closed values only. */
          settings: settingsView.settings,
          runs: runs.map((r) => ({
            runId: r.runId, lifecycle: r.lifecycle, requestRevision: r.requestRevision, planRevision: r.planRevision ?? 0, budget: budgetStatus(r.budget), placement: r.placement ?? null, pinnedModel: r.pinnedModel ?? null,
            latestEvidence: refOf(evidenceEvents.find((e) => e['task_id'] === r.runId && (RUN_EVIDENCE_EVENTS as readonly unknown[]).includes(e['type']))),
            /** Criteria with qualifying evidence at this run's current revision. Null: no task names a requirement, so per-criterion evidence does not exist. */
            criteria: evidence.get(r.runId)?.criteria ?? null,
            evidence: evidence.get(r.runId)?.evidence ?? null,
            /** Set once the owner accepted a budget stop. `notDelivered` lists what was stopped and is never counted as verified. */
            reducedScope: reducedScopes.filter((d) => d.context === reducedScopeContext(r.runId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.affected[0] ?? null,
            /** Where the run stands after a budget stop, before anyone has accepted it. Null when nothing was stopped, or it cannot be read. */
            scopeAssessment: assessments.get(r.runId) ?? null,
            /** Every attempt of this run a person opened a shell in. All revisions: replanning a task does not erase that a person was in its sandbox. */
            /** A failed rebuild could not retry by itself after main moved again, so the owner may send it back. */
            failedRebuildMainMoved: candidateRows.filter((c) => c['run_id'] === r.runId && c['status'] === 'rejected').sort((x, y) => whenOf(y['updated_at']) - whenOf(x['updated_at']))[0]?.['retry_refused'] != null,
            /** Main moved, but rebuilding now would have to take a claim another task holds: nothing was touched, and the rebuild runs when it is free. */
            rebuildDeferred: (() => {
              const d = candidateRows.find((c) => c['run_id'] === r.runId && c['status'] === 'assembled')?.['deferred'] as { message?: unknown; at?: unknown } | null | undefined;
              return d && typeof d.message === 'string' && typeof d.at === 'string' ? { message: d.message, at: d.at } : null;
            })(),
            /** Set once the owner asked to cancel the run; `lifecycle` becomes `cancelled` when every active attempt has ended or its lease expired. */
            cancel: r.cancelRequestedAt !== null ? { requestedAt: r.cancelRequestedAt.toISOString(), requestedBy: r.cancelRequestedBy ?? null } : null,
            /** The effective policy the run works within, each value labelled configured, recommended or unresolved. */
            policy: boundedAutonomy({ run: r, planPaths: pathsOf(r.runId), settings: settingsView.settings, policy: ctx.policy, caps: config.caps, recordedCeilingUsd: ceiling }),
            humanInterventions: attempts.filter((a) => a.humanIntervenedAt !== null && specOf(a.taskId, a.revision)?.runId === r.runId).map((a) => ({ attemptId: a.attemptId, taskId: a.taskId, at: a.humanIntervenedAt!.toISOString() })),
          })),
          tasks: statuses.map((s) => {
            const spec = specOf(s.taskId, s.currentRevision);
            const cancel = commands.find((c) => c.taskId === s.taskId && c.command === 'cancel' && c.state === 'cancel_requested' && c.revision === s.currentRevision);
            return {
              taskId: s.taskId,
              runId: spec?.runId ?? null,
              revision: s.currentRevision,
              aggregateRevision: s.rowRevision,
              status: s.status,
              /** Reason code of a permanent placement block (restricted data, missing grant or limit, approval required); null when none. */
              placementBlock: s.placementBlock ?? null,
              /** Reason code of the latest block when the task is `blocked`, e.g. `resource_conflict:repo`, `repair_budget_exhausted`, `verification_error`; null otherwise. */
              blockedReason: s.status === 'blocked' ? blockedReasonOf(blockEvents, s.taskId) : null,
              title: (spec?.spec as { title?: string } | undefined)?.title ?? null,
              role: (spec?.spec as { role?: string } | undefined)?.role ?? null,
              /** From the spec of the current revision. */
              dependsOn: ((spec?.spec as { dependencies?: readonly { taskId: string }[] } | undefined)?.dependencies ?? []).map((d) => d.taskId),
              /** When the task entered this status. Absent only for a task with no status event yet: its row was created in this state. */
              enteredStatusAt: statusEvents.find((e) => e['task_id'] === s.taskId) ? eventTime(statusEvents.find((e) => e['task_id'] === s.taskId)!) : s.updatedAt.toISOString(),
              latestEvidence: refOf(evidenceEvents.find((e) => e['task_id'] === s.taskId)),
              ...(skillWaits.has(s.taskId) ? { skillRunnerWait: skillWaits.get(s.taskId) } : {}),
              attempts: attempts.filter((a) => a.taskId === s.taskId && a.revision === s.currentRevision).map((a) => ({
                attemptId: a.attemptId, number: a.attemptNumber, runner: a.runner, fence: a.leaseFence, outcome: a.outcome, exitReason: a.exitReason === null || a.streamable ? a.exitReason : restrictedStoredReason(a.exitReason),
                /** Where this attempt's sandbox runs. Null: its runner is no longer enrolled. */
                location: runners.find((r) => r.runnerId === a.runner)?.location ?? null,
                /** The tool the worker last started: a name, never its arguments. Null: nothing reported. */
                activity: a.lastTool !== null && a.lastToolAt !== null ? { tool: a.lastTool, at: a.lastToolAt.toISOString() } : null,
                /** The model this attempt was recorded with, and so what its harness received. Null only for attempts from before assignments. */
                assignment: a.modelProvider !== null && a.modelId !== null ? { provider: a.modelProvider, model: a.modelId, source: a.assignmentSource, route: a.modelRoute ?? 'unknown' } : null,
                humanIntervenedAt: a.humanIntervenedAt?.toISOString() ?? null,
                startedAt: a.startedAt?.toISOString() ?? null, endedAt: a.endedAt?.toISOString() ?? null,
                lastHeartbeatAt: a.lastHeartbeatAt?.toISOString() ?? null, leaseExpiresAt: a.leaseExpiresAt?.toISOString() ?? null, deadlineAt: a.deadlineAt?.toISOString() ?? null,
                leaseHealth: a.endedAt === null && a.lastHeartbeatAt ? leaseHealth(a.lastHeartbeatAt.toISOString(), at) : null,
              })),
              // "Cancel requested" is shown separately from the task status: termination is not confirmed until the runner stops.
              /** `reason`: why it was asked. `policy_revoked:` means the owner narrowed a grant, and the task goes back to ready, blocked by policy, rather than being cancelled. */
              cancel: cancel ? { state: 'cancel_requested', operationId: cancel.operationId, requestedAt: cancel.requestedAt.toISOString(), reason: typeof cancel.detail['reason'] === 'string' ? cancel.detail['reason'] : 'cancel_requested' } : null,
            };
          }),
          // Open requests, and expired ones whose task is still blocked on them: those can still be denied.
          approvals: approvals.filter((a) => a.outcome === 'pending' || !a.taskId || statuses.some((s) => s.taskId === a.taskId && s.currentRevision === a.revision && s.status === 'blocked')).map((a) => ({
            outcome: a.outcome,
            approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.revision, requester: a.requester, scopeHash: a.scopeHash,
            expiresAt: a.expiresAt?.toISOString() ?? null, requestedAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null,
            operation: typeof a.detail['operation'] === 'string' ? a.detail['operation'] : null,
            reason: approvalReason(a),
            destination: typeof a.detail['destination'] === 'string' ? a.detail['destination'] : null,
          })),
          /** The most recent resolved requests, newest first. A grant is a record; `consumedAt` says whether an attempt used it. */
          approvalHistory: resolved.map((a) => ({
            approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.revision, outcome: a.outcome, approver: a.approver ?? null, scopeHash: a.scopeHash,
            operation: typeof a.detail['operation'] === 'string' ? a.detail['operation'] : null,
            reason: approvalReason(a),
            destination: typeof a.detail['destination'] === 'string' ? a.detail['destination'] : null,
            requestedAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null, consumedAt: a.consumedAt?.toISOString() ?? null, consumedBy: a.consumedBy ?? null,
          })),
          /** The reviewable change for each run. `merged_sha_mismatch` and `stale_candidate` tell the owner a merge was not recorded and why. */
          changeRequests: changes.map((c) => ({
            runId: c.runId, prNumber: c.prNumber, url: c.url, status: c.status, candidateSha: c.candidateSha, baseRef: c.baseRef,
            observedHeadSha: c.observedHeadSha ?? null, mergeCommitSha: c.mergeCommitSha ?? null, observedAt: c.observedAt?.toISOString() ?? null,
            /**
             * This open pull request no longer holds the run's live candidate, so it must not be merged: `main_moved` when a rebuild for a newer main retired it, `superseded` for any
             * other reason (a newer candidate, or a plan that now has work the candidate does not carry). `rebuiltSha` is the run's newer candidate, null while nothing has been built.
             */
            outOfDate: (() => {
              if (c.status !== 'open') return null;
              const live = candidateRows.find((l) => l['run_id'] === c.runId && l['status'] === 'assembled');
              const rebuiltSha = live && live['sha'] !== c.candidateSha ? String(live['sha']) : null;
              const retired = retiredForMain.find((m) => m['run_id'] === c.runId && m['sha'] === c.candidateSha);
              if (retired) return { reason: 'main_moved', at: new Date(retired['updated_at'] as string | Date).toISOString(), rebuiltSha, rebuild: rebuildState(c.runId, retired['updated_at'], rebuiltSha) };
              const own = prCandidates.find((p) => p['run_id'] === c.runId && p['sha'] === c.candidateSha);
              const at = (v: unknown) => ({ reason: 'superseded' as const, at: new Date(v as string | Date).toISOString(), rebuiltSha, rebuild: rebuildState(c.runId, v, rebuiltSha) });
              // Not the live candidate: retired for another reason, or another was built after it.
              if (!own || own['status'] !== 'assembled' || rebuiltSha !== null) return at(own?.['updated_at'] ?? c.observedAt ?? new Date(0));
              // Still the latest built, but the plan moved on: the run's live tasks at their current revisions are not the parts it carries.
              const parts = new Set(((own['parts'] as { taskId?: unknown; revision?: unknown }[] | null) ?? []).map((p) => `${String(p.taskId)}@${String(p.revision)}`));
              const liveTasks = statuses.filter((st) => st.status !== 'cancelled' && st.status !== 'superseded' && revisions.some((r) => r.taskId === st.taskId && r.revision === st.currentRevision && r.runId === c.runId)).map((st) => `${st.taskId}@${st.currentRevision}`);
              if (liveTasks.length === parts.size && liveTasks.every((k) => parts.has(k))) return null;
              return at(planAccepted.find((e) => e['run_id'] === c.runId)?.['occurred_at'] ?? own['updated_at']);
            })(),
          })),
          clientReports: reports.map((r) => ({
            reportId: r.reportId, subjectKind: r.subjectKind, subjectId: r.subjectId, kind: r.kind, trust: r.trust, payload: r.payload, createdAt: r.createdAt.toISOString(),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  });
}
