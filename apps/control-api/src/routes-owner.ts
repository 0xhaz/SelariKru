import { newTaskStateFromSpec, transition, validatePlanRevision, TaskSpecSchema, budgetUsed, type AttemptRecord, type PlanError, type TaskSpec, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { evaluate } from '@selarikru/policy';
import {
  ApprovalResolveRequestSchema, ClientInferenceReportSchema, CreateRunRequestSchema, PlanRevisionRequestSchema, TaskCommandRequestSchema,
  redactSecrets, type BudgetStatus,
} from '@selarikru/protocol';
import { leaseHealth } from '@selarikru/workflow';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
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
const REPLANNABLE: readonly string[] = ['planned', 'ready'];
const IMMEDIATE_CANCEL: readonly string[] = ['planned', 'ready', 'awaiting_approval', 'blocked'];
const CANCEL_REQUEST: readonly string[] = ['running', 'verifying'];

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
        await tx.insert(schema.runs).values({ tenantId: config.tenantId, projectId, runId, lifecycle: 'planning', budget });
        await writeEvent(tx, at, {
          projectId, runId, taskId: runId, aggregateRevision: 1, type: 'run.created',
          actor: { kind: 'human', id: uid },
          payload: {
            title: redactSecrets(body.title),
            ...(body.description !== undefined ? { description: redactSecrets(body.description) } : {}),
            budget: budgetStatus(budget),
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
      for (const t of tasks) {
        await tx.insert(schema.taskRevisions).values({ tenantId: config.tenantId, projectId, runId: run.runId, taskId: t.taskId, revision: t.revision, boardId: t.boardId, spec: t });
      }
      for (const t of tasks) {
        const prior = existing.get(t.taskId);
        if (prior) {
          await tx.update(schema.taskStatus)
            .set({ currentRevision: t.revision, status: 'planned', rowRevision: prior.rowRevision + 1, updatedAt: at })
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
      await tx.update(schema.runs).set({ planRevision })
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
            await tx.insert(schema.taskCommands).values({
              tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
              command: 'cancel', state: 'cancel_requested', requestedBy: uid, requestedAt: at,
            });
            return { operationId, command: 'cancel' as const, state: 'cancel_requested' as const, taskStatus: row.status };
          }
          if (!IMMEDIATE_CANCEL.includes(row.status)) {
            throw new AppError(403, 'command_not_allowed', `cannot cancel a task that is ${row.status}`, { status: row.status });
          }
          const rev = await bumpStatus(tx, key, row.rowRevision, 'cancelled', at);
          await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancelled', actor: { kind: 'human', id: uid }, payload: { operationId } });
          await tx.insert(schema.taskCommands).values({
            tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
            command: 'cancel', state: 'applied', requestedBy: uid, requestedAt: at,
          });
          return { operationId, command: 'cancel' as const, state: 'applied' as const, taskStatus: 'cancelled' };
        }

        // retry
        const gate = evaluate({ kind: 'assign_replan_tasks' }, ctx.policy);
        if (gate.decision !== 'allow') throw new AppError(403, 'policy_denied', 'policy does not allow retrying', { reason: gate.reason, decision: gate.decision });
        const spec = TaskSpecSchema.safeParse(specRow.spec);
        const init = spec.success ? newTaskStateFromSpec(spec.data, 'repository') : null;
        if (!init?.ok) throw new AppError(403, 'command_not_allowed', 'task spec is invalid', { status: row.status });
        const attempts = await tx.select().from(schema.attempts).where(and(
          eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, row.projectId),
          eq(schema.attempts.taskId, taskId), eq(schema.attempts.revision, row.currentRevision))).orderBy(asc(schema.attempts.attemptNumber));
        const records: AttemptRecord[] = attempts.map((a) => ({
          attemptId: a.attemptId, number: a.attemptNumber,
          outcome: (a.outcome ?? (a.endedAt === null ? 'running' : 'failed')) as AttemptRecord['outcome'],
        }));
        const moved = transition({ ...init.value, status: row.status as TaskStatus, attempts: records }, { type: 'retry_requested' });
        if (!moved.ok) throw new AppError(403, 'command_not_allowed', moved.error.reason, { status: row.status, attemptsUsed: budgetUsed(records) });
        const rev = await bumpStatus(tx, key, row.rowRevision, 'ready', at);
        // `task.ready` is scheduler-only. The control plane applies the owner's retry through the scheduler's authority
        // and records who asked in the payload.
        await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.ready', actor: { kind: 'scheduler', id: 'control-api' }, payload: { reason: 'retry_requested', operationId, requestedBy: uid } });
        await tx.insert(schema.taskCommands).values({
          tenantId: config.tenantId, projectId: row.projectId, operationId, taskId, revision: row.currentRevision,
          command: 'retry', state: 'applied', requestedBy: uid, requestedAt: at,
        });
        return { operationId, command: 'retry' as const, state: 'applied' as const, taskStatus: 'ready' };
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
      const found = await tx.select().from(schema.approvals)
        .where(and(eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.approvalId, approvalId))).for('update');
      if (found.length === 0) throw new AppError(404, 'approval_not_found', 'no such approval');
      if (found.length > 1) throw new AppError(409, 'ambiguous_id', 'the id exists in more than one project');
      const approval = found[0]!;
      return idempotent(tx, { tenantId: config.tenantId, projectId: approval.projectId, key: `approval.resolve:${approvalId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        if (approval.outcome !== 'pending') throw new AppError(409, 'approval_already_resolved', 'this approval already has an outcome', { outcome: approval.outcome });
        if (approval.expiresAt && approval.expiresAt.getTime() <= at.getTime()) throw new AppError(409, 'approval_expired', 'this approval has expired');
        if (approval.scopeHash !== body.scopeHash) throw new AppError(409, 'scope_mismatch', 'the scope hash does not match the approval');
        if (!approval.runId) throw new AppError(422, 'invalid_request', 'approval is not run-scoped');

        const task = approval.taskId ? await requireTaskStatus(tx, config.tenantId, approval.taskId, true) : null;
        const expected = task ? task.rowRevision : 0;
        if (body.expectedRevision !== expected) throw staleRevision(expected, 'the approval target');

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
        const approvals = await tx.select().from(schema.approvals).where(and(scope(schema.approvals), eq(schema.approvals.outcome, 'pending')));
        const reports = await tx.select().from(schema.clientReports).where(scope(schema.clientReports)).orderBy(desc(schema.clientReports.createdAt)).limit(50);

        const specOf = (taskId: string, revision: number) => revisions.find((r) => r.taskId === taskId && r.revision === revision);
        return {
          projectId,
          cursor,
          generatedAt: at.toISOString(),
          runs: runs.map((r) => ({
            runId: r.runId, lifecycle: r.lifecycle, requestRevision: r.requestRevision, planRevision: r.planRevision ?? 0, budget: budgetStatus(r.budget),
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
          approvals: approvals.map((a) => ({
            approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.revision, requester: a.requester, scopeHash: a.scopeHash,
            expiresAt: a.expiresAt?.toISOString() ?? null,
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
