import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema, withTx, type Db } from '@selarikru/persistence';
import { loadDefaultPolicy } from '@selarikru/policy/load';
import { and, eq } from 'drizzle-orm';
import { isLoopbackHost } from './config.ts';
import { writeEvent } from './store.ts';

/**
 * Local demo setup (pnpm dev:demo). Everything here is for the Firebase Auth Emulator and a local database only.
 * The account below exists nowhere else and is not a secret. Nothing here bypasses authentication or validation:
 * the demo owner signs in through the emulator like any user and uses the ordinary API routes.
 */
export const DEMO = {
  /** Fixed emulator UID. dev:demo also configures it as the single owner. */
  ownerUid: 'demo-owner-local',
  email: 'demo-owner@selarikru.invalid',
  password: 'demo-local-only-password',
  projectId: 'proj_demo_local',
  runId: 'run_demo_local',
  /** Local demo budget for the seeded run, in USD. Override with SELARIKRU_DEMO_BUDGET_LIMIT_USD. */
  budgetLimitUsd: 5,
  policyVersion: 'demo-local.1',
  requirementIds: ['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-05', 'FB-06', 'FB-07', 'FB-08'],
} as const;

/** Returns the emulator host, or throws. This is what keeps the script away from real Firebase Auth. */
export function assertEmulatorHost(env: Readonly<Record<string, string | undefined>>): string {
  const host = (env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '').trim();
  if (host === '') throw new Error('FIREBASE_AUTH_EMULATOR_HOST is not set: refusing to create demo accounts outside the Auth Emulator');
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1).replace(/[[\]]/g, '') : host.split(':')[0]!;
  if (!isLoopbackHost(name)) throw new Error(`FIREBASE_AUTH_EMULATOR_HOST must be a loopback host, got "${name}"`);
  return host;
}

const json = { 'content-type': 'application/json' };

/** Creates the demo account with its fixed UID in the Auth Emulator, or confirms it exists. Idempotent. */
export async function ensureEmulatorAccount(host: string, projectId: string): Promise<{ uid: string }> {
  const base = `http://${host}/identitytoolkit.googleapis.com/v1`;
  const signIn = async () => {
    const r = await fetch(`${base}/accounts:signInWithPassword?key=fake-key`, { method: 'POST', headers: json, body: JSON.stringify({ email: DEMO.email, password: DEMO.password, returnSecureToken: true }) });
    return r.ok ? ((await r.json()) as { localId: string }).localId : null;
  };
  let uid = await signIn();
  if (uid === null) {
    // The emulator accepts a caller-chosen localId from an admin ("owner") bearer. It exists only in the emulator.
    const r = await fetch(`${base}/projects/${projectId}/accounts`, {
      method: 'POST', headers: { ...json, authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: DEMO.ownerUid, email: DEMO.email, password: DEMO.password, emailVerified: true }),
    });
    if (!r.ok) throw new Error(`could not create the demo emulator account (${r.status}): ${await r.text()}`);
    uid = await signIn();
  }
  if (uid !== DEMO.ownerUid) {
    throw new Error(`the emulator already has ${DEMO.email} under a different UID (${uid ?? 'none'}); restart the emulator to clear it`);
  }
  return { uid };
}

/** Inserts the demo project and run when absent. Never updates or deletes. Safe to repeat. */
export async function seedDemo(db: Db, opts: { tenantId: string; budgetLimitUsd?: number }): Promise<{ created: boolean }> {
  const budgetLimitUsd = opts.budgetLimitUsd ?? DEMO.budgetLimitUsd;
  return withTx(db, async (tx) => {
    await tx.insert(schema.projects).values({
      tenantId: opts.tenantId, projectId: DEMO.projectId, repository: 'local/feedback-board-demo', defaultBranch: 'main', classification: 'internal',
    }).onConflictDoNothing();
    const existing = await tx.select().from(schema.runs).where(and(eq(schema.runs.tenantId, opts.tenantId), eq(schema.runs.projectId, DEMO.projectId), eq(schema.runs.runId, DEMO.runId)));
    if (existing.length > 0) return { created: false };
    await tx.insert(schema.runs).values({ tenantId: opts.tenantId, projectId: DEMO.projectId, runId: DEMO.runId, lifecycle: 'planning', budget: { limitUsd: budgetLimitUsd } });
    await writeEvent(tx, new Date(), {
      projectId: DEMO.projectId, runId: DEMO.runId, taskId: DEMO.runId, aggregateRevision: 1, type: 'run.created',
      actor: { kind: 'human', id: DEMO.ownerUid },
      payload: { title: 'Local demo run', budget: { status: 'set', limitUsd: budgetLimitUsd } },
    });
    return { created: true };
  });
}

/** Writes the plan-config and a narrow demo policy into `dir` (git-ignored). `policies/default.json` is not touched. */
export function writeDemoFiles(dir: string, _opts: { tenantId: string }): { planConfigFile: string; policyFile: string } {
  mkdirSync(dir, { recursive: true });
  const base = loadDefaultPolicy();
  const timeoutSeconds = base.limits?.attemptTimeoutSeconds;
  if (timeoutSeconds === undefined) throw new Error('policies/default.json has no attemptTimeoutSeconds');
  // Only what the flow needs: the plan-revision route checks assign_replan_tasks. Everything else stays unset and fails closed.
  const policy = { ...base, policyVersion: DEMO.policyVersion, operations: { assign_replan_tasks: 'allow' } };
  const planConfig = {
    projects: {
      [DEMO.projectId]: {
        boardId: 'feedback-board', role: 'backend', baseSha: 'demo-local-base', allowedPaths: ['fixtures/feedback-board/**'],
        classification: 'internal', policyVersion: DEMO.policyVersion, execution: 'local', inferencePolicyId: 'demo-local',
        limits: { maxAttempts: 3, timeoutSeconds, maxCostUsd: 1 },
        allowedRequirementIds: [...DEMO.requirementIds],
        // Feedback Board has no login, voting, payments, email or AI features.
        forbiddenMandatoryScope: ['login', 'voting', 'payments', 'email'],
      },
    },
  };
  const planConfigFile = join(dir, 'plan-config.json');
  const policyFile = join(dir, 'policy.json');
  writeFileSync(planConfigFile, `${JSON.stringify(planConfig, null, 2)}\n`);
  writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  return { planConfigFile, policyFile };
}
