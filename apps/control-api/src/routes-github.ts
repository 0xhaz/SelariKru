import { handleGithubWebhook, openReviewablePr, PrNotAllowed } from '@selarikru/integrations-github';
import { evaluate } from '@selarikru/policy';
import type { FastifyInstance } from 'fastify';
import type { AppContext, GithubDeps } from './app.ts';
import { AppError } from './errors.ts';
import { requireRun } from './store.ts';

/**
 * GitHub routes. Neither can merge: the webhook only queues a hint, and the pull-request route opens a DRAFT PR. Merging is a human action on GitHub.
 *
 * - `POST /v1/webhooks/github` is authenticated by the HMAC signature over the raw request bytes, not a bearer token. It lives in an
 *   encapsulated scope whose parsers keep every body as a Buffer, so the signature covers exactly what GitHub sent.
 * - `POST /v1/runs/:id/pull-request` (owner, gated by the `create_draft_pr` policy) pushes the run's verified candidate and opens the draft PR. The repository comes from the
 *   project row; the request carries no target.
 */
export function registerGithubRoutes(app: FastifyInstance, ctx: AppContext, github: GithubDeps): void {
  const secret = github.webhookSecret;
  if (secret) {
    void app.register(async (scope) => {
      const keep = (_req: unknown, body: Buffer, done: (e: Error | null, b?: Buffer) => void): void => done(null, body);
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, keep);
      scope.addContentTypeParser('*', { parseAs: 'buffer' }, keep);
      scope.post('/v1/webhooks/github', async (req, reply) => {
        const res = await handleGithubWebhook({ rawBody: req.body as Buffer, headers: req.headers }, { db: ctx.db, tenantId: ctx.config.tenantId, secret, now: ctx.now });
        return reply.code(res.status).send(res.body);
      });
    });
  }

  const pr = github.pullRequests;
  if (pr) {
    app.post('/v1/runs/:id/pull-request', { onRequest: [ctx.owner] }, async (req, reply) => {
      if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
      const run = await requireRun(ctx.db, ctx.config.tenantId, (req.params as { id: string }).id);
      // Evaluated right before the push and PR creation. An absent policy denies.
      const gate = evaluate({ kind: 'create_draft_pr' }, ctx.policy);
      if (gate.decision !== 'allow') throw new AppError(403, 'policy_denied', 'policy does not allow opening a draft pull request', { reason: gate.reason, decision: gate.decision });
      try {
        const result = await openReviewablePr(
          { tenantId: run.tenantId, projectId: run.projectId, runId: run.runId, repoPath: pr.repoPath },
          { db: ctx.db, port: pr.port, now: ctx.now, loadRecord: (sha) => pr.loadRecord({ tenantId: run.tenantId, projectId: run.projectId, sha }) },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof PrNotAllowed) throw new AppError(409, 'pull_request_not_allowed', e.message, { reason: e.reason, ...e.detail });
        throw e;
      }
    });
  }
}
