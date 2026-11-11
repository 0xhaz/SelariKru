import { AiCheckpointSchema, effectiveRoutePolicy, escalationDecision, serverCheckpointRefusal, type AiCheckpoint } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { loadTaskRoute } from './route-policy.ts';
import { ownerOf, parseBody } from './routes-owner.ts';
import { requireProject } from './store.ts';

/**
 * H12: AI step checkpoints the owner's browser stores here so they survive a browser close (see domain ai-checkpoint.ts). Owner only and project scoped.
 *
 * Only public and internal checkpoints are kept. A checkpoint is refused, before anything is written, when it says it is restricted, secret or locked
 * (`serverCheckpointRefusal`), and also by the server's own judgement, the H5 backstop's: the task's lock now (from its labels, Brain sources and predecessors), the
 * route record of its last call (a call that ran locked read restricted data), and the context the server served it. The table's checks refuse it again.
 *
 * Lock order: none beyond the row itself. A save reads the task's route without a lock and upserts its own row; an escalation is one conditional update.
 */
const CLOSED: ReadonlySet<string> = new Set(['done', 'sent', 'escalated', 'moved_to_device', 'dropped']);
const LIST_LIMIT = 100;

const restricted = (reason: string): AppError => new AppError(422, 'checkpoint_restricted', 'this checkpoint holds restricted data, so it stays in your browser and is not stored here', { reason });

export function registerAiCheckpointRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const tenantId = config.tenantId;
  const guard = { onRequest: [ctx.owner] };

  /** The server's own reasons to refuse it, from rows the browser cannot change. */
  async function judge(projectId: string, cp: AiCheckpoint): Promise<void> {
    const own = serverCheckpointRefusal(cp);
    if (own === 'checkpoint_secret') throw new AppError(422, 'checkpoint_secret', 'this checkpoint carries something shaped like a credential, so it is not stored');
    if (own !== null) throw restricted('labelled_restricted');
    const task = await loadTaskRoute(db, tenantId, projectId, cp.taskId, config.nanoInputBudgetChars);
    if (!task) throw new AppError(404, 'task_not_found', 'no such task in this project');
    if (task.lock !== null) throw restricted('task_locked');
    if (cp.routeRecordId !== null) {
      const [rec] = await db.select({ payload: schema.clientReports.payload }).from(schema.clientReports).where(and(
        eq(schema.clientReports.tenantId, tenantId), eq(schema.clientReports.projectId, projectId), eq(schema.clientReports.kind, 'route'), eq(schema.clientReports.subjectKind, 'task'),
        eq(schema.clientReports.subjectId, cp.taskId), sql`${schema.clientReports.payload} ->> 'requestId' = ${cp.routeRecordId}`)).limit(1);
      const p = rec?.payload as { locked?: unknown; inputLabel?: unknown } | undefined;
      if (p && (p.locked === true || p.inputLabel === 'restricted' || p.inputLabel === 'secret')) throw restricted('locked_call');
    }
    if (cp.inputs.contextId !== null) {
      const [served] = await db.select({ label: schema.agentContexts.contentLabel, taskId: schema.agentContexts.taskId }).from(schema.agentContexts)
        .where(and(eq(schema.agentContexts.tenantId, tenantId), eq(schema.agentContexts.projectId, projectId), eq(schema.agentContexts.contextId, cp.inputs.contextId)));
      if (served && (served.taskId !== cp.taskId || !['public', 'internal'].includes(served.label))) throw restricted('restricted_context');
    }
  }

  const bodyOf = (row: typeof schema.aiCheckpoints.$inferSelect): AiCheckpoint => ({ ...(row.body as unknown as AiCheckpoint), escalatedAt: row.escalatedAt ? row.escalatedAt.toISOString() : null });

  app.get('/v1/projects/:id/ai-checkpoints', guard, async (req) => {
    const uid = ownerOf(req);
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, tenantId, projectId);
    const rows = await db.select().from(schema.aiCheckpoints)
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.ownerUid, uid)))
      .orderBy(desc(schema.aiCheckpoints.updatedAt)).limit(LIST_LIMIT);
    return { checkpoints: rows.map(bodyOf) };
  });

  app.post('/v1/projects/:id/ai-checkpoints', guard, async (req, reply) => {
    const uid = ownerOf(req);
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, tenantId, projectId);
    const cp = parseBody(AiCheckpointSchema, req.body);
    if (cp.projectId !== projectId) throw new AppError(422, 'checkpoint_project_mismatch', 'this checkpoint names another project');
    await judge(projectId, cp);
    const at = now();
    const created = await withTx(db, async (tx) => {
      const [prior] = await tx.select().from(schema.aiCheckpoints)
        .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, cp.checkpointId))).for('update');
      if (prior && (prior.ownerUid !== uid || prior.taskId !== cp.taskId)) throw new AppError(404, 'checkpoint_not_found', 'no such checkpoint');
      // A closed checkpoint stays closed: a stale tab cannot send it again by saving it as waiting.
      if (prior && CLOSED.has(prior.status) && prior.status !== cp.status) throw new AppError(409, 'checkpoint_closed', `this step was already ${prior.status.replace(/_/g, ' ')}; it is not reopened`);
      // Set only by the escalation route, and never cleared.
      const escalatedAt = prior?.escalatedAt ?? null;
      const body = { ...cp, escalatedAt: escalatedAt ? escalatedAt.toISOString() : null };
      const values = { status: cp.status, stopReason: cp.stopReason, body: body as unknown as Record<string, unknown>, updatedAt: at };
      if (prior) {
        await tx.update(schema.aiCheckpoints).set(values).where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, cp.checkpointId)));
        return false;
      }
      await tx.insert(schema.aiCheckpoints).values({ tenantId, projectId, checkpointId: cp.checkpointId, ownerUid: uid, taskId: cp.taskId, escalatedAt: null, createdAt: at, ...values });
      return true;
    });
    return reply.code(created ? 201 : 200).send({ checkpointId: cp.checkpointId, stored: 'server' });
  });

  // Escalation, at most once (H12): a stopped Local first step whose local result failed its checks may continue in the cloud. Judged here on the route as it is now,
  // then claimed by one conditional update: a reload, a second tab or a retry gets `already_escalated`.
  app.post('/v1/projects/:id/ai-checkpoints/:checkpointId/escalation', guard, async (req) => {
    const uid = ownerOf(req);
    const { id: projectId, checkpointId } = req.params as { id: string; checkpointId: string };
    await requireProject(db, tenantId, projectId);
    const [row] = await db.select().from(schema.aiCheckpoints)
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, checkpointId), eq(schema.aiCheckpoints.ownerUid, uid)));
    if (!row) throw new AppError(404, 'checkpoint_not_found', 'no such checkpoint');
    const cp = bodyOf(row);
    const task = await loadTaskRoute(db, tenantId, projectId, cp.taskId, config.nanoInputBudgetChars);
    if (!task) throw new AppError(404, 'task_not_found', 'no such task in this project');
    // The task's own route, without any call override: escalation is a Local first rule.
    const mode = effectiveRoutePolicy({ call: null, task: task.route.override, run: task.route.runDefault, lock: task.lock }).mode;
    const decision = escalationDecision(cp, { mode, lock: task.lock !== null });
    if (!decision.ok) throw new AppError(409, 'escalation_refused', 'this step is not escalated to the cloud', { reason: decision.reason });
    const at = now();
    const [claimed] = await db.update(schema.aiCheckpoints)
      .set({ escalatedAt: at, updatedAt: at, body: sql`jsonb_set(${schema.aiCheckpoints.body}, '{escalatedAt}', to_jsonb(${at.toISOString()}::text))` })
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, checkpointId), isNull(schema.aiCheckpoints.escalatedAt)))
      .returning();
    if (!claimed) throw new AppError(409, 'escalation_refused', 'this step was already escalated once', { reason: 'already_escalated' });
    return { checkpoint: bodyOf(claimed) };
  });
}
