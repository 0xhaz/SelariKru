import { newTaskStateFromSpec, transition, validatePlanRevision, TaskSpecSchema, budgetUsed, type AttemptRecord, type PlanError, type TaskSpec, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { evaluate, type Operation } from '@selarikru/policy';
import {
  AcceptReducedScopeRequestSchema, ApprovalResolveRequestSchema, ClientInferenceReportSchema, CreateRunRequestSchema, PlanRevisionRequestSchema, TaskCommandRequestSchema,
  redactSecrets, type BudgetStatus,
} from '@selarikru/protocol';
import { acceptanceCovers, assessRunScope, leaseHealth, loadAcceptedReducedScope, reducedScopeContext, releaseTaskClaims, type AcceptedReducedScope } from '@selarikru/workflow';
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

/** An open request for a task that was replaced or cancelled can no longer be resolved. */
async function supersedePendingApprovals(tx: Tx, tenantId: string, projectId: string, taskId: string): Promise<void> {
  await tx.update(schema.approvals).set({ outcome: 'superseded' }).where(and(
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

export function registerOwnerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };

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
        await tx.insert(schema.runs).values({ tenantId: config.tenantId, projectId, runId, lifecycle: 'planning', budget, placement, trial: body.trial === true });
        await writeEvent(tx, at, {
          projectId, runId, taskId: runId, aggregateRevision: 1, type: 'run.created',
          actor: { kind: 'human', id: uid },
          payload: {
            title: redactSecrets(body.title),
            ...(body.description !== undefined ? { description: redactSecrets(body.description) } : {}),
            budget: budgetStatus(budget),
            ...(placement ? { placement } : {}),
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
    const validation = validatePlanRevision({ projectId, runId: run.runId, revision: body.expectedRevision + 1, tasks: body.tasks }, { projectId, runId: run.runId });
    const errors = [...extra, ...(validation.ok ? [] : validation.errors)];
    if (errors.length > 0) throw new AppError(422, 'plan_invalid', 'the proposed plan is not valid', errors);

    // Titles are free text; everything else in a spec is an identifier, hash or limit.
    const tasks: TaskSpec[] = body.tasks.map((t) => TaskSpecSchema.parse({ ...t, title: redactSecrets(t.title) }));
    const at = now();

    const persist = (tx: Tx) => async () => {
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
        if (!REPLANNABLE.includes(row.status) || t.revision <= row.currentRevision) {
          throw new AppError(409, 'task_not_replannable', `task ${t.taskId} cannot take this revision`, { taskId: t.taskId, status: row.status, currentRevision: row.currentRevision });
        }
        existing.set(t.taskId, row);
      }
      // Pending approvals for a replaced task revision are void; they can no longer be resolved.
      for (const taskId of existing.keys()) await supersedePendingApprovals(tx, config.tenantId, projectId, taskId);
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

    const result = await withTx(db, (tx) =>
      body.idempotencyKey === undefined
        ? persist(tx)()
        : idempotent(tx, { tenantId: config.tenantId, projectId, key: `plan.revise:${run.runId}:${body.idempotencyKey}` }, fingerprint(body), persist(tx)),
    );
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
    const result = await withTx(db, async (tx) => {
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
          if (!IMMEDIATE_CANCEL.includes(row.status)) {
            throw new AppError(403, 'command_not_allowed', `cannot cancel a task that is ${row.status}`, { status: row.status });
          }
          const rev = await bumpStatus(tx, key, row.rowRevision, 'cancelled', at);
          await supersedePendingApprovals(tx, config.tenantId, row.projectId, taskId);
          // A verifying task still holds the claims of its completed attempt; cancelling is the verification's end.
          await releaseTaskClaims(tx, { tenantId: config.tenantId, projectId: row.projectId, taskId }, row.currentRevision, at);
          await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancelled', actor: { kind: 'human', id: uid }, payload: { operationId } });
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
        await tx.update(schema.approvals).set({ outcome: granted ? 'granted' : 'denied', approver: uid })
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
        }).from(schema.attempts).where(scope(schema.attempts)).orderBy(asc(schema.attempts.attemptNumber));
        const commands = await tx.select().from(schema.taskCommands).where(scope(schema.taskCommands)).orderBy(desc(schema.taskCommands.requestedAt));
        const approvals = await tx.select().from(schema.approvals).where(and(scope(schema.approvals), inArray(schema.approvals.outcome, ['pending', 'expired'])));
        const reports = await tx.select().from(schema.clientReports).where(scope(schema.clientReports)).orderBy(desc(schema.clientReports.createdAt)).limit(50);
        const changes = await tx.select().from(schema.changeRequests).where(scope(schema.changeRequests));
        const reducedScopes = (await tx.select().from(schema.decisions).where(scope(schema.decisions))).filter((d) => d.context.startsWith(reducedScopeContext('')));
        // Why each blocked task stopped: the latest blocking event names it. Statuses alone can't say.
        const blockEvents = await tx.execute(sql`
          SELECT DISTINCT ON (task_id) task_id, type, payload FROM events
          WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND type IN ('task.blocked', 'task.reopened', 'approval.denied')
          ORDER BY task_id, sequence DESC`);

        const specOf = (taskId: string, revision: number) => revisions.find((r) => r.taskId === taskId && r.revision === revision);
        return {
          projectId,
          cursor,
          generatedAt: at.toISOString(),
          runs: runs.map((r) => ({
            runId: r.runId, lifecycle: r.lifecycle, requestRevision: r.requestRevision, planRevision: r.planRevision ?? 0, budget: budgetStatus(r.budget), placement: r.placement ?? null,
            /** Set once the owner accepted a budget stop. `notDelivered` lists what was stopped and is never counted as verified. */
            reducedScope: reducedScopes.filter((d) => d.context === reducedScopeContext(r.runId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.affected[0] ?? null,
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
              attempts: attempts.filter((a) => a.taskId === s.taskId && a.revision === s.currentRevision).map((a) => ({
                attemptId: a.attemptId, number: a.attemptNumber, runner: a.runner, fence: a.leaseFence, outcome: a.outcome, exitReason: a.exitReason,
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
            expiresAt: a.expiresAt?.toISOString() ?? null, requestedAt: a.createdAt.toISOString(),
            operation: typeof a.detail['operation'] === 'string' ? a.detail['operation'] : null,
            reason: typeof a.detail['reason'] === 'string' ? a.detail['reason'] : null,
            destination: typeof a.detail['destination'] === 'string' ? a.detail['destination'] : null,
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
