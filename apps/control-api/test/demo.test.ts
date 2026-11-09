import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@selarikru/persistence';
import { loadPolicyFile } from '@selarikru/policy/load';
import { createScheduler } from '@selarikru/workflow';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, createFirebaseVerifier, loadPlanConfigFile } from '../src/index.ts';
import { startAuthEmulator, type AuthEmulator } from './auth-emulator.ts';
import { DEMO, assertEmulatorHost, ensureEmulatorAccount, seedDemo, writeDemoFiles } from '../src/demo.ts';
import { TEST_CATALOG, resetDb, setupTestDb, testClock, testConfig, type TestDb } from './helpers.ts';

describe('demo plan config', () => {
  it('uses plain allowedPaths prefixes, no globs, so the local runner accepts them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-cfg-'));
    const { planConfigFile } = writeDemoFiles(dir, { tenantId: 'tenant_local' });
    const cfg = JSON.parse(readFileSync(planConfigFile, 'utf8')) as { projects: Record<string, { allowedPaths: string[] }> };
    for (const p of Object.values(cfg.projects)) for (const a of p.allowedPaths) expect(a).not.toMatch(/[*?[\]{}]/);
  });
});

describe('demo seed', () => {
  let t: TestDb;
  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });

  it('is idempotent: two seeds leave one project and one run with the stable IDs and budget', async () => {
    await resetDb(t.db);
    await seedDemo(t.db, { tenantId: 'tenant_local' });
    await seedDemo(t.db, { tenantId: 'tenant_local' });
    const projects = await t.db.select().from(schema.projects).where(eq(schema.projects.projectId, DEMO.projectId));
    const runs = await t.db.select().from(schema.runs).where(eq(schema.runs.runId, DEMO.runId));
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ classification: 'internal' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.budget).toEqual({ limitUsd: DEMO.budgetLimitUsd });
    expect(await t.db.select().from(schema.events)).toHaveLength(1);
  });

  it('refuses to run unless a loopback Auth Emulator host is set', () => {
    expect(() => assertEmulatorHost({})).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/);
    expect(() => assertEmulatorHost({ FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com' })).toThrow(/loopback/);
    expect(assertEmulatorHost({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toBe('127.0.0.1:9099');
  });

  it('writes a plan-config (FB-01..FB-08, internal) and a narrow demo policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selarikru-demo-files-'));
    const files = writeDemoFiles(dir, { tenantId: 'tenant_local' });
    const source = loadPlanConfigFile(files.planConfigFile);
    const s = source(DEMO.projectId)!;
    expect(s.allowedRequirementIds).toEqual(['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-05', 'FB-06', 'FB-07', 'FB-08']);
    expect(s.classification).toBe('internal');
    const policy = loadPolicyFile(files.policyFile);
    expect(policy.operations).toEqual({ assign_replan_tasks: 'allow' });
    expect(policy.policyVersion).toBe(s.policyVersion);
  });
});

const hasCli = spawnSync('firebase', ['--version'], { stdio: 'ignore' }).status === 0;
const external = process.env['FIREBASE_AUTH_EMULATOR_HOST'];

// Own project ID, so this file's emulator never shares a hub locator with another test file's. An external emulator (pnpm dev:stack) keeps its own.
const PROJECT_ID = external ? 'selarikru' : 'selarikru-demo-test';

describe.skipIf(!external && !hasCli)('demo smoke (Auth Emulator)', () => {
  let emulator: AuthEmulator | undefined;
  let host = external ?? '';
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
    if (!external) {
      emulator = await startAuthEmulator(PROJECT_ID);
      host = emulator.host;
    }
    for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 300))) {
      try { if ((await fetch(`http://${host}/`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > end) throw new Error('Auth Emulator did not start');
    }
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = host;
  }, 90_000);

  afterAll(async () => {
    emulator?.stop();
    if (!external) delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    await t?.close();
  });

  it('creates the account once, signs in, reviews and accepts a plan through the real API', async () => {
    await resetDb(t.db);
    const a = await ensureEmulatorAccount(host, PROJECT_ID);
    const b = await ensureEmulatorAccount(host, PROJECT_ID);
    expect(a.uid).toBe(DEMO.ownerUid);
    expect(b.uid).toBe(DEMO.ownerUid);
    await seedDemo(t.db, { tenantId: 'tenant_local' });
    const files = writeDemoFiles(mkdtempSync(join(tmpdir(), 'selarikru-demo-smoke-')), { tenantId: 'tenant_local' });

    const signIn = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: DEMO.email, password: DEMO.password, returnSecureToken: true }),
    });
    expect(signIn.ok, `sign-in failed (${signIn.status}): ${signIn.ok ? '' : await signIn.clone().text()}`).toBe(true);
    const { idToken } = (await signIn.json()) as { idToken: string };

    const clock = testClock();
    const policy = loadPolicyFile(files.policyFile);
    const app = buildApp({
      config: testConfig({ tenantId: 'tenant_local', ownerUid: DEMO.ownerUid }), db: t.db, verifier: createFirebaseVerifier({ projectId: PROJECT_ID }),
      now: clock.now, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy }), policy, planConfig: loadPlanConfigFile(files.planConfigFile),
    });
    const headers = { authorization: `Bearer ${idToken}` };
    const review = await app.inject({
      method: 'POST', url: `/v1/runs/${DEMO.runId}/proposals/review`, headers,
      payload: { envelope: { operation: 'draftTaskPlan', status: 'ok', data: { tasks: [{ title: 'Feedback form', description: 'Build it.', requirementIds: ['FB-01'] }] } } },
    });
    expect(review.statusCode, review.body).toBe(200);
    const reviewed = review.json() as { expectedRevision: number; tasks: unknown[] };
    const accept = await app.inject({
      method: 'POST', url: `/v1/runs/${DEMO.runId}/plan-revisions`, headers,
      payload: { expectedRevision: reviewed.expectedRevision, tasks: reviewed.tasks },
    });
    expect(accept.statusCode, accept.body).toBe(201);
    await app.close();
  }, 60_000);
});

