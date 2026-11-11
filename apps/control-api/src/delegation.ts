import { applyDelegation, PM_ACTOR } from '@selarikru/workflow';
import { schema } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.ts';
import { agentOutputGuard } from './apply.ts';
import { AppError } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { requireProject } from './store.ts';

/**
 * H11: the Project Manager's delegation (owner only, from the owner's browser). The PM's proposal is untrusted browser output: the server finds the route record of
 * the `pmDelegate` call that produced it (and the context it was served, H5's guard), then applies only what lies inside the run's accepted plan, by the domain rule
 * the workflow runs under its locks. An assignment the plan does not cover is never applied: it comes back refused, for the owner. Each item is kept as sent, so a
 * field the plan cannot authorise (a path, a budget, a role) refuses the proposal rather than being dropped quietly.
 */
const Assignment = z.object({ taskId: z.string().min(1).max(200), workerId: z.string().min(1).max(200) }).catchall(z.unknown());
export const DelegationRequestSchema = z.strictObject({
  planRevision: z.number().int().min(1),
  /** The task whose route the `pmDelegate` call ran on (its route record is filed under it). */
  subjectTaskId: z.string().min(1).max(200),
  routeRecordId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  assignments: z.array(Assignment).min(1).max(12),
});

export function registerDelegationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const tenantId = config.tenantId;
  app.post('/v1/projects/:id/runs/:runId/delegations', { onRequest: [ctx.owner] }, async (req) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const { id: projectId, runId } = req.params as { id: string; runId: string };
    await requireProject(db, tenantId, projectId);
    const body = parseBody(DelegationRequestSchema, req.body);
    const [subject] = await db.select({ runId: schema.taskRevisions.runId }).from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.taskId, body.subjectTaskId))).limit(1);
    if (!subject || subject.runId !== runId) throw new AppError(404, 'task_not_found', 'the Project Manager call names no task of this run');
    // The record of the pmDelegate call: it ran, unlocked, on context no stronger than internal. Otherwise its output is not used.
    await agentOutputGuard(db, { tenantId, projectId, taskId: body.subjectTaskId }, body.routeRecordId, 'pmDelegate');
    const r = await applyDelegation({ db, now }, { tenantId, projectId, runId, planRevision: body.planRevision, assignments: body.assignments, actor: PM_ACTOR });
    if (!r) throw new AppError(404, 'run_not_found', 'no such run');
    return { applied: r.apply, refused: r.refuse, autoDelegate: r.autoDelegate };
  });
}
