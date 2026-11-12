import { AiCheckpointSchema, effectiveRoutePolicy, escalationDecision, serverCheckpointRefusal, type AiCheckpoint } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { loadTaskRoute, taskRouteLocks } from './route-policy.ts';
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
const CLOSED: ReadonlySet<string> = new Set(['done', 'sent', 'escalated', 'moved_to_device', 'dropped', 'abandoned']);
const LIST_LIMIT = 100;
/** Fix round 2 (N4): what a tab holding a claim may save it as, and how long a claim lasts before another tab may close it as abandoned. */
const AFTER_SENDING: ReadonlySet<string> = new Set(['sent', 'waiting', 'moved_to_device', 'abandoned']);
const CLAIM_ABANDON_MS = 30 * 60_000;

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

  const bodyOf = (row: typeof schema.aiCheckpoints.$inferSelect): AiCheckpoint => {
    // The claim token is never in a listed body (fix round 2, N4).
    const { claimToken: _token, ...body } = row.body as unknown as AiCheckpoint;
    void _token;
    // Fix round 3 (R1): the row's own time, which the claim sets, is the checkpoint's updatedAt: a live claim never reads as stale to another tab.
    return { ...body, updatedAt: row.updatedAt.toISOString(), escalatedAt: row.escalatedAt ? row.escalatedAt.toISOString() : null };
  };

  app.get('/v1/projects/:id/ai-checkpoints', guard, async (req) => {
    const uid = ownerOf(req);
    const { id: projectId } = req.params as { id: string };
    await requireProject(db, tenantId, projectId);
    const rows = await db.select().from(schema.aiCheckpoints)
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.ownerUid, uid)))
      .orderBy(desc(schema.aiCheckpoints.updatedAt)).limit(LIST_LIMIT);
    // Fix round 1 (I4): judged again by each task's lock now (computed as every route read computes it): a checkpoint stored while its task was internal is
    // withheld once the task reads restricted data, so it never reaches a browser that would send it to the cloud.
    const locks = await taskRouteLocks(db, tenantId, projectId, rows.map((r) => r.taskId));
    // Fix round 2 (N5): only a task the lock read knows, with no lock. An unknown task is withheld, never read as unlocked.
    return { checkpoints: rows.filter((r) => locks.has(r.taskId) && locks.get(r.taskId) === null).map(bodyOf) };
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
      // Fix round 1 (M2): two first saves of one checkpoint race on the insert. The row is made first if it is missing (a conflict does nothing), then locked and
      // read, so the second save is an update rather than a 500.
      const inserted = await tx.insert(schema.aiCheckpoints).values({
        tenantId, projectId, checkpointId: cp.checkpointId, ownerUid: uid, taskId: cp.taskId, status: cp.status, stopReason: cp.stopReason,
        body: { ...cp, claimToken: undefined, escalatedAt: null } as unknown as Record<string, unknown>, escalatedAt: null, createdAt: at, updatedAt: at,
      }).onConflictDoNothing().returning({ id: schema.aiCheckpoints.checkpointId });
      if (inserted.length > 0) return true;
      const [prior] = await tx.select().from(schema.aiCheckpoints)
        .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, cp.checkpointId))).for('update');
      if (prior && (prior.ownerUid !== uid || prior.taskId !== cp.taskId)) throw new AppError(404, 'checkpoint_not_found', 'no such checkpoint');
      // A closed checkpoint stays closed: a stale tab cannot send it again by saving it as waiting.
      if (prior && CLOSED.has(prior.status) && prior.status !== cp.status) throw new AppError(409, 'checkpoint_closed', `this step was already ${prior.status.replace(/_/g, ' ')}; it is not reopened`);
      // Fix round 2 (N4): a row being sent takes a save only from the tab holding its claim, and only to what a send ends in. Another tab may close a claim left
      // for 30 minutes as abandoned.
      if (prior && prior.status === 'sending') {
        const holder = cp.claimToken !== undefined && prior.claimToken !== null && cp.claimToken === prior.claimToken && AFTER_SENDING.has(cp.status);
        const stale = cp.status === 'abandoned' && at.getTime() - prior.updatedAt.getTime() > CLAIM_ABANDON_MS;
        if (!holder && !stale) throw new AppError(409, 'checkpoint_claimed', 'another tab is sending this step; only that tab may save it now', { status: prior.status });
      }
      // Set only by the escalation route, and never cleared.
      const escalatedAt = prior?.escalatedAt ?? null;
      const { claimToken: _token, ...stored } = cp;
      void _token;
      const body = { ...stored, escalatedAt: escalatedAt ? escalatedAt.toISOString() : null };
      const values = { status: cp.status, stopReason: cp.stopReason, body: body as unknown as Record<string, unknown>, updatedAt: at, claimToken: null };
      await tx.update(schema.aiCheckpoints).set(values).where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, cp.checkpointId)));
      return false;
    });
    return reply.code(created ? 201 : 200).send({ checkpointId: cp.checkpointId, stored: 'server' });
  });

  // Fix round 1 (M1): one tab sends a waiting checkpoint. A conditional update moves it waiting → sending; a second tab (or a retry) is refused, so it is sent once.
  // The sender then saves it as sent, or as waiting again if the call paused. Owner and project scoped.
  app.post('/v1/projects/:id/ai-checkpoints/:checkpointId/send-claim', guard, async (req) => {
    const uid = ownerOf(req);
    const { id: projectId, checkpointId } = req.params as { id: string; checkpointId: string };
    await requireProject(db, tenantId, projectId);
    const at = now();
    const claimToken = randomBytes(24).toString('base64url');
    const [claimed] = await db.update(schema.aiCheckpoints)
      .set({ status: 'sending', updatedAt: at, claimToken, body: sql`jsonb_set(jsonb_set(${schema.aiCheckpoints.body}, '{status}', '"sending"'::jsonb), '{updatedAt}', to_jsonb(${at.toISOString()}::text))` })
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, checkpointId), eq(schema.aiCheckpoints.ownerUid, uid), eq(schema.aiCheckpoints.status, 'waiting')))
      .returning();
    if (!claimed) {
      const [row] = await db.select({ status: schema.aiCheckpoints.status }).from(schema.aiCheckpoints)
        .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, checkpointId), eq(schema.aiCheckpoints.ownerUid, uid)));
      if (!row) throw new AppError(404, 'checkpoint_not_found', 'no such checkpoint');
      throw new AppError(409, 'checkpoint_claimed', `this step is ${row.status.replace(/_/g, ' ')}, not waiting; another tab may be sending it`, { status: row.status });
    }
    // The claim token goes to the claiming tab only (fix round 2, N4).
    return { checkpoint: { ...bodyOf(claimed), claimToken } };
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
      .where(and(eq(schema.aiCheckpoints.tenantId, tenantId), eq(schema.aiCheckpoints.projectId, projectId), eq(schema.aiCheckpoints.checkpointId, checkpointId), eq(schema.aiCheckpoints.ownerUid, uid), isNull(schema.aiCheckpoints.escalatedAt)))
      .returning();
    if (!claimed) throw new AppError(409, 'escalation_refused', 'this step was already escalated once', { reason: 'already_escalated' });
    return { checkpoint: bodyOf(claimed) };
  });
}
