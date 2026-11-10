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

/** `bench_<creation time, base 36>_<random>`: the age is in the name, so a stale schema can be found without any other record. */
export function benchSchemaName(createdAtMs: number = Date.now()): string {
  return `bench_${createdAtMs.toString(36)}_${randomBytes(4).toString('hex')}`;
}

export const SWEEP_FLOOR_MS = 2 * 3_600_000;

const BENCH_SCHEMA = /^bench_([0-9a-z]{6,12})_[0-9a-f]{8}$/;

/** A new, migrated schema named by `benchSchemaName`. Only this schema is ever written or dropped. */
export async function freshSchema(databaseUrl: string, onSchema?: (name: string) => void): Promise<FreshSchema> {
  const name = benchSchemaName();
  onSchema?.(name);
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

/**
 * M1: drops `bench_` schemas older than the threshold, as a manual command only (never during a stack run). Refuses anything that is not a
 * `bench_<time>_<random>` name, including the default schema; a `bench_` name whose age it cannot read is left in place.
 */
export async function sweepBenchSchemas(databaseUrl: string, o: { readonly olderThanMs: number; readonly now?: number }): Promise<string[]> {
  // m4: never younger than 2 h, so a schema whose trial could still be running (the 30 min deadline plus setup and teardown) is never dropped.
  if (!(o.olderThanMs >= SWEEP_FLOOR_MS)) throw new Error('the threshold must be at least 2 h');
  const now = o.now ?? Date.now();
  const admin = createDb(databaseUrl, { max: 1 });
  try {
    const rows = await admin.db.execute(sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'bench\_%'`);
    const dropped: string[] = [];
    for (const r of rows) {
      const name = String(r['schema_name']);
      const m = BENCH_SCHEMA.exec(name);
      if (m === null || name === 'public') continue;
      const created = parseInt(m[1]!, 36);
      if (!Number.isFinite(created) || now - created < o.olderThanMs) continue;
      await admin.db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${name} CASCADE`));
      dropped.push(name);
    }
    return dropped;
  } finally {
    await admin.close();
  }
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
  /** Told the schema's name as soon as it exists (tests). */
  readonly onSchema?: (name: string) => void;
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
  const fresh = await freshSchema(o.databaseUrl, o.onSchema);
  try {
    return await stackOn(fresh, o);
  } catch (e) {
    // M1: nothing after the schema exists may leave it, or its pool, behind.
    await fresh.close().catch(() => undefined);
    throw e;
  }
}

async function stackOn(fresh: FreshSchema, o: StackOptions): Promise<Stack> {
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
  try {
    await app.ready();
    await db.insert(schema.projects).values({ tenantId: BENCH_TENANT, projectId, repository: o.repository, defaultBranch: 'main', classification: 'internal' });
  } catch (e) {
    await app.close().catch(() => undefined);
    throw e;
  }
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
