import { randomBytes } from 'node:crypto';
import { LocalDiskArtifactStore } from '@selarikru/artifacts';
import { buildApp, parseConfig, startLeaseExpiryDriver, type LeaseExpiryDriver } from '@selarikru/control-api';
import type { HarnessCatalog, RunnerHarnessReport } from '@selarikru/protocol';
import { createDb, migrate, schema, sql, type Db } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { createScheduler } from '@selarikru/workflow';
import { startAssemblyDriver, type AssemblyDriver } from '../../../../services/verifier/src/assembly-driver.ts';
import { startVerificationDriver, type VerificationDriver } from '../../../../services/verifier/src/driver.ts';
import type { VerifierRunner } from '../../../../services/verifier/src/service.ts';

/**
 * One trial's own copy of the product: a fresh PostgreSQL schema, the real control API over it, its lease-expiry sweep,
 * and the real assembly and verification drivers, all stamping time from the trial's monotonic server clock. Nothing is
 * shared between trials: the schema, the project, the run, the runner enrolment and the owner credential are all new,
 * and `close` drops the schema.
 *
 * The API is driven in process (`fetch` over Fastify's inject), so a trial opens no port and cannot reach, or be
 * reached by, any other stack on the machine.
 */

type FastifyInstance = ReturnType<typeof buildApp>;

export const BENCH_TENANT = 'benchmark';
const API_BASE = 'http://127.0.0.1';

export interface FreshSchema {
  readonly db: Db;
  readonly name: string;
  close(): Promise<void>;
}

/** A new, migrated schema named `bench_<random>`. Only this schema is ever written or dropped. */
export async function freshSchema(databaseUrl: string): Promise<FreshSchema> {
  const name = `bench_${randomBytes(6).toString('hex')}`;
  const admin = createDb(databaseUrl, { max: 1 });
  try {
    await admin.db.execute(sql.raw(`CREATE SCHEMA ${name}`));
  } catch (e) {
    await admin.close();
    throw e;
  }
  const { db, close } = createDb(databaseUrl, { max: 8, searchPath: name });
  try {
    await migrate(db);
  } catch (e) {
    await close();
    await admin.db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${name} CASCADE`)).catch(() => undefined);
    await admin.close();
    throw e;
  }
  return {
    db, name,
    async close() {
      await close().catch(() => undefined);
      try {
        await admin.db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${name} CASCADE`));
      } finally {
        await admin.close();
      }
    },
  };
}

/** `fetch` answered by the app itself, so the runner's real HTTP client drives the real routes with no socket. */
export function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(res.statusCode === 204 ? null : res.rawPayload, { status: res.statusCode, headers: res.headers as Record<string, string> });
  }) as typeof fetch;
}

export interface StackOptions {
  readonly databaseUrl: string;
  /** The trial's own source repository (a fresh clone at the starter SHA). Candidates are assembled into it. */
  readonly repoPath: string;
  readonly artifactDir: string;
  readonly integrationDir: string;
  readonly verificationDir: string;
  readonly now: () => Date;
  readonly catalog: HarnessCatalog;
  readonly policy: Policy;
  readonly verifierRunner: VerifierRunner;
  readonly verifierHost: string;
  readonly repository: string;
  readonly attemptTimeoutSeconds: number;
  readonly driverIntervalMs: number;
}

export interface Stack {
  readonly db: Db;
  readonly schemaName: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly app: FastifyInstance;
  readonly fetch: typeof fetch;
  readonly apiBase: string;
  /** Owner routes, with this trial's own owner credential. */
  owner(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Pairs and enrols one runner through the real routes. */
  enrolRunner(location: 'local' | 'cloud', harnesses: readonly RunnerHarnessReport[]): Promise<string>;
  startDrivers(): void;
  close(): Promise<void>;
}

export async function openStack(o: StackOptions): Promise<Stack> {
  const fresh = await freshSchema(o.databaseUrl);
  const { db } = fresh;
  const ownerUid = `bench-owner-${randomBytes(4).toString('hex')}`;
  const ownerToken = randomBytes(24).toString('hex');
  const projectId = `proj_bench_${randomBytes(4).toString('hex')}`;
  const config = parseConfig({
    mode: 'local', host: '127.0.0.1', port: 0, tenantId: BENCH_TENANT, ownerUid, firebaseProjectId: 'selarikru', allowedOrigins: [],
    caps: { maxConcurrentTotal: 2, attemptTimeoutSeconds: o.attemptTimeoutSeconds, maxInfraRetries: 3, infraRetryBackoffSeconds: 10, infraRetryBackoffMaxSeconds: 40 },
    pairingCodeTtlSeconds: 600, reclassificationGrantTtlSeconds: 86_400, expireLeasesIntervalMs: 1000, sse: { pollIntervalMs: 500, keepAliveMs: 15_000 },
  });
  const verifier = { async verifyToken(token: string) { if (token === ownerToken) return { uid: ownerUid }; throw new Error('bad token'); } };
  const scheduler = createScheduler({ catalog: o.catalog, db, now: o.now, policy: o.policy });
  const app = buildApp({ config, db, verifier, now: o.now, scheduler, policy: o.policy, catalog: o.catalog });
  await app.ready();
  await db.insert(schema.projects).values({ tenantId: BENCH_TENANT, projectId, repository: o.repository, defaultBranch: 'main', classification: 'internal' });
  const fetchImpl = injectFetch(app);

  const owner = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await app.inject({ method, url: path, headers: { authorization: `Bearer ${ownerToken}` }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) });
    return { status: res.statusCode, body: res.json() as any };
  };

  let expiry: LeaseExpiryDriver | null = null;
  let assembly: AssemblyDriver | null = null;
  let verification: VerificationDriver | null = null;
  return {
    db, schemaName: fresh.name, tenantId: BENCH_TENANT, projectId, app, fetch: fetchImpl, apiBase: API_BASE, owner,
    async enrolRunner(location, harnesses) {
      const code = await owner('POST', '/v1/runners/pairing-codes', { location });
      if (code.status !== 201 && code.status !== 200) throw new Error(`pairing code refused (${code.status})`);
      const res = await app.inject({ method: 'POST', url: '/v1/runners/enroll', payload: { harnesses }, headers: { authorization: `Bearer ${code.body.pairingCode}` } });
      if (res.statusCode >= 300) throw new Error(`runner enrolment refused (${res.statusCode})`);
      return (res.json() as { token: string }).token;
    },
    startDrivers() {
      const artifacts = new LocalDiskArtifactStore(o.artifactDir);
      expiry = startLeaseExpiryDriver({ scheduler, now: o.now, intervalMs: o.driverIntervalMs });
      assembly = startAssemblyDriver({ db, artifacts, tenantId: BENCH_TENANT, repoPath: o.repoPath, workRoot: o.integrationDir, now: o.now, intervalMs: o.driverIntervalMs });
      verification = startVerificationDriver({
        db, artifacts: new LocalDiskArtifactStore(o.artifactDir), tenantId: BENCH_TENANT, repoPath: o.repoPath, workRoot: o.verificationDir, now: o.now,
        runner: o.verifierRunner, verifier: { kind: 'verifier', id: `verifier:${o.verifierHost}` }, host: o.verifierHost, intervalMs: o.driverIntervalMs,
      });
    },
    async close() {
      await Promise.allSettled([expiry?.stop(), assembly?.stop(2_000), verification?.stop(2_000)]);
      await app.close().catch(() => undefined);
      await fresh.close();
    },
  };
}
