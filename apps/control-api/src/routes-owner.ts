import { NO_HARNESS_CATALOG, availableCatalog, newTaskStateFromSpec, transition, validatePlanRevision, TaskSpecSchema, budgetUsed, type AttemptRecord, type PlanError, type TaskSpec, type TaskStatus } from '@selarikru/domain';
import { readUsageEntries, schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import { evaluate, type Operation } from '@selarikru/policy';
import {
  AcceptReducedScopeRequestSchema, ApprovalResolveRequestSchema, ClientInferenceReportSchema, CreateRunRequestSchema, ModelAssignmentRequestSchema, PlanRevisionRequestSchema, ReverifyRunRequestSchema, TaskCommandRequestSchema,
  redactSecrets, type BudgetStatus,
} from '@selarikru/protocol';
import { assignmentRevision, catalogView, loadModelAssignments, loadRecentRunnerReports, loadRunEvidence, validateSelection, acceptanceCovers, assessRunScope, leaseHealth, loadAcceptedReducedScope, notDeliveredHash, reducedScopeContext, lockStaleCandidate, releaseTaskClaims, reopenBlockedVerification, reopenStaleVerification, retireStaleCandidate, type AcceptedReducedScope, type ReverifyOutcome, type StaleCandidate } from '@selarikru/workflow';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from './app.ts';
import { AppError, invalidRequest, staleRevision } from './errors.ts';
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
        const revision = current + 1;
        await tx.insert(schema.modelAssignments).values({
          tenantId: config.tenantId, projectId, scopeKind: body.scope, scopeKey: body.key, revision,
          provider: body.selection?.provider ?? null, model: body.selection?.model ?? null, updatedBy: uid, updatedAt: at,
        });
        return { scope: body.scope, key: body.key, revision, selection: body.selection, appliesTo: 'next_attempt' as const };
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
    const tasks: TaskSpec[] = body.tasks.map((t) => TaskSpecSchema.parse({ ...t, title: redactSecrets(t.title) }));
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
      // Accepting the first plan is what starts a run: `planning` becomes `running`, the state readiness and the PR gate require. Any later plan keeps the run's current lifecycle.
      await tx.update(schema.runs).set({ planRevision, lifecycle: sql`CASE WHEN lifecycle = 'planning' THEN 'running' ELSE lifecycle END` })
        .where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, run.runId)));
      // The API accepts the plan; the actor is the control plane acting for the authenticated owner, who is named in the payload.
      await writeEvent(tx, at, {
        projectId, runId: run.runId, taskId: run.runId, aggregateRevision: planRevision, type: 'plan.accepted', actor: SYSTEM_ACTOR,
        payload: { planRevision, taskIds: tasks.map((t) => t.taskId), acceptedFor: uid },
      });
      return { planRevision, taskIds: tasks.map((t) => t.taskId) };
    };

    const result = await withTx(db, async (tx) => {
      const stale = staleSha === null ? null : await lockStaleCandidate(tx, runScope, staleSha);
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
            if (pending[0]) return { operationId: pending[0].operationId, command: 'cancel' as const, state: 'cancel_requested' as const, taskStatus: row.status };
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
            return { operationId, command: 'cancel' as const, state: 'cancel_requested' as const, taskStatus: row.status };
          }
          // A verified task is closed work, unless the record behind it no longer stands: then cancelling is one of the ways out.
          const staleExit = isStalePart(stale, taskId, row.status, row.currentRevision);
          if (!IMMEDIATE_CANCEL.includes(row.status) && !staleExit) {
            throw new AppError(403, 'command_not_allowed', `cannot cancel a task that is ${row.status}`, { status: row.status });
          }
          const rev = await bumpStatus(tx, key, row.rowRevision, 'cancelled', at);
          await supersedePendingApprovals(tx, config.tenantId, row.projectId, taskId, at);
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
    const result = await withTx(db, async (tx) => {
      const run = await requireRun(tx, config.tenantId, runId, true);
      return idempotent(tx, { tenantId: config.tenantId, projectId: run.projectId, key: `run.reverify:${runId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        if (body.expectedPlanRevision !== (run.planRevision ?? 0)) throw staleRevision(run.planRevision ?? 0, 'the plan');
        const refuse = (o: Extract<ReverifyOutcome, { ok: false }>) => new AppError(o.reason === 'resource_conflict' ? 409 : 403, 'command_not_allowed', 'this run cannot be re-verified', { reason: o.reason, ...(o.taskId !== undefined ? { taskId: o.taskId } : {}) });
        const scope = { tenantId: config.tenantId, projectId: run.projectId, runId };
        const stale: ReverifyOutcome = staleSha === null || trusted === null ? { ok: false, reason: 'nothing_to_reverify' } : await reopenStaleVerification({ now }, tx, scope, uid, newId('op'), staleSha, trusted);
        if (!stale.ok && stale.reason !== 'nothing_to_reverify') throw refuse(stale);
        const blocked = await reopenBlockedVerification({ now }, tx, scope, uid, newId('op'), trusted);
        if (!blocked.ok && (blocked.reason !== 'nothing_to_reverify' || !stale.ok)) throw refuse(blocked);
        return { runId, reopened: [...(stale.ok ? stale.reopened : []), ...(blocked.ok ? blocked.reopened : [])] };
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
          attemptId: schema.attempts.attemptId, taskId: schema.attempts.taskId, revision: schema.attempts.revision, attemptNumber: schema.attempts.attemptNumber,
          runner: schema.attempts.runner, leaseFence: schema.attempts.leaseFence, lastHeartbeatAt: schema.attempts.lastHeartbeatAt,
          leaseExpiresAt: schema.attempts.leaseExpiresAt, deadlineAt: schema.attempts.deadlineAt, outcome: schema.attempts.outcome,
          exitReason: schema.attempts.exitReason, startedAt: schema.attempts.startedAt, endedAt: schema.attempts.endedAt,
          lastTool: schema.attempts.lastTool, lastToolAt: schema.attempts.lastToolAt,
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
        const reducedScopes = (await tx.select().from(schema.decisions).where(scope(schema.decisions))).filter((d) => d.context.startsWith(reducedScopeContext('')));
        // Why each blocked task stopped: the latest blocking event names it. Statuses alone can't say.
        const blockEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, type, payload FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ('task.blocked', 'task.reopened', 'approval.denied')
          ORDER BY task_id, sequence DESC`);

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

        const specOf = (taskId: string, revision: number) => revisions.find((r) => r.taskId === taskId && r.revision === revision);
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
          modelAssignments: await loadModelAssignments(tx, config.tenantId, projectId),
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
              attempts: attempts.filter((a) => a.taskId === s.taskId && a.revision === s.currentRevision).map((a) => ({
                attemptId: a.attemptId, number: a.attemptNumber, runner: a.runner, fence: a.leaseFence, outcome: a.outcome, exitReason: a.exitReason,
                /** Where this attempt's sandbox runs. Null: its runner is no longer enrolled. */
                location: runners.find((r) => r.runnerId === a.runner)?.location ?? null,
                /** The tool the worker last started: a name, never its arguments. Null: nothing reported. */
                activity: a.lastTool !== null && a.lastToolAt !== null ? { tool: a.lastTool, at: a.lastToolAt.toISOString() } : null,
                /** The model this attempt was recorded with, and so what its harness received. Null only for attempts from before assignments. */
                assignment: a.modelProvider !== null && a.modelId !== null ? { provider: a.modelProvider, model: a.modelId, source: a.assignmentSource, route: a.modelRoute ?? 'unknown' } : null,
                startedAt: a.startedAt?.toISOString() ?? null, endedAt: a.endedAt?.toISOString() ?? null,
                lastHeartbeatAt: a.lastHeartbeatAt?.toISOString() ?? null, leaseExpiresAt: a.leaseExpiresAt?.toISOString() ?? null, deadlineAt: a.deadlineAt?.toISOString() ?? null,
                leaseHealth: a.endedAt === null && a.lastHeartbeatAt ? leaseHealth(a.lastHeartbeatAt.toISOString(), at) : null,
              })),
              // "Cancel requested" is shown separately from the task status: termination is not confirmed until the runner stops.
              cancel: cancel ? { state: 'cancel_requested', operationId: cancel.operationId, requestedAt: cancel.requestedAt.toISOString() } : null,
            };
          }),
          // Open requests, and expired ones whose task is still blocked on them: those can still be denied.
          approvals: approvals.filter((a) => a.outcome === 'pending' || !a.taskId || statuses.some((s) => s.taskId === a.taskId && s.currentRevision === a.revision && s.status === 'blocked')).map((a) => ({
            outcome: a.outcome,
            approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.revision, requester: a.requester, scopeHash: a.scopeHash,
            expiresAt: a.expiresAt?.toISOString() ?? null, requestedAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null,
            operation: typeof a.detail['operation'] === 'string' ? a.detail['operation'] : null,
            reason: typeof a.detail['reason'] === 'string' ? a.detail['reason'] : null,
            destination: typeof a.detail['destination'] === 'string' ? a.detail['destination'] : null,
          })),
          /** The most recent resolved requests, newest first. A grant is a record; `consumedAt` says whether an attempt used it. */
          approvalHistory: resolved.map((a) => ({
            approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.revision, outcome: a.outcome, approver: a.approver ?? null, scopeHash: a.scopeHash,
            operation: typeof a.detail['operation'] === 'string' ? a.detail['operation'] : null,
            reason: typeof a.detail['reason'] === 'string' ? a.detail['reason'] : null,
            destination: typeof a.detail['destination'] === 'string' ? a.detail['destination'] : null,
            requestedAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null, consumedAt: a.consumedAt?.toISOString() ?? null, consumedBy: a.consumedBy ?? null,
          })),
          /** The reviewable change for each run. `merged_sha_mismatch` and `stale_candidate` tell the owner a merge was not recorded and why. */
          changeRequests: changes.map((c) => ({
            runId: c.runId, prNumber: c.prNumber, url: c.url, status: c.status, candidateSha: c.candidateSha, baseRef: c.baseRef,
            observedHeadSha: c.observedHeadSha ?? null, mergeCommitSha: c.mergeCommitSha ?? null, observedAt: c.observedAt?.toISOString() ?? null,
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
