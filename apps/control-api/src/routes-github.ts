import { handleGithubWebhook } from '@selarikru/integrations-github';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.ts';

/**
 * `POST /v1/webhooks/github`. Authenticated by the HMAC signature over the raw request bytes, not by a bearer token. The route lives in
 * an encapsulated scope whose JSON parser keeps the body as a Buffer, so the signature is checked on exactly what GitHub sent.
 * A delivery only queues a hint; the reconciler decides merged state from an authoritative read.
 */
export function registerGithubWebhook(app: FastifyInstance, ctx: AppContext, secret: string): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/v1/webhooks/github', async (req, reply) => {
      const res = await handleGithubWebhook({ rawBody: req.body as Buffer, headers: req.headers }, { db: ctx.db, tenantId: ctx.config.tenantId, secret, now: ctx.now });
      return reply.code(res.status).send(res.body);
    });
  });
}
