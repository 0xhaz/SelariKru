import { randomUUID } from 'node:crypto';
import {
  AcceptedProposalSchema, BASE_FILE_LIMITS, BaseFileAnswerSchema, RESTRICTED_APPLY_REFUSAL, baseFileIssue, screenBaseFiles, type BaseFileAnswer, type BaseFileRequest,
} from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { LeaseRefSchema } from '@selarikru/protocol';
import { acceptProposal, fetchProposalForLease, type Runner } from '@selarikru/workflow';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { loadTaskRoute } from './route-policy.ts';
import { parseBody } from './routes-owner.ts';
import { fingerprint, idempotent, requireProject } from './store.ts';

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
  taken: boolean;
  readonly settle: (answer: BaseFileAnswer | null) => void;
}

/** One process's waiting file reads. Never persisted: a restart drops them, and the owner's read times out and says so. */
export class FileRelay {
  private readonly waiting = new Map<string, Waiting>();
  constructor(readonly timeoutMs = 15_000) {}

  /** Waits for a runner's answer, or null after the timeout. The entry is gone either way. */
  ask(tenantId: string, request: Omit<BaseFileRequest, 'requestId'>): Promise<BaseFileAnswer | null> {
    const requestId = `frq_${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); resolve(null); }, this.timeoutMs);
      this.waiting.set(requestId, {
        request: { ...request, requestId }, tenantId, createdAt: Date.now(), taken: false,
        settle: (a) => { clearTimeout(timer); this.waiting.delete(requestId); resolve(a); },
      });
    });
  }

  /** Requests for these projects that no runner took yet. Each goes to one runner. */
  take(tenantId: string, projects: readonly string[]): BaseFileRequest[] {
    const out: BaseFileRequest[] = [];
    for (const w of this.waiting.values()) {
      if (w.taken || w.tenantId !== tenantId || !projects.includes(w.request.projectId)) continue;
      w.taken = true;
      out.push(w.request);
    }
    return out;
  }

  answer(tenantId: string, answer: BaseFileAnswer): boolean {
    const w = this.waiting.get(answer.requestId);
    if (!w || w.tenantId !== tenantId || !w.taken) return false;
    w.settle(answer);
    return true;
  }

  /** For a request that names the waiting entry's own allowed paths: the server screens the runner's answer against these, not the runner's. */
  allowedFor(requestId: string): readonly string[] | null {
    return this.waiting.get(requestId)?.request.allowedPaths ?? null;
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
    // The route record of the patch call that produced it: this task's, a patch step, and a call that ran and passed its checks.
    const [record] = await db.select({ payload: schema.clientReports.payload }).from(schema.clientReports).where(and(
      eq(schema.clientReports.tenantId, tenantId), eq(schema.clientReports.projectId, projectId), eq(schema.clientReports.kind, 'route'), eq(schema.clientReports.subjectKind, 'task'),
      eq(schema.clientReports.subjectId, taskId), sql`${schema.clientReports.payload} ->> 'requestId' = ${p.routeRecordId}`,
    )).limit(1);
    const rec = record?.payload as { stepKind?: unknown; status?: unknown } | undefined;
    if (!rec || rec.stepKind !== 'patch' || rec.status !== 'ok') throw new AppError(409, 'route_record_missing', 'there is no record of where the patch call that produced this proposal ran, so it cannot be accepted');
    const receipt = await withTx(db, (tx) => idempotent(tx, { tenantId, projectId, key: `proposal.accept:${taskId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
      const r = await acceptProposal({ db, now }, { tenantId, projectId, taskId }, { proposal: p, acceptedBy: uid }, tx);
      if (r.ok) return r.value;
      if (r.error.reason === 'task_not_found') throw new AppError(404, 'task_not_found', 'no such task');
      if (r.error.reason === 'task_not_applicable') throw new AppError(409, 'task_not_applicable', 'the task is not waiting to start, so a change cannot be applied to it now', { reason: r.error.reason });
      if (r.error.reason === 'proposal_already_accepted') throw new AppError(409, 'proposal_already_accepted', 'this proposal was already accepted', { reason: r.error.reason });
      if (r.error.reason === 'stale_revision') throw new AppError(409, 'stale_revision', 'the task has a newer revision; propose the change again', { reason: r.error.reason });
      throw new AppError(r.error.status, 'proposal_refused', `the proposal did not pass the server's checks: ${r.error.reason}`, { reason: r.error.reason });
    }));
    return reply.code(201).send(receipt);
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
    const paths = (body.paths ?? spec.allowedPaths).map((p) => p.replace(/\/+$/, ''));
    if (paths.length === 0) return { taskId, revision: task.revision, baseSha: spec.baseSha, files: [], omitted: [] };
    if (paths.length > BASE_FILE_LIMITS.requestPaths) throw new AppError(400, 'invalid_request', `at most ${BASE_FILE_LIMITS.requestPaths} paths`);
    const outside = paths.find((p) => baseFileIssue(p, spec.allowedPaths) !== null);
    if (outside !== undefined) throw new AppError(422, 'invalid_request', 'a path is outside the task\'s allowed paths, reserved, or a credentials file', { reason: baseFileIssue(outside, spec.allowedPaths) });
    const answer = await relay.ask(tenantId, { projectId, baseSha: spec.baseSha, paths, allowedPaths: [...spec.allowedPaths] });
    if (answer === null) throw new AppError(504, 'files_unavailable', 'no runner with this project\'s checkout answered in time, so the files could not be read');
    return { taskId, revision: task.revision, baseSha: spec.baseSha, ...screenBaseFiles(answer, spec.allowedPaths) };
  });

  app.post('/v1/runners/files/poll', { onRequest: [ctx.runner] }, async (req) => {
    const runner = runnerOf(req);
    parseBody(FilePollSchema, req.body);
    if (relay.size === 0) return { requests: [] };
    const [row] = await db.select({ projects: schema.runners.configuredProjects }).from(schema.runners).where(and(eq(schema.runners.tenantId, runner.tenantId), eq(schema.runners.runnerId, runner.runnerId)));
    return { requests: relay.take(runner.tenantId, (row?.projects as string[] | null) ?? []) };
  });

  app.post('/v1/runners/files/answer', { onRequest: [ctx.runner], bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const runner = runnerOf(req);
    const answer = parseBody(BaseFileAnswerSchema, req.body);
    const allowed = relay.allowedFor(answer.requestId);
    if (allowed === null || !relay.answer(runner.tenantId, answer)) throw new AppError(404, 'file_request_not_found', 'no such file request is waiting');
    return { accepted: true };
  });
}
