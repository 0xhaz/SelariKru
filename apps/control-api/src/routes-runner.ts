import { TaskSpecSchema } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { ClaimRequestSchema, EnrollRequestSchema, HeartbeatRequestSchema, PairingCodeRequestSchema, ResultRequestSchema, TerminalUploadRequestSchema, redactSecrets, type LeaseRef } from '@selarikru/protocol';
import type { Lease, LeaseConflict, PublishResult, Runner } from '@selarikru/workflow';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { bearerToken, newSecret, PAIRING_CODE_PREFIX, RUNNER_TOKEN_PREFIX, sha256Hex } from './auth.ts';
import { AppError } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { loadSpecRow, newId, requireProject } from './store.ts';
import { streamableAttempt } from './terminal.ts';

const runnerOf = (req: FastifyRequest): Runner => {
  const p = req.principal;
  if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
  return { runnerId: p.runnerId, tenantId: p.tenantId, location: p.location };
};

/** Independent of order, and of the key order jsonb stores. */
const reportKey = (reports: readonly { provider: string; harnessVersion: string | null; models: readonly string[] }[]): string =>
  JSON.stringify(reports.map((r) => [r.provider, r.harnessVersion, [...r.models].sort()]).sort());

const conflict = (c: LeaseConflict): AppError =>
  new AppError(409, 'lease_conflict', 'the lease is not current', { reason: c.reason, taskId: c.taskId, attemptId: c.attemptId, fence: c.fence });

export function registerRunnerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now, scheduler } = ctx;

  // ---- enrolment ---------------------------------------------------------------------------------------------
  app.post('/v1/runners/pairing-codes', { onRequest: [ctx.owner] }, async (req, reply) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const body = parseBody(PairingCodeRequestSchema, req.body);
    const code = newSecret(PAIRING_CODE_PREFIX);
    const at = now();
    const expiresAt = new Date(at.getTime() + config.pairingCodeTtlSeconds * 1000);
    await db.insert(schema.runnerPairingCodes).values({
      tenantId: config.tenantId, codeHash: sha256Hex(code), location: body.location, createdBy: req.principal.uid, createdAt: at, expiresAt,
    });
    return reply.code(201).send({ pairingCode: code, location: body.location, expiresAt: expiresAt.toISOString() });
  });

  app.post('/v1/runners/enroll', { onRequest: [ctx.enroll] }, async (req, reply) => {
    const code = bearerToken(req.headers.authorization) ?? '';
    const body = parseBody(EnrollRequestSchema, req.body);
    const invalid = new AppError(401, 'invalid_pairing_code', 'the pairing code is invalid, used or expired');
    if (!code.startsWith(PAIRING_CODE_PREFIX)) throw invalid;
    const at = now();
    const runnerId = newId('runner');
    const token = newSecret(RUNNER_TOKEN_PREFIX);
    const location = await withTx(db, async (tx) => {
      // One statement both validates and consumes the code, so two concurrent enrolments cannot both win.
      const used = await tx.execute(sql`
        UPDATE runner_pairing_codes SET used_at = ${at.toISOString()}::timestamptz, runner_id = ${runnerId}
        WHERE code_hash = ${sha256Hex(code)} AND tenant_id = ${config.tenantId} AND used_at IS NULL AND expires_at > ${at.toISOString()}::timestamptz
        RETURNING location`);
      const loc = used[0]?.['location'];
      if (loc !== 'local' && loc !== 'cloud') throw invalid;
      await tx.insert(schema.runners).values({
        tenantId: config.tenantId, runnerId, location: loc, tokenHash: sha256Hex(token),
        ...(body.label !== undefined ? { label: redactSecrets(body.label) } : {}), ...(body.harnesses !== undefined ? { harnessReport: body.harnesses } : {}), createdAt: at, lastSeenAt: at,
      });
      return loc;
    });
    return reply.code(201).send({ runnerId, token, location, tenantId: config.tenantId });
  });

  // ---- scheduler access --------------------------------------------------------------------------------------
  const guard = { onRequest: [ctx.runner] };

  app.post('/v1/runners/claim', guard, async (req, reply) => {
    const runner = runnerOf(req);
    const body = parseBody(ClaimRequestSchema, req.body);
    const where = and(eq(schema.runners.tenantId, runner.tenantId), eq(schema.runners.runnerId, runner.runnerId));
    const stored = (await db.select({ report: schema.runners.harnessReport }).from(schema.runners).where(where))[0]?.report ?? null;
    // Claims arrive at poll rate; an unchanged report writes nothing.
    if (body.harnesses !== undefined && (stored === null || reportKey(stored) !== reportKey(body.harnesses))) await db.update(schema.runners).set({ harnessReport: body.harnesses }).where(where);
    const harnesses = body.harnesses ?? stored ?? [];
    const outcome = await scheduler.tryClaim({ ...runner, harnesses }, config.caps);
    if (outcome.ok) return reply.code(200).send({ lease: outcome.lease, reason: null, skipped: outcome.skipped });
    return reply.code(200).send({ lease: null, reason: outcome.reason, skipped: outcome.skipped });
  });

  /** The runner presents attempt, fence and token. Everything else in the lease is rebuilt from the database. */
  async function leaseFor(runner: Runner, ref: LeaseRef): Promise<Lease> {
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: ref.attemptId, fence: ref.fence });
    const rows = await db.select().from(schema.attempts)
      .where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.attemptId, ref.attemptId)));
    const a = rows[0];
    if (!a || a.runner !== runner.runnerId || a.leaseFence === null || a.leaseToken === null) throw stale;
    const spec = await loadSpecRow(db, { tenantId: a.tenantId, projectId: a.projectId, taskId: a.taskId, revision: a.revision });
    if (!spec) throw stale;
    const at = (d: Date | null) => (d ?? new Date(0)).toISOString();
    return {
      tenantId: a.tenantId, projectId: a.projectId, runId: spec.runId, taskId: a.taskId, revision: a.revision,
      attemptId: a.attemptId, attemptNumber: a.attemptNumber, fence: ref.fence, leaseToken: ref.leaseToken,
      runnerId: runner.runnerId, location: runner.location, reservationId: `res_${a.attemptId}`,
      acquiredAt: at(a.startedAt), lastHeartbeatAt: at(a.lastHeartbeatAt), expiresAt: at(a.leaseExpiresAt), deadlineAt: at(a.deadlineAt),
    };
  }

  app.post('/v1/runners/heartbeat', guard, async (req, reply) => {
    const runner = runnerOf(req);
    const body = parseBody(HeartbeatRequestSchema, req.body);
    const result = await scheduler.heartbeat(await leaseFor(runner, body.lease), body.activity);
    if (!result.ok) throw conflict(result.error);
    return reply.code(200).send(result.value);
  });

  /** The pinned task spec for a current lease: what to build, at which base, and the paths the attempt may touch. */
  app.post('/v1/runners/task', guard, async (req, reply) => {
    const runner = runnerOf(req);
    const body = parseBody(HeartbeatRequestSchema, req.body);
    const lease = await leaseFor(runner, body.lease);
    // `leaseFor` rebuilds from the database, so the presented token and fence are checked here against the stored ones.
    const held = (await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.attemptId, lease.attemptId))))[0];
    if (!held || held.leaseToken !== body.lease.leaseToken || held.leaseFence !== body.lease.fence)
      throw new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: lease.attemptId, fence: body.lease.fence });
    const row = await loadSpecRow(db, { tenantId: lease.tenantId, projectId: lease.projectId, taskId: lease.taskId, revision: lease.revision });
    const parsed = TaskSpecSchema.safeParse(row?.spec);
    if (!parsed.success) throw new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: lease.attemptId, fence: lease.fence });
    return reply.code(200).send({ task: parsed.data });
  });

  app.post('/v1/runners/result', guard, async (req, reply) => {
    const runner = runnerOf(req);
    const body = parseBody(ResultRequestSchema, req.body);
    // Runner-supplied reasons are free text and end up in events.
    const r = body.result;
    const reported = { ...(r.reportedCostUsd !== undefined ? { reportedCostUsd: r.reportedCostUsd } : {}), ...(r.reportedUsage !== undefined ? { reportedUsage: r.reportedUsage } : {}) };
    const result: PublishResult =
      r.outcome === 'completed'
        ? { outcome: 'completed', ...(r.headSha !== undefined ? { headSha: r.headSha } : {}), ...(r.changeManifestSha256 !== undefined ? { changeManifestSha256: r.changeManifestSha256 } : {}), ...reported }
        : { outcome: r.outcome, reason: redactSecrets(r.reason), ...(r.outcome === 'approval_requested' && r.operation !== undefined ? { operation: r.operation } : {}), ...(r.outcome === 'approval_requested' && r.destination !== undefined ? { destination: r.destination } : {}), ...reported };
    const published = await scheduler.publishResult(await leaseFor(runner, body.lease), result);
    if (!published.ok) throw conflict(published.error);
    ctx.terminal.markEnded(body.lease.attemptId);
    return reply.code(200).send(published.value);
  });

  /**
   * One batch of an attempt's live output, from the runner holding that attempt's current lease: this runner, this fence and token, the attempt not ended, the task still running at
   * its revision, and the lease unexpired. Restricted or secret work is refused outright even if a runner sends it. The output goes only to the in-memory hub.
   */
  app.post('/v1/runners/terminal', guard, async (req, reply) => {
    const runner = runnerOf(req);
    const body = parseBody(TerminalUploadRequestSchema, req.body);
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: body.lease.attemptId, fence: body.lease.fence });
    const [a] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.attemptId, body.lease.attemptId)));
    if (!a || a.runner !== runner.runnerId || a.leaseFence !== body.lease.fence || a.leaseToken !== body.lease.leaseToken || a.endedAt !== null || a.leaseExpiresAt === null || a.leaseExpiresAt.getTime() <= now().getTime()) throw stale;
    const [row] = await db.select({ status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, runner.tenantId), eq(schema.taskStatus.projectId, a.projectId), eq(schema.taskStatus.taskId, a.taskId)));
    if (!row || row.status !== 'running' || row.revision !== a.revision) throw stale;
    const project = await requireProject(db, runner.tenantId, a.projectId);
    if (!(await streamableAttempt(ctx, { projectId: a.projectId, taskId: a.taskId, revision: a.revision, projectClassification: project.classification }))) {
      throw new AppError(403, 'terminal_restricted', 'live output is not accepted for restricted or secret work');
    }
    ctx.terminal.publish(a.projectId, a.attemptId, body);
    return reply.code(200).send({ accepted: true });
  });
}
