import { randomUUID } from 'node:crypto';
import {
  AcceptedProposalSchema, BASE_FILE_LIMITS, checkAcceptedProposal, sha256Hex, BaseFileAnswerSchema, RESTRICTED_APPLY_REFUSAL, baseFileIssue, screenBaseFiles, screenBaseListing, type BaseFileAnswer, type BaseFileRequest,
} from '@selarikru/domain';
import { schema, withTx, type Executor } from '@selarikru/persistence';
import { LeaseRefSchema } from '@selarikru/protocol';
import { acceptProposal, fetchProposalForLease, proposalReceipt, type Runner } from '@selarikru/workflow';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { loadTaskRoute } from './route-policy.ts';
import { parseBody } from './routes-owner.ts';
import { requireProject } from './store.ts';

/**
 * Accepted patch proposals and the base files the patch agent reads (H5, plan.md §3 Option A). Every AI step runs in the owner's browser; these routes carry its
 * accepted result to the no-model apply worker, and the task's base files from the local runner to the patch agent.
 *
 * - `POST /v1/projects/:id/tasks/:taskId/proposals/accept` (owner): a restricted task is refused before the body is read, so its content is never validated, kept or
 *   logged. Anything else is checked again on the server (`acceptProposal`), recorded with an owner event (ids and hashes), and waits for an apply attempt.
 * - `POST /v1/runners/proposal/fetch` (runner): the apply attempt's proposal, for its current lease only.
 * - `POST /v1/projects/:id/tasks/:taskId/files` (owner), `POST /v1/runners/files/poll` and `POST /v1/runners/files/answer` (runner): a relay held in this process's
 *   memory only. The owner's read waits a bounded time for a runner with the project's checkout to answer from git at the task's base; the answer is screened again
 *   and handed to the waiting read, and nothing is stored or logged. Restricted tasks are never served.
 */

export const AcceptProposalRequestSchema = z.strictObject({ idempotencyKey: z.string().min(1).max(200), proposal: AcceptedProposalSchema });
const FileReadRequestSchema = z.strictObject({ paths: z.array(z.string().min(1).max(200)).min(1).max(BASE_FILE_LIMITS.requestPaths).optional() });
const FilePollSchema = z.strictObject({});

interface Waiting {
  readonly request: BaseFileRequest;
  readonly tenantId: string;
  readonly createdAt: number;
  /** The runner that took it: only that runner may answer. */
  takenBy: string | null;
  readonly settle: (answer: BaseFileAnswer | null) => void;
}

/** One process's waiting file reads. Never persisted: a restart drops them, and the owner's read times out and says so. */
export class FileRelay {
  private readonly waiting = new Map<string, Waiting>();
  constructor(readonly timeoutMs = 15_000, readonly maxPending = 8) {}

  /** Waits for a runner's answer, or null after the timeout; `busy` when this owner already has `maxPending` reads waiting. The entry is gone either way. */
  ask(tenantId: string, request: Omit<BaseFileRequest, 'requestId'>): Promise<BaseFileAnswer | null> | 'busy' {
    if ([...this.waiting.values()].filter((w) => w.tenantId === tenantId).length >= this.maxPending) return 'busy';
    const requestId = `frq_${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); resolve(null); }, this.timeoutMs);
      this.waiting.set(requestId, {
        request: { ...request, requestId }, tenantId, createdAt: Date.now(), takenBy: null,
        settle: (a) => { clearTimeout(timer); this.waiting.delete(requestId); resolve(a); },
      });
    });
  }

  /** Requests for these projects that no runner took yet. Each goes to one runner, which alone may answer it. */
  take(tenantId: string, runnerId: string, projects: readonly string[]): BaseFileRequest[] {
    const out: BaseFileRequest[] = [];
    for (const w of this.waiting.values()) {
      if (w.takenBy !== null || w.tenantId !== tenantId || !projects.includes(w.request.projectId)) continue;
      w.takenBy = runnerId;
      out.push(w.request);
    }
    return out;
  }

  /** False when nothing is waiting under this id, or another runner took it. */
  answer(tenantId: string, runnerId: string, answer: BaseFileAnswer): boolean {
    const w = this.waiting.get(answer.requestId);
    if (!w || w.tenantId !== tenantId || w.takenBy !== runnerId) return false;
    w.settle(answer);
    return true;
  }

  get size(): number { return this.waiting.size; }
}

export function registerApplyRoutes(app: FastifyInstance, ctx: AppContext, relay: FileRelay): void {
  const { db, config, now } = ctx;
  const tenantId = config.tenantId;
  const auth = { onRequest: [ctx.owner] };

  const ownerTask = async (req: FastifyRequest) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const { id: projectId, taskId } = req.params as { id: string; taskId: string };
    await requireProject(db, tenantId, projectId);
    const task = await loadTaskRoute(db, tenantId, projectId, taskId, config.nanoInputBudgetChars);
    if (!task) throw new AppError(404, 'task_not_found', 'no such task');
    return { projectId, taskId, task, uid: req.principal.uid };
  };

  app.post('/v1/projects/:id/tasks/:taskId/proposals/accept', auth, async (req, reply) => {
    const { projectId, taskId, task, uid } = await ownerTask(req);
    // Restricted content never reaches the server: the lock is read first, and the body of a restricted task's request is never parsed, kept or logged.
    if (task.lock !== null || task.spec === null) throw new AppError(403, 'proposal_restricted', RESTRICTED_APPLY_REFUSAL, { reason: task.spec === null ? 'task_spec_unreadable' : 'restricted' });
    const body = parseBody(AcceptProposalRequestSchema, req.body);
    const p = body.proposal;
    if (p.taskId !== taskId) throw new AppError(422, 'proposal_refused', 'the proposal is for another task', { reason: 'task_mismatch' });
    // The route record of the patch call that produced it: the same request (its id is the proposal's), this task's, a patch step that ran and passed its checks, and
    // reporting the hash of this very diff. Anything else is not the output that call produced.
    // The server's own checks against the stored task first, so a refusal names what is wrong with the proposal; the workflow runs them again under its locks.
    const pre = checkAcceptedProposal(p, { taskId, revision: task.revision, baseSha: task.spec.baseSha, allowedPaths: task.spec.allowedPaths });
    if (!pre.ok) {
      if (pre.code === 'stale_revision') throw new AppError(409, 'stale_revision', 'the task has a newer revision; propose the change again', { reason: pre.code });
      throw new AppError(pre.code === 'base_mismatch' ? 409 : 422, 'proposal_refused', `the proposal did not pass the server's checks: ${pre.code}`, { reason: pre.code });
    }
    if (p.routeRecordId !== p.proposalId) throw new AppError(409, 'route_record_missing', 'the proposal does not name the route record of the call that produced it', { reason: 'route_record_mismatch' });
    const rec = await agentOutputGuard(db, { tenantId, projectId, taskId }, p.routeRecordId, 'patch');
    if (rec.outputSha256 !== sha256Hex(p.diff)) throw new AppError(409, 'route_record_missing', 'the route record of this call names another output, so this proposal is not what that call produced', { reason: 'route_record_output_mismatch' });
    // Not wrapped in a stored receipt: the proposal's own row holds the key that last queued it, and the same key again reads the proposal as it is now (never an
    // earlier receipt); a new key queues a proposal whose apply failed.
    const r = await withTx(db, (tx) => acceptProposal({ db, now }, { tenantId, projectId, taskId }, { proposal: p, acceptedBy: uid, idempotencyKey: body.idempotencyKey }, tx));
    if (r.ok) return reply.code(r.value.state === 'accepted' ? 201 : 200).send(r.value);
    if (r.error.reason === 'task_not_found') throw new AppError(404, 'task_not_found', 'no such task');
    if (r.error.reason === 'task_not_applicable') throw new AppError(409, 'task_not_applicable', 'the task is not waiting to start, so a change cannot be applied to it now', { reason: r.error.reason });
    if (r.error.reason === 'proposal_already_accepted') throw new AppError(409, 'proposal_already_accepted', `this proposal is already ${r.error.state === 'applying' ? 'being applied' : r.error.state === 'applied' ? 'applied' : 'waiting for the runner'}`, { reason: r.error.reason, state: r.error.state });
    if (r.error.reason === 'stale_revision') throw new AppError(409, 'stale_revision', 'the task has a newer revision; propose the change again', { reason: r.error.reason });
    throw new AppError(r.error.status, 'proposal_refused', `the proposal did not pass the server's checks: ${r.error.reason}`, { reason: r.error.reason });
  });

  // One proposal as it is now (ids, hashes, state, round and why the last apply did not stand), so the owner's screen reads the round from the server, not from memory.
  app.get('/v1/projects/:id/tasks/:taskId/proposals/:proposalId', auth, async (req) => {
    const { projectId, taskId } = await ownerTask(req);
    const { proposalId } = req.params as { proposalId: string };
    const receipt = await proposalReceipt(db, { tenantId, projectId, taskId }, proposalId);
    if (receipt === null) throw new AppError(404, 'no_proposal', 'no such accepted proposal for this task');
    return receipt;
  });

  // ---- runner side ----------------------------------------------------------------------------------------------------------------
  const runnerOf = (req: FastifyRequest): Runner => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    return { runnerId: p.runnerId, tenantId: p.tenantId, location: p.location };
  };

  app.post('/v1/runners/proposal/fetch', { onRequest: [ctx.runner] }, async (req) => {
    const runner = runnerOf(req);
    const ref = parseBody(z.strictObject({ lease: LeaseRefSchema }), req.body).lease;
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: ref.attemptId, fence: ref.fence });
    const [a] = await db.select({ projectId: schema.attempts.projectId, runner: schema.attempts.runner }).from(schema.attempts).where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.attemptId, ref.attemptId)));
    if (!a || a.runner !== runner.runnerId) throw stale;
    const r = await fetchProposalForLease({ db, now }, { tenantId: runner.tenantId, projectId: a.projectId, attemptId: ref.attemptId, fence: ref.fence, leaseToken: ref.leaseToken });
    if (!r.ok) {
      if (r.error.reason === 'stale_fence') throw stale;
      throw new AppError(404, 'no_proposal', 'this attempt has no accepted proposal to apply');
    }
    return { proposal: r.value };
  });

  // ---- base files, relayed ---------------------------------------------------------------------------------------------------------
  app.post('/v1/projects/:id/tasks/:taskId/files', auth, async (req) => {
    const { projectId, taskId, task } = await ownerTask(req);
    if (task.lock !== null || task.spec === null) throw new AppError(403, 'files_restricted', 'this task\'s files stay on this device, so they are not read here', { reason: task.spec === null ? 'task_spec_unreadable' : 'restricted' });
    const body = parseBody(FileReadRequestSchema, req.body);
    const spec = task.spec;
    const paths = (body.paths ?? []).map((p) => p.replace(/\/+$/, ''));
    if (paths.length === 0) return { taskId, revision: task.revision, baseSha: spec.baseSha, files: [], omitted: [] };
    const outside = paths.find((p) => baseFileIssue(p, spec.allowedPaths) !== null);
    if (outside !== undefined) throw new AppError(422, 'invalid_request', 'a path is outside the task\'s allowed paths, reserved, or a credentials file', { reason: baseFileIssue(outside, spec.allowedPaths) });
    const answer = await relayed({ projectId, baseSha: spec.baseSha, mode: 'read', paths, allowedPaths: [...spec.allowedPaths] });
    return { taskId, revision: task.revision, baseSha: spec.baseSha, ...screenBaseFiles(answer, spec.allowedPaths) };
  });

  // The first step of the patch agent's file choice: what is under the task's allowed paths, paths and sizes only, capped. Any number of allowed paths.
  app.post('/v1/projects/:id/tasks/:taskId/files/list', auth, async (req) => {
    const { projectId, taskId, task } = await ownerTask(req);
    if (task.lock !== null || task.spec === null) throw new AppError(403, 'files_restricted', 'this task\'s files stay on this device, so they are not read here', { reason: task.spec === null ? 'task_spec_unreadable' : 'restricted' });
    parseBody(FilePollSchema, req.body);
    const spec = task.spec;
    const roots = spec.allowedPaths.map((p) => p.replace(/\/+$/, '')).filter((p) => baseFileIssue(p, spec.allowedPaths) === null).slice(0, BASE_FILE_LIMITS.allowedPaths);
    if (roots.length === 0) return { taskId, revision: task.revision, baseSha: spec.baseSha, entries: [], truncated: false };
    const answer = await relayed({ projectId, baseSha: spec.baseSha, mode: 'list', paths: roots, allowedPaths: [...spec.allowedPaths].slice(0, BASE_FILE_LIMITS.allowedPaths) });
    const listed = screenBaseListing(answer.entries ?? [], spec.allowedPaths);
    return { taskId, revision: task.revision, baseSha: spec.baseSha, entries: listed.entries, truncated: listed.truncated || answer.truncated === true };
  });

  /** One relayed read: refused when too many are waiting, timed out when no runner answers, and said plainly when the runner has no copy of the project. */
  async function relayed(request: Omit<BaseFileRequest, 'requestId'>): Promise<BaseFileAnswer> {
    const waiting = relay.ask(tenantId, request);
    if (waiting === 'busy') throw new AppError(429, 'too_many_file_requests', 'too many file reads are waiting for a runner; try again when they finish');
    const answer = await waiting;
    if (answer === null) throw new AppError(504, 'files_unavailable', 'no runner with this project\'s checkout answered in time, so the files could not be read');
    if (answer.noCheckout === true) throw new AppError(409, 'no_checkout', 'This runner has no copy of the project; the proposal can only add new files');
    return answer;
  }

  app.post('/v1/runners/files/poll', { onRequest: [ctx.runner] }, async (req) => {
    const runner = runnerOf(req);
    parseBody(FilePollSchema, req.body);
    if (relay.size === 0) return { requests: [] };
    const [row] = await db.select({ projects: schema.runners.configuredProjects }).from(schema.runners).where(and(eq(schema.runners.tenantId, runner.tenantId), eq(schema.runners.runnerId, runner.runnerId)));
    return { requests: relay.take(runner.tenantId, runner.runnerId, (row?.projects as string[] | null) ?? []) };
  });

  app.post('/v1/runners/files/answer', { onRequest: [ctx.runner], bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const runner = runnerOf(req);
    const answer = parseBody(BaseFileAnswerSchema, req.body);
    if (!relay.answer(runner.tenantId, runner.runnerId, answer)) throw new AppError(404, 'file_request_not_found', 'no such file request is waiting for this runner');
    return { accepted: true };
  });
}

/**
 * The server's own judgement of one browser agent call's output before it may leave the device's own use (H5 fix rounds 2 and 4): an accept, an agent criteria
 * revision, an agent-written PR body. The call's route record must exist for this task and step and have run (`route_record_missing`); a call that ran locked is
 * refused (`proposal_from_restricted_call`); and the context the server served it, recorded under the id the record names, must exist and hold nothing stronger than
 * internal (`proposal_from_restricted_context`). The last needs nothing the browser says about its lock, so a tampered client is still refused.
 */
export async function agentOutputGuard(db: Executor, key: { tenantId: string; projectId: string; taskId: string }, routeRecordId: string, stepKind: string): Promise<{ readonly outputSha256: unknown }> {
  const [record] = await db.select({ payload: schema.clientReports.payload }).from(schema.clientReports).where(and(
    eq(schema.clientReports.tenantId, key.tenantId), eq(schema.clientReports.projectId, key.projectId), eq(schema.clientReports.kind, 'route'), eq(schema.clientReports.subjectKind, 'task'),
    eq(schema.clientReports.subjectId, key.taskId), sql`${schema.clientReports.payload} ->> 'requestId' = ${routeRecordId}`,
  )).limit(1);
  const rec = record?.payload as { stepKind?: unknown; status?: unknown; outputSha256?: unknown; locked?: unknown; contextId?: unknown; taskRevision?: unknown; effectiveMode?: unknown } | undefined;
  if (!rec || rec.stepKind !== stepKind || rec.status !== 'ok') throw new AppError(409, 'route_record_missing', `there is no record of where the ${stepKind} call that produced this ran, so it cannot be used`);
  // A call that ran locked to the device read restricted data: its output stays on the device, whatever the task's label says now.
  if (rec.locked === true) throw new AppError(409, 'proposal_from_restricted_call', RESTRICTED_APPLY_REFUSAL, { reason: 'locked_call' });
  const contextId = typeof rec.contextId === 'string' ? rec.contextId : null;
  const [served] = contextId !== null ? await db.select({ label: schema.agentContexts.contentLabel, taskId: schema.agentContexts.taskId, revision: schema.agentContexts.revision, destination: schema.agentContexts.destination }).from(schema.agentContexts)
    .where(and(eq(schema.agentContexts.tenantId, key.tenantId), eq(schema.agentContexts.projectId, key.projectId), eq(schema.agentContexts.contextId, contextId))) : [];
  const refuse = (reason: string): never => {
    throw new AppError(409, 'proposal_from_restricted_context', 'this came from a call whose context held restricted data, or whose context the server cannot vouch for, so it stays on the device', { reason });
  };
  if (!served || served.taskId !== key.taskId) refuse('context_not_recorded');
  if (!['public', 'internal'].includes(served!.label)) refuse('restricted_context');
  // The context must be the one this call could have read: the same task revision, and the device context exactly when the call's route kept it on the device.
  if (served!.revision !== rec.taskRevision) refuse('context_revision_mismatch');
  if ((served!.destination === 'local') !== (rec.effectiveMode === 'ONLY_ON_DEVICE')) refuse('context_destination_mismatch');
  // One served context backs one call.
  const named = await db.select({ id: schema.clientReports.reportId }).from(schema.clientReports).where(and(
    eq(schema.clientReports.tenantId, key.tenantId), eq(schema.clientReports.projectId, key.projectId), eq(schema.clientReports.kind, 'route'), sql`${schema.clientReports.payload} ->> 'contextId' = ${contextId}`)).limit(2);
  if (named.length !== 1) refuse('context_reused');
  return { outputSha256: rec.outputSha256 };
}

/** Context records older than this are pruned, unless their task has an accept waiting. */
export const AGENT_CONTEXT_RETENTION_DAYS = 7;

/**
 * Retention for `agent_contexts` (H5 fix round 5), run by the periodic pass: rows older than 7 days whose task has no accepted proposal waiting for an apply attempt.
 * Ids and labels only; no lock beyond the delete itself. Returns how many rows went.
 */
export async function pruneAgentContexts(ctx: { readonly db: Executor; readonly tenantId: string; readonly now: () => Date }): Promise<number> {
  const before = new Date(ctx.now().getTime() - AGENT_CONTEXT_RETENTION_DAYS * 86_400_000);
  const gone = await ctx.db.execute(sql`DELETE FROM agent_contexts c WHERE c.tenant_id = ${ctx.tenantId} AND c.served_at < ${before.toISOString()}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM accepted_proposals p WHERE p.tenant_id = c.tenant_id AND p.project_id = c.project_id AND p.task_id = c.task_id AND p.state = 'accepted')
    RETURNING c.context_id`);
  return gone.length;
}
