import { OPEN_HANDOVER_STATES, HANDOVER_CLOSE_TEXT, HANDOVER_REASON_TEXT, HANDOVER_STATE_LABEL, type HandoverState } from '@selarikru/domain';
import { schema, withTx, type Executor } from '@selarikru/persistence';
import { CheckpointFetchSchema, CheckpointUploadSchema, HandoverDecisionSchema, HandoverDiffQuerySchema, HandoverRequestSchema, LeaseRefSchema, redactSecrets, validateCheckpoint } from '@selarikru/protocol';
import { assessHandover, decideHandover, recordCheckpoint, requestHandover, successorCheckpoint, type CheckpointRow, type HandoverAssessment, type Lease, type Runner } from '@selarikru/workflow';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { fingerprint, idempotent, loadSpecRow, requireProject } from './store.ts';

/**
 * Checkpoint continuation routes (docs/architecture.md §4). The owner reads whether a running local attempt may continue on a cloud runner, asks for it, and answers a restart
 * offer; the runner holding the prior attempt sends its checkpoint; the successor fetches it. "Cloud runner" is an enrolled runner whose location is `cloud`: hosted cloud
 * infrastructure is not part of this build (T7.3). No route here returns file content to a person, and none puts it in an event or a log.
 */

export const HANDOVER_NOTICE =
  'A cloud runner here is an enrolled runner whose location is cloud. Continuing starts a new attempt there from the approved base commit with the checked checkpoint applied; '
  + 'it is not a migration of the running session, and the combined result is verified again from the start. Secret-bearing files and anything outside the allowed paths are never carried.';

/** What a checkpoint leaves out, as the owner reads it before confirming. */
export const CHECKPOINT_EXCLUDES = [
  '.env files, keys, certificates and credential files (.pem, .key, id_rsa, .npmrc, credentials.*)',
  'any file whose content the secret detector flags',
  'anything outside the task\'s allowed paths',
  'links and special files, home directories, model memory and sandbox state',
];

const text = (code: string): string => HANDOVER_REASON_TEXT[code] ?? code;
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** A handover row as a person may see it: by path, change, size and hash. The stored bytes never leave this function. */
export function recordView(r: CheckpointRow, taskStatus: string | null = null) {
  const files = (r.files ?? []) as { path: string; status: 'added' | 'modified' | 'deleted'; size: number | null; sha256: string | null }[];
  const diffs = (r.diffs ?? {}) as Record<string, { binary?: boolean; lines?: unknown[] | null; added?: number; removed?: number }>;
  const statOf = (path: string) => {
    const d = diffs[path];
    return { added: d?.lines ? (d.added ?? 0) : null, removed: d?.lines ? (d.removed ?? 0) : null, hasDiff: r.diffs !== null && Array.isArray(d?.lines), binary: d?.binary === true };
  };
  const shown = files.map((f) => ({ path: f.path, status: f.status, size: f.size, sha256: f.sha256, ...statOf(f.path) }));
  return {
    checkpointId: r.checkpointId, taskId: r.taskId, revision: r.revision, runId: r.runId, mode: r.mode, state: r.state, stateLabel: HANDOVER_STATE_LABEL[r.state as HandoverState] ?? r.state,
    target: r.target, priorAttemptId: r.priorAttemptId, priorFence: r.priorFence, nextFence: r.nextFence, successorAttemptId: r.successorAttemptId, successorFence: r.successorFence,
    baseSha: r.baseSha,
    patch: r.patchSha256 !== null && r.mode === 'resume' ? {
      sha256: r.patchSha256, fileCount: r.fileCount ?? files.length, totalBytes: r.totalBytes ?? 0, files: shown,
      // Lines added and removed across the files that have a line diff. Null when none has one (binary, too large, or dropped).
      stat: shown.some((f) => f.added !== null) ? { added: shown.reduce((n, f) => n + (f.added ?? 0), 0), removed: shown.reduce((n, f) => n + (f.removed ?? 0), 0) } : null,
    } : null,
    exclusions: ((r.exclusions ?? []) as { path: string; reason: string }[]).map((x) => ({ path: x.path, reason: x.reason })),
    // Why a resume was not possible stays on the record after the owner answered: it is the history of this handover.
    refusal: r.refusal !== null && r.state !== 'stopping' ? { code: r.refusal, text: text(r.refusal) } : null,
    estimate: Object.keys(r.estimate).length > 0 ? r.estimate : null,
    latePublishes: r.latePublishes, requestedAt: r.requestedAt.toISOString(), fencedAt: iso(r.fencedAt), updatedAt: r.updatedAt.toISOString(),
    releasedAt: iso(r.releasedAt), releasedBy: r.releasedBy, successorRetries: r.successorRetries,
    // A blocked task takes no release or restart: only declining is offered.
    taskBlocked: taskStatus === 'blocked',
    contentDropped: r.contentDroppedAt !== null ? { at: r.contentDroppedAt.toISOString(), reason: r.contentDroppedReason ?? 'unknown', text: HANDOVER_CLOSE_TEXT[r.contentDroppedReason ?? ''] ?? r.contentDroppedReason ?? '' } : null,
    closed: r.state === 'closed' || r.state === 'declined' ? { reason: r.closedReason ?? 'unknown', text: HANDOVER_CLOSE_TEXT[r.closedReason ?? ''] ?? r.closedReason ?? '' } : null,
  };
}

function taskView(a: HandoverAssessment, current: CheckpointRow | undefined) {
  return {
    taskId: a.taskId, status: a.status, attempt: a.attempt, baseSha: a.baseSha, allowedPaths: [...a.allowedPaths],
    resume: { ...a.resume, reasons: [...a.resume.reasons], reasonText: a.resume.reasons.map(text) },
    restart: { ...a.restart, reasons: [...a.restart.reasons], reasonText: a.restart.reasons.map(text) },
    estimate: a.estimate, excludes: CHECKPOINT_EXCLUDES, current: current ? recordView(current, a.status) : null,
  };
}

async function rowsOf(db: Executor, tenantId: string, projectId: string, taskId?: string): Promise<CheckpointRow[]> {
  return db.select().from(schema.checkpoints)
    .where(and(eq(schema.checkpoints.tenantId, tenantId), eq(schema.checkpoints.projectId, projectId), ...(taskId !== undefined ? [eq(schema.checkpoints.taskId, taskId)] : [])))
    .orderBy(desc(schema.checkpoints.requestedAt), desc(schema.checkpoints.checkpointId)).limit(50);
}

export function registerHandoverRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const tenantId = config.tenantId;
  const auth = { onRequest: [ctx.owner] };
  const sched = { db, now, policy: ctx.policy, catalog: ctx.catalog, codingWorkers: config.codingWorkers };

  const ownerOf = async (req: FastifyRequest) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const { id: projectId, taskId } = req.params as { id: string; taskId?: string };
    await requireProject(db, tenantId, projectId);
    return { projectId, taskId, uid: req.principal.uid };
  };
  const requireTask = async (projectId: string, taskId: string) => {
    const [row] = await db.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus)
      .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, taskId)));
    if (!row) throw new AppError(404, 'task_not_found', 'no such task');
  };
  const one = async (projectId: string, taskId: string) => {
    const a = await assessHandover(sched, { tenantId, projectId, taskId }, config.caps);
    const rows = await rowsOf(db, tenantId, projectId, taskId);
    return taskView(a, rows[0]);
  };
  const all = async (projectId: string) => {
    const running = await db.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus)
      .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.status, 'running')));
    const records = await rowsOf(db, tenantId, projectId);
    // Every running task, and every task with a handover still in hand.
    const ids = [...new Set([...running.map((r) => r.taskId), ...records.filter((r) => (OPEN_HANDOVER_STATES as readonly string[]).includes(r.state)).map((r) => r.taskId)])].sort();
    const tasks = [];
    for (const taskId of ids) tasks.push(taskView(await assessHandover(sched, { tenantId, projectId, taskId }, config.caps), records.find((r) => r.taskId === taskId)));
    const statuses = new Map((await db.select({ taskId: schema.taskStatus.taskId, status: schema.taskStatus.status }).from(schema.taskStatus)
      .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId)))).map((r) => [r.taskId, r.status] as const));
    return { projectId, observedAt: now().toISOString(), notice: HANDOVER_NOTICE, tasks, records: records.map((r) => recordView(r, statuses.get(r.taskId) ?? null)) };
  };
  const refused = (reason: string, status: number) => new AppError(status, status === 404 ? 'task_not_found' : 'handover_refused', text(reason), { reason });

  app.get('/v1/projects/:id/handovers', auth, async (req) => {
    const { projectId } = await ownerOf(req);
    return all(projectId);
  });

  app.get('/v1/projects/:id/tasks/:taskId/handover', auth, async (req) => {
    const { projectId, taskId } = await ownerOf(req);
    await requireTask(projectId, taskId!);
    return one(projectId, taskId!);
  });

  app.post('/v1/projects/:id/tasks/:taskId/handover', auth, async (req, reply) => {
    const { projectId, taskId, uid } = await ownerOf(req);
    const body = parseBody(HandoverRequestSchema, req.body);
    await requireTask(projectId, taskId!);
    const key = { tenantId, projectId, taskId: taskId! };
    const receipt = await withTx(db, (tx) => idempotent(tx, { tenantId, projectId, key: `handover.request:${taskId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
      const r = await requestHandover(sched, key, { mode: body.mode, requestedBy: uid, caps: config.caps }, tx);
      if (!r.ok) throw refused(r.error.reason, r.error.status);
      return r.value;
    }));
    // The attempt is stopping: nobody should be typing into it.
    ctx.control.endForAttempt(receipt.priorAttemptId, 'attempt_fenced');
    return reply.code(202).send(receipt);
  });

  app.post('/v1/projects/:id/tasks/:taskId/handover/decision', auth, async (req) => {
    const { projectId, taskId, uid } = await ownerOf(req);
    const body = parseBody(HandoverDecisionSchema, req.body);
    await requireTask(projectId, taskId!);
    return withTx(db, (tx) => idempotent(tx, { tenantId, projectId, key: `handover.decide:${body.checkpointId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
      const r = await decideHandover(sched, { tenantId, projectId, taskId: taskId! }, body.checkpointId, body.choice, uid, tx);
      if (!r.ok) {
        if (r.error.reason === 'handover_task_blocked') throw new AppError(409, 'handover_task_blocked', 'the task is blocked: only keeping it local is possible now', { reason: r.error.reason });
        throw r.error.status === 404 ? new AppError(404, 'handover_not_found', text(r.error.reason), { reason: r.error.reason }) : refused(r.error.reason, r.error.status);
      }
      return r.value;
    }));
  });

  /**
   * One file's review diff, for the owner deciding a release. Owner only. Never for restricted work (whose checkpoint is refused before it exists), and every line passes the
   * secret detector before it is shown: a base line removed by the change can hold what the checked post-image may not.
   */
  app.get('/v1/projects/:id/tasks/:taskId/handover/diff', auth, async (req) => {
    const { projectId, taskId } = await ownerOf(req);
    const q = parseBody(HandoverDiffQuerySchema, req.query);
    const [row] = await db.select().from(schema.checkpoints).where(and(eq(schema.checkpoints.tenantId, tenantId), eq(schema.checkpoints.projectId, projectId), eq(schema.checkpoints.taskId, taskId!), eq(schema.checkpoints.checkpointId, q.checkpointId)));
    if (!row) throw new AppError(404, 'handover_not_found', 'no such handover');
    const [prior] = await db.select({ detail: schema.attempts.detail }).from(schema.attempts).where(and(eq(schema.attempts.tenantId, tenantId), eq(schema.attempts.projectId, projectId), eq(schema.attempts.attemptId, row.priorAttemptId)));
    if ((prior?.detail as { terminalStreamable?: unknown } | undefined)?.terminalStreamable !== true) throw new AppError(403, 'checkpoint_restricted', 'restricted work has no checkpoint to show');
    const file = ((row.files ?? []) as { path: string; status: string; size: number | null; sha256: string | null }[]).find((f) => f.path === q.path);
    if (!file) throw new AppError(404, 'no_checkpoint', 'that file is not in this checkpoint');
    if (row.diffs === null) throw new AppError(404, 'no_checkpoint', `the checkpoint's content was dropped: ${HANDOVER_CLOSE_TEXT[row.contentDroppedReason ?? ''] ?? 'it is no longer kept'}`);
    const d = (row.diffs as Record<string, { binary?: boolean; lines?: [string, string][] | null; added?: number; removed?: number; redacted?: boolean }>)[q.path];
    // Removed base lines were redacted when the checkpoint arrived; this pass is a second net for anything kept before that.
    let redacted = d?.redacted === true;
    const lines = d?.lines ? d.lines.map(([op, t]) => { const r = redactSecrets(t); if (r !== t) redacted = true; return [op, r] as const; }) : null;
    return { checkpointId: row.checkpointId, path: file.path, status: file.status, size: file.size, sha256: file.sha256, binary: d?.binary === true, added: d?.added ?? null, removed: d?.removed ?? null, lines, redacted };
  });

  // ---- runner side ----------------------------------------------------------------------------------------------------------------
  const runnerOf = (req: FastifyRequest): Runner => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    return { runnerId: p.runnerId, tenantId: p.tenantId, location: p.location };
  };
  const stale = (ref: { attemptId: string; fence: number }) => new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: ref.attemptId, fence: ref.fence });
  /** The lease as the stored attempt has it, for this runner only. The fence and token are then checked by the workflow under the task's status lock. */
  async function leaseOf(runner: Runner, ref: { attemptId: string; fence: number; leaseToken: string }): Promise<{ lease: Lease; streamable: boolean }> {
    const [a] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.attemptId, ref.attemptId)));
    if (!a || a.runner !== runner.runnerId) throw stale(ref);
    const spec = await loadSpecRow(db, { tenantId: a.tenantId, projectId: a.projectId, taskId: a.taskId, revision: a.revision });
    if (!spec) throw stale(ref);
    const at = (d: Date | null) => (d ?? new Date(0)).toISOString();
    const lease: Lease = {
      tenantId: a.tenantId, projectId: a.projectId, runId: spec.runId, taskId: a.taskId, revision: a.revision, attemptId: a.attemptId, attemptNumber: a.attemptNumber,
      fence: ref.fence, leaseToken: ref.leaseToken, runnerId: runner.runnerId, location: runner.location, reservationId: `res_${a.attemptId}`,
      acquiredAt: at(a.startedAt), lastHeartbeatAt: at(a.lastHeartbeatAt), expiresAt: at(a.leaseExpiresAt), deadlineAt: at(a.deadlineAt),
    };
    return { lease, streamable: (a.detail as { terminalStreamable?: unknown }).terminalStreamable === true };
  }

  app.post('/v1/runners/checkpoint', { onRequest: [ctx.runner], bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const runner = runnerOf(req);
    // Only the lease is read first. Restricted output stays on the device, so the attempt is checked before the rest of the body is parsed: a restricted attempt's files are
    // never validated, kept or logged, whatever they hold. The workflow checks the stored label, and the sources' labels now, again under its lock.
    const ref = parseBody(LeaseRefSchema, (req.body as { lease?: unknown } | null)?.lease);
    const first = await leaseOf(runner, ref);
    if (!first.streamable) {
      const r = await recordCheckpoint(sched, first.lease, () => ({ ok: false, reason: 'restricted_work' }));
      if (!r.ok && r.error.reason === 'stale_fence') throw stale(ref);
      throw new AppError(403, 'checkpoint_restricted', 'a checkpoint of restricted work is never accepted: it stays on the device');
    }
    const body = parseBody(CheckpointUploadSchema, req.body);
    const { lease } = first;
    const r = await recordCheckpoint(sched, lease, (task) => validateCheckpoint(body, task));
    if (!r.ok) {
      if (r.error.reason === 'stale_fence') throw stale(body.lease);
      if (r.error.reason === 'restricted_work') throw new AppError(403, 'checkpoint_restricted', 'a checkpoint of restricted work is never accepted: it stays on the device');
      if (r.error.status === 409) throw new AppError(409, 'handover_not_found', text(r.error.reason), { reason: r.error.reason });
      throw new AppError(422, 'checkpoint_refused', text(r.error.reason), { reason: r.error.reason });
    }
    return { accepted: true, ...r.value };
  });

  app.post('/v1/runners/checkpoint/fetch', { onRequest: [ctx.runner] }, async (req) => {
    const runner = runnerOf(req);
    const body = parseBody(CheckpointFetchSchema, req.body);
    const { lease } = await leaseOf(runner, body.lease);
    const r = await successorCheckpoint(sched, lease);
    if (!r.ok) {
      if (r.error.reason === 'stale_fence') throw stale(body.lease);
      if (r.error.reason === 'checkpoint_tampered') throw new AppError(422, 'checkpoint_tampered', text('checkpoint_tampered'), { reason: 'checkpoint_tampered' });
      throw new AppError(404, 'no_checkpoint', 'this attempt starts from the persisted input: there is no checkpoint to apply', { reason: r.error.reason });
    }
    return r.value;
  });
}
