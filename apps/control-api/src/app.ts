import type { HarnessCatalog, VerificationRecord } from '@selarikru/domain';
import type { GitHubPort } from '@selarikru/integrations-github';
import { schema, type Db } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { RecordStoreUnavailableError, type RecordBytes, type Scheduler, type TrustedVerifier } from '@selarikru/workflow';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { bearerToken, RUNNER_TOKEN_PREFIX, sha256Hex, type Principal, type TokenVerifier } from './auth.ts';
import { type ControlApiConfig } from './config.ts';
import { AppError, unauthenticated } from './errors.ts';
import { registerOwnerRoutes } from './routes-owner.ts';
import { registerGithubRoutes } from './routes-github.ts';
import { registerProposalRoutes } from './routes-proposals.ts';
import { registerOnboardingRoutes } from './routes-onboarding.ts';
import type { PipelineDrivers, ReadinessProbes } from './onboarding-readiness.ts';
import type { PlanConfigSource } from './proposals.ts';
import { registerRunnerRoutes } from './routes-runner.ts';
import { registerEventStream } from './sse.ts';
import { ControlHub, DEFAULT_CONTROL_LIMITS, registerControlRoutes, type ControlLimits } from './control.ts';
import { registerTerminalRoutes, TerminalHub } from './terminal.ts';

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

export interface GithubDeps {
  /** Registers `POST /v1/webhooks/github`. The secret comes from configuration, never a request. */
  readonly webhookSecret?: string | undefined;
  /** Registers the owner route that opens a run's draft PR. The target repository still comes from the project row. */
  readonly pullRequests?: {
    readonly port: GitHubPort;
    /** Local source repository that holds the candidate commits. */
    readonly repoPath: string;
    /** The authoritative live record for a candidate (the verifier's `loadValidRecord`). */
    readonly loadRecord: (key: { tenantId: string; projectId: string; sha: string }) => Promise<VerificationRecord | null>;
  } | undefined;
}

export interface AppDeps {
  readonly config: ControlApiConfig;
  readonly db: Db;
  readonly verifier: TokenVerifier;
  readonly now: () => Date;
  readonly scheduler: Scheduler;
  /** Project policy, already loaded. Absent policy denies every policy-gated command. */
  readonly policy: Policy | undefined;
  /** What this build's harness adapters declare. Narrowed by runner reports before anything is offered. Absent: no model can be assigned and no claim can start. */
  readonly catalog?: HarnessCatalog | undefined;
  /** Server-side source of project plan settings. Absent or unknown project blocks proposal review. */
  readonly planConfig?: PlanConfigSource | undefined;
  /** The bar evidence is held to. Absent: nothing can be trusted, so no criterion counts as verified and no failure can be quoted. */
  readonly evidence?: {
    /** The trusted hashes of this build. Cached by the caller: the snapshot reads them every refresh. */
    readonly trusted: () => TrustedVerifier;
    /** Reads record bytes for the evidence report, so a wiped store reads the same there as on the pull-request route. */
    readonly artifacts: RecordBytes;
    /** The verifier's `loadValidRecord`. */
    readonly loadRecord: (key: { tenantId: string; projectId: string; sha: string }) => Promise<VerificationRecord | null>;
  } | undefined;
  /** GitHub webhook settings. Absent: the webhook route is not registered. The secret comes from configuration, never a request. */
  readonly github?: GithubDeps | undefined;
  /** The target's current tip, wherever merges really land. Absent: nothing can say whether main has moved, so nothing is allowed on that ground. */
  readonly tipOf?: ((project: { readonly repository: string; readonly target: string }) => Promise<string>) | undefined;
  /** Trusted checks for onboarding readiness. Absent, as on the demo stack: repository and GitHub checks report unknown, so nothing can reach `ready`. */
  readonly readiness?: ReadinessProbes | undefined;
  /** Whether the assembly and verification drivers run in this process. Absent: nothing can say, and readiness reports unknown. */
  readonly drivers?: (() => PipelineDrivers) | undefined;
  /** Fastify's logger. Default off. */
  readonly logger?: FastifyServerOptions['logger'];
  /** Live output. Injected by tests to shrink its limits; otherwise one is created here. */
  readonly terminal?: TerminalHub | undefined;
  /** Shrunk by tests. */
  readonly controlLimits?: ControlLimits | undefined;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AppContext extends AppDeps {
  readonly owner: Guard;
  readonly runner: Guard;
  readonly enroll: Guard;
  readonly corsHeaders: (origin: string | null) => Record<string, string>;
  readonly openStreams: Set<() => void>;
  /** Set once shutdown began, so a stream that was still being set up closes instead of holding the server open. */
  readonly lifecycle: { closing: boolean };
  /** Live worker output. Never domain state: it lives only in this process. */
  readonly terminal: TerminalHub;
  /** Control sessions: a person typing into one attempt's sandbox. */
  readonly control: ControlHub;
}

const RUNNER_SEEN_WRITE_MS = 5_000;
const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** SQLSTATEs where Postgres rolled the transaction back to let another finish: `deadlock_detected` and `serialization_failure`. */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

/** True when the error, or one it wraps (drizzle puts the driver's error in `cause`), carries a retryable SQLSTATE. */
export function isRetryableConflict(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) return true;
  }
  return false;
}

function hostName(header: string | undefined): string {
  const h = (header ?? '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, verifier } = deps;
  const app = Fastify({ exposeHeadRoutes: false, logger: deps.logger ?? false, bodyLimit: 1_000_000 });
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
    // A failed read says nothing about the record: nothing may be decided from it, and the caller can try again.
    if (error instanceof RecordStoreUnavailableError) return reply.code(503).send({ error: { code: 'record_store_unavailable', message: 'the verification record store could not be read; try again' } });
    // Postgres broke a deadlock or a serialization conflict by rolling this transaction back: nothing was recorded, and the same request can simply go again.
    if (isRetryableConflict(error)) return reply.code(503).send({ error: { code: 'transaction_conflict', message: 'another change was being written at the same moment, so nothing was recorded; try again' } });
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'malformed request' } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } }));

  /** The check behind a runner token, wherever it arrives. */
  const verifyRunnerToken = async (token: string): Promise<{ runnerId: string; tenantId: string; location: 'local' | 'cloud' } | null> => {
    if (!token.startsWith(RUNNER_TOKEN_PREFIX)) return null;
    const [row] = await db.select().from(schema.runners).where(and(eq(schema.runners.tokenHash, sha256Hex(token)), eq(schema.runners.tenantId, config.tenantId), isNull(schema.runners.revokedAt)));
    return row ? { runnerId: row.runnerId, tenantId: row.tenantId, location: row.location === 'cloud' ? 'cloud' : 'local' } : null;
  };

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
    // The freshness signal: every authenticated runner call counts as seen. Claims arrive at poll rate, so an update is written at most once per interval.
    const seenAt = deps.now();
    await db.update(schema.runners).set({ lastSeenAt: seenAt }).where(and(eq(schema.runners.tenantId, row.tenantId), eq(schema.runners.runnerId, row.runnerId), or(isNull(schema.runners.lastSeenAt), lt(schema.runners.lastSeenAt, new Date(seenAt.getTime() - RUNNER_SEEN_WRITE_MS)))));
    req.principal = { kind: 'runner', runnerId: row.runnerId, tenantId: row.tenantId, location: row.location === 'cloud' ? 'cloud' : 'local' };
  };

  // Enrolment is authenticated by the pairing code alone; the route itself consumes it.
  const enroll: Guard = async (req) => {
    if (!bearerToken(req.headers.authorization)) throw unauthenticated('a pairing code is required');
  };

  const terminal = deps.terminal ?? new TerminalHub(() => deps.now().getTime());
  terminal.startSweeper();
  const control = new ControlHub(db, { config, now: deps.now, policy: deps.policy, terminal }, verifyRunnerToken, deps.controlLimits ?? DEFAULT_CONTROL_LIMITS);
  control.attach(app.server, (host) => config.mode !== 'local' || ALLOWED_LOCAL_HOSTS.has(hostName(host)), origins);
  app.addHook('onReady', async () => { await control.reapOrphans().catch(() => undefined); });
  const ctx: AppContext = { ...deps, owner, runner, enroll, corsHeaders, openStreams: new Set(), lifecycle: { closing: false }, terminal, control };
  registerOwnerRoutes(app, ctx);
  registerProposalRoutes(app, ctx);
  registerOnboardingRoutes(app, ctx);
  registerRunnerRoutes(app, ctx);
  registerEventStream(app, ctx);
  registerTerminalRoutes(app, ctx);
  registerControlRoutes(app, ctx);
  if (deps.github) registerGithubRoutes(app, ctx, deps.github);

  // Before the HTTP server stops listening: a hijacked SSE response would otherwise keep close() waiting forever, and a restart would hang behind its own clients.
  app.addHook('preClose', async () => {
    ctx.lifecycle.closing = true;
    for (const close of [...ctx.openStreams]) close();
    terminal.stop();
    control.stop();
  });
  return app;
}
