import { schema, type Db } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import type { Scheduler } from '@selarikru/workflow';
import { and, eq, isNull } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { bearerToken, RUNNER_TOKEN_PREFIX, sha256Hex, type Principal, type TokenVerifier } from './auth.ts';
import { type ControlApiConfig } from './config.ts';
import { AppError, unauthenticated } from './errors.ts';
import { registerOwnerRoutes } from './routes-owner.ts';
import { registerProposalRoutes } from './routes-proposals.ts';
import type { PlanConfigSource } from './proposals.ts';
import { registerRunnerRoutes } from './routes-runner.ts';
import { registerEventStream } from './sse.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    corsOrigin: string | null;
  }
  interface FastifyInstance {
    /** Every registered route, for tests that must cover them all. */
    routeTable: { method: string; url: string }[];
  }
}

export interface AppDeps {
  readonly config: ControlApiConfig;
  readonly db: Db;
  readonly verifier: TokenVerifier;
  readonly now: () => Date;
  readonly scheduler: Scheduler;
  /** Project policy, already loaded. Absent policy denies every policy-gated command. */
  readonly policy: Policy | undefined;
  /** Server-side source of project plan settings. Absent or unknown project blocks proposal review. */
  readonly planConfig?: PlanConfigSource | undefined;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AppContext extends AppDeps {
  readonly owner: Guard;
  readonly runner: Guard;
  readonly enroll: Guard;
  readonly corsHeaders: (origin: string | null) => Record<string, string>;
  readonly openStreams: Set<() => void>;
}

const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostName(header: string | undefined): string {
  const h = (header ?? '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, verifier } = deps;
  const app = Fastify({ exposeHeadRoutes: false, logger: false, bodyLimit: 1_000_000 });
  app.routeTable = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) app.routeTable.push({ method, url: r.url });
  });
  app.decorateRequest('principal', null);
  app.decorateRequest('corsOrigin', null);

  const origins = new Set(config.allowedOrigins);
  const corsHeaders = (origin: string | null): Record<string, string> =>
    origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'authorization, content-type, last-event-id',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-max-age': '600',
          vary: 'Origin',
        }
      : {};

  // Browser-facing checks run before authentication, so a hostile page learns nothing from an auth error.
  app.addHook('onRequest', async (req, reply) => {
    if (config.mode === 'local' && !ALLOWED_LOCAL_HOSTS.has(hostName(req.headers.host))) {
      throw new AppError(403, 'host_not_allowed', 'unexpected Host header');
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin !== null && !origins.has(origin)) throw new AppError(403, 'origin_not_allowed', 'origin is not on the allowlist');
    if (origin === null && req.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(403, 'origin_not_allowed', 'cross-site browser requests are not accepted');
    }
    req.corsOrigin = origin;
    if (req.method === 'OPTIONS') return reply.code(204).headers(corsHeaders(origin)).send();
    return undefined;
  });
  app.addHook('onSend', async (req, reply) => {
    if (req.corsOrigin) void reply.headers(corsHeaders(req.corsOrigin));
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'malformed request' } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } }));

  const owner: Guard = async (req) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthenticated();
    if (token.startsWith(RUNNER_TOKEN_PREFIX)) throw new AppError(403, 'wrong_principal_type', 'a runner credential cannot call owner routes');
    let uid: string;
    try {
      uid = (await verifier.verifyToken(token)).uid;
    } catch {
      throw new AppError(401, 'invalid_token', 'token could not be verified');
    }
    if (uid !== config.ownerUid) throw new AppError(403, 'not_owner', 'this account is not the owner');
    req.principal = { kind: 'owner', uid };
  };

  const runner: Guard = async (req) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthenticated();
    if (!token.startsWith(RUNNER_TOKEN_PREFIX)) {
      // A token that verifies as a real user is the wrong kind of credential; anything else is simply invalid.
      const verified = await verifier.verifyToken(token).then(() => true, () => false);
      if (verified) throw new AppError(403, 'wrong_principal_type', 'an owner credential cannot call runner routes');
      throw new AppError(401, 'invalid_token', 'token is not valid');
    }
    const rows = await db
      .select()
      .from(schema.runners)
      .where(and(eq(schema.runners.tokenHash, sha256Hex(token)), eq(schema.runners.tenantId, config.tenantId), isNull(schema.runners.revokedAt)));
    const row = rows[0];
    if (!row) throw new AppError(401, 'invalid_token', 'token is not valid');
    req.principal = { kind: 'runner', runnerId: row.runnerId, tenantId: row.tenantId, location: row.location === 'cloud' ? 'cloud' : 'local' };
  };

  // Enrolment is authenticated by the pairing code alone; the route itself consumes it.
  const enroll: Guard = async (req) => {
    if (!bearerToken(req.headers.authorization)) throw unauthenticated('a pairing code is required');
  };

  const ctx: AppContext = { ...deps, owner, runner, enroll, corsHeaders, openStreams: new Set() };
  registerOwnerRoutes(app, ctx);
  registerProposalRoutes(app, ctx);
  registerRunnerRoutes(app, ctx);
  registerEventStream(app, ctx);

  app.addHook('onClose', async () => {
    for (const close of [...ctx.openStreams]) close();
  });
  return app;
}
