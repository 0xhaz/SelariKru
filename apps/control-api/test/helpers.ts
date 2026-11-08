import { createScheduler } from '@selarikru/workflow';
import { CAPS, POLICY, TENANT, PROJECT, RUN, resetDb, seedTask, setupTestDb, specFor, testClock, type TestClock, type TestDb } from '@selarikru/workflow/test-helpers';
import type { Policy } from '@selarikru/policy';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps, type ControlApiConfig, type TokenVerifier } from '../src/index.ts';

export { PROJECT, RUN, TENANT, resetDb, seedTask, setupTestDb, specFor, testClock };
export type { TestClock, TestDb };

export const OWNER_UID = 'owner_uid_1';
export const OWNER_TOKEN = 'firebase-owner-token';
export const INTRUDER_TOKEN = 'firebase-intruder-token';
export const ORIGIN = 'http://localhost:5173';

/** Test double for the injected interface: the production verifier is exercised in the emulator test. */
export const fakeVerifier: TokenVerifier = {
  async verifyToken(token) {
    if (token === OWNER_TOKEN) return { uid: OWNER_UID };
    if (token === INTRUDER_TOKEN) return { uid: 'someone_else' };
    throw new Error('bad token');
  },
};

export function testConfig(over: Partial<ControlApiConfig> = {}): ControlApiConfig {
  return {
    mode: 'local',
    host: '127.0.0.1',
    port: 0,
    tenantId: TENANT,
    ownerUid: OWNER_UID,
    firebaseProjectId: 'selarikru',
    allowedOrigins: [ORIGIN],
    caps: { ...CAPS },
    pairingCodeTtlSeconds: 600,
    reclassificationGrantTtlSeconds: 86_400,
    expireLeasesIntervalMs: 1000,
    sse: { pollIntervalMs: 20, keepAliveMs: 5000 },
    ...over,
  };
}

export interface Harness {
  app: FastifyInstance;
  clock: TestClock;
  config: ControlApiConfig;
}

export const API_POLICY = { ...POLICY, operations: { assign_replan_tasks: 'allow' } } as const;

export function makeHarness(t: TestDb, over: Partial<ControlApiConfig> = {}, policy: Policy | null = API_POLICY, extra: Partial<AppDeps> = {}): Harness {
  const clock = testClock();
  const config = testConfig(over);
  const scheduler = createScheduler({ db: t.db, now: clock.now, policy: POLICY });
  const app = buildApp({ config, db: t.db, verifier: fakeVerifier, now: clock.now, scheduler, policy: policy ?? undefined, ...extra });
  return { app, clock, config };
}

export const owner = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${OWNER_TOKEN}`, ...extra });
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function post(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = owner()) {
  const res = await app.inject({ method: 'POST', url, payload: payload as object, headers });
  return { status: res.statusCode, body: res.json() as any };
}

/** Raw inject with an optional body, for tests that need the whole response (headers included). */
export function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}) {
  return app.inject(method === 'POST' ? { method, url, payload: {}, headers } : { method, url, headers });
}

export async function get(app: FastifyInstance, url: string, headers: Record<string, string> = owner()) {
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() as any };
}

/** Pair and enrol a runner through the real routes; returns its token. */
export async function enrolRunner(app: FastifyInstance, location: 'local' | 'cloud' = 'local'): Promise<{ runnerId: string; token: string }> {
  const code = await post(app, '/v1/runners/pairing-codes', { location });
  const enrolled = await post(app, '/v1/runners/enroll', {}, bearer(code.body.pairingCode));
  return { runnerId: enrolled.body.runnerId, token: enrolled.body.token };
}

export { CAPS };
