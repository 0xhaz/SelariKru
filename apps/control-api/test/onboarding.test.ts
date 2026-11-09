import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VerificationRecordSchema } from '@selarikru/domain';
import { schema } from '@selarikru/persistence';
import { OnboardingViewSchema } from '@selarikru/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { loadValidRecord } from '../../../services/verifier/src/service.ts';
import { createGitProbes, ghRepoAccess, readinessProbesFromEnv, seedDemo, type ReadinessProbes } from '../src/index.ts';
import { PLAN_TASK_ROLES, type TaskSpec } from '@selarikru/domain';
import { renderTaskFile } from '../../local-runner/src/attempt.ts';
import { PLACEMENT_MODES } from '../../../services/workflow/src/placement.ts';
import { hashTree } from '../../../services/verifier/src/hashing.ts';
import { API_POLICY, ORIGIN, TENANT, bearer, enrolRunner, get, makeHarness, owner, post, setupTestDb, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
const CHECKOUT = '/srv/source';
const SHA = 'a'.repeat(40);
/** A checker that sees a healthy machine. Each test breaks one fact. */
const goodProbes = (over: Partial<ReadinessProbes> = {}): ReadinessProbes => ({
  sourceCheckout: CHECKOUT,
  git: async () => ({ checkout: { ok: true, reason: 'ok' }, identity: { status: 'passed', reason: 'origin matches' }, base: { sha: SHA, reason: 'resolved' }, stack: { status: 'passed', reason: 'frozen contract' } }),
  githubAccess: async () => ({ status: 'passed', reason: 'can push' }),
  ...over,
});

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.db.execute(sql`TRUNCATE project_onboardings, project_blueprints, onboarding_readiness_passes, onboarding_receipts, projects, project_sequences, runs, runners, operation_receipts, events, outbox CASCADE`); });

const DRIVERS_ON = () => ({ assembly: true, verification: true });
const NO_ASSUMPTIONS = { users: { value: null, confidence: 'unknown' }, traffic: { value: null, confidence: 'unknown' }, storage: { value: null, confidence: 'unknown' }, aiUsage: { value: null, confidence: 'unknown' } };
const costBody = (budget: number | null, over: object = {}) => ({ agentBudgetUsd: budget, effort: [], production: [], agentUsage: [], assumptions: NO_ASSUMPTIONS, ...over });
const POLICY_WITH_PR = { ...API_POLICY, operations: { ...API_POLICY.operations, create_draft_pr: 'allow' } } as const;
const harness = (probes: ReadinessProbes | undefined = goodProbes()): Harness => makeHarness(t, {}, POLICY_WITH_PR, { readiness: probes, drivers: DRIVERS_ON, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
const goal = (over = {}) => ({ name: 'Clinic queue', idea: 'Patients see their place in the queue', audience: 'Small clinics', firstOutcome: 'A patient sees their position', ...over });
const k = (s: string) => `key:${s.replace(/\//g, "-")}:${Math.random().toString(36).slice(2)}`;

async function start(h: Harness, over = {}) {
  const r = await post(h.app, '/v1/onboarding', { idempotencyKey: k('create'), goal: goal(over) });
  expect(r.status).toBe(201);
  return r.body;
}
const write = async (h: Harness, id: string, path: string, body: object, rev: number) => post(h.app, `/v1/onboarding/${id}/${path}`, { idempotencyKey: k(path), expectedRevision: rev, ...body });

/** Through the real routes up to the readiness step, in the order the browser sends them: source, focus, draft, accept, cost plan, execution, connection. */
async function configured(h: Harness, focus: readonly string[] = ['saas_web'], budget: number | null = 25) {
  let v = await start(h);
  for (const [path, body] of [
    ['answers', { source: { kind: 'new' } }],
    ['answers', { focus: { tracks: focus } }],
    ['blueprints', {}],
  ] as const) {
    const r = await write(h, v.projectId, path, body, v.revision);
    expect(r.status).toBe(200);
    v = r.body;
  }
  const accepted = await write(h, v.projectId, 'blueprint/accept', { version: v.blueprint.version }, v.revision);
  expect(accepted.status).toBe(200);
  v = accepted.body;
  for (const [path, body] of [
    ['cost-plan', costBody(budget)],
    ['execution', { execution: 'local', inference: 'PREFER_ON_DEVICE' }],
    ['connections', { repository: 'acme/clinic', defaultBranch: 'main' }],
  ] as const) {
    const r = await write(h, v.projectId, path, body, v.revision);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    v = r.body;
  }
  return v;
}
/** A runner that has been paired and has said it holds a checkout for this project. */
async function reportProjects(h: Harness, token: string, projects: readonly string[]) {
  const r = await post(h.app, '/v1/runners/claim', { projects }, bearer(token));
  expect(r.status).toBe(200);
}
async function configuredWithRunner(h: Harness, focus: readonly string[] = ['saas_web'], budget: number | null = 25) {
  const runner = await enrolRunner(h.app);
  const v = await configured(h, focus, budget);
  await reportProjects(h, runner.token, [v.projectId]);
  return v;
}
const check = async (h: Harness, v: { projectId: string; revision: number }) => post(h.app, `/v1/onboarding/${v.projectId}/readiness`, { expectedRevision: v.revision });
const statusOf = (view: any, id: string) => view.readiness.checks.find((c: any) => c.id === id)?.status;
const activate = async (h: Harness, v: any, key = k('activate')) => post(h.app, `/v1/onboarding/${v.projectId}/activate`, { idempotencyKey: key, expectedRevision: v.revision, blueprintVersion: v.blueprint.version });
const countProjects = async () => (await t.db.select().from(schema.projects).where(eq(schema.projects.tenantId, TENANT))).length;
const countOnboardings = async () => (await t.db.select().from(schema.projectOnboardings)).length;
const countRuns = async (projectId: string) => (await t.db.select().from(schema.runs).where(and(eq(schema.runs.tenantId, TENANT), eq(schema.runs.projectId, projectId)))).length;

describe('key behaviours', () => {
  it('repeated submit creates one project', async () => {
    const h = harness();
    const idempotencyKey = k('same');
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => post(h.app, '/v1/onboarding', { idempotencyKey, goal: goal() })));
    expect([a!.status, b!.status, c!.status]).toEqual([201, 201, 201]);
    expect(new Set([a!.body.projectId, b!.body.projectId, c!.body.projectId]).size).toBe(1);
    expect(await countOnboardings()).toBe(1);

    // A different key for the same project (a second tab) points at the first one.
    const again = await post(h.app, '/v1/onboarding', { idempotencyKey: k('other'), goal: goal() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('project_already_started');
    expect(again.body.error.details.projectId).toBe(a!.body.projectId);

  });

  it('repeated submit of the connection step creates one project row', async () => {
    const h = harness();
    const v = await configured(h);
    expect(await countProjects()).toBe(1);
    const again = await write(h, v.projectId, 'connections', { repository: 'acme/clinic', defaultBranch: 'main' }, v.revision);
    expect(again.status).toBe(200);
    expect(await countProjects()).toBe(1);
    // The same idempotency key replays the receipt and does not write again.
    const key = k('replay');
    const first = await post(h.app, `/v1/onboarding/${v.projectId}/connections`, { idempotencyKey: key, expectedRevision: again.body.revision, repository: 'acme/clinic', defaultBranch: 'main' });
    const revision = first.body.revision;
    const replay = await post(h.app, `/v1/onboarding/${v.projectId}/connections`, { idempotencyKey: key, expectedRevision: again.body.revision, repository: 'acme/clinic', defaultBranch: 'main' });
    expect(replay.status).toBe(200);
    expect(replay.body.revision).toBe(revision);
  });

  it('resume does not replay side effects', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    expect(v.state).toBe('ready');
    const key = k('activate');
    const first = await activate(h, v, key);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('activated');
    const runId = first.body.firstRunId;
    expect(runId).toBeTruthy();

    // A resume re-sends the same key, or re-opens the page: neither starts a second run, writes a second event, or moves state.
    const replay = await activate(h, v, key);
    expect(replay.status).toBe(200);
    expect(replay.body.firstRunId).toBe(runId);
    const opened = await get(h.app, `/v1/onboarding/${v.projectId}`);
    expect(opened.body.state).toBe('activated');
    expect(opened.body.firstRunId).toBe(runId);
    expect(await countRuns(v.projectId)).toBe(1);
    const events = await t.db.select().from(schema.events).where(eq(schema.events.projectId, v.projectId));
    expect(events.filter((e) => e.type === 'run.created')).toHaveLength(1);

    // A fresh key after activation is refused: an activated project cannot start its first run again.
    const fresh = await activate(h, opened.body, k('activate-again'));
    expect(fresh.status).toBe(409);
    expect(await countRuns(v.projectId)).toBe(1);
  });

  it('blueprint edit invalidates readiness', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    expect(v.state).toBe('ready');
    expect(v.readiness.outcome).toBe('ready');
    expect(v.costPlan.confirmed).toBe(true);

    const edited = await write(h, v.projectId, 'blueprints', { content: { ...v.blueprint.content, nonGoals: ['Payments'] } }, v.revision);
    expect(edited.status).toBe(200);
    expect(edited.body.blueprint.version).toBe(2);
    expect(edited.body.state).toBe('blueprint_ready');
    expect(edited.body.readiness).toBeNull();
    expect(edited.body.blueprint.accepted).toBe(false);
    // Earlier versions are kept and cannot be rewritten.
    await expect(t.db.update(schema.projectBlueprints).set({ origin: 'owner' }).where(eq(schema.projectBlueprints.version, 1))).rejects.toThrow();
    // The cost plan is marked for review, but what was entered is kept.
    expect(edited.body.costPlan.confirmed).toBe(false);
    expect(edited.body.costPlan.agentBudgetUsd).toBe(25);
    // And the stale pass cannot be used to start.
    const stale = await activate(h, edited.body);
    expect(stale.status).toBe(409);
    expect(await countRuns(v.projectId)).toBe(0);
  });

  it('unsupported template cannot start a run', async () => {
    const h = harness();
    let v = await configuredWithRunner(h, ['mobile']);
    v = (await check(h, v)).body;
    expect(v.state).toBe('readiness_check');
    expect(v.condition.kind).toBe('blocked');
    expect(statusOf(v, 'template_supported')).toBe('failed');
    expect(v.readiness.checks.find((c: any) => c.id === 'template_supported').reason).toMatch(/toolchain|build/i);

    const refused = await activate(h, v);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('template_not_supported');
    expect(await countRuns(v.projectId)).toBe(0);

    // The ordinary run route is closed too, so the refusal cannot be walked around.
    const direct = await post(h.app, `/v1/projects/${v.projectId}/runs`, { idempotencyKey: k('run'), title: 'Sneak in', budgetLimitUsd: 5 });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('template_not_supported');
    expect(await countRuns(v.projectId)).toBe(0);
  });

  it('demo progress cannot satisfy readiness', async () => {
    // Demo data in the same database, and a server with no trusted checker, which is how the demo stack runs.
    await seedDemo(t.db, { tenantId: TENANT });
    const noChecker = makeHarness(t, {}, POLICY_WITH_PR, { readiness: undefined, drivers: DRIVERS_ON, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    let v = await configured(noChecker);
    const body = (await check(noChecker, v)).body;
    expect(body.state).toBe('readiness_check');
    expect(body.condition.kind).toBe('blocked');
    for (const id of ['checkout_present', 'repository_identity', 'base_commit', 'stack_certified', 'repository_reachable']) {
      const c = body.readiness.checks.find((x: any) => x.id === id);
      expect(c.status, id).toBe('unknown');
      expect(c.reason).toMatch(/checker|confirm/i);
    }
    expect((await activate(noChecker, body)).status).toBe(409);
    expect(await countRuns(v.projectId)).toBe(0);

    // A client cannot report its own results: unknown fields are refused, and client reports are never read.
    const forged = await post(noChecker.app, `/v1/onboarding/${v.projectId}/readiness`, { expectedRevision: body.revision, checks: [{ id: 'checkout_present', status: 'passed' }] });
    expect(forged.status).toBe(400);
    const claimed = await post(noChecker.app, `/v1/onboarding/${v.projectId}/readiness`, { expectedRevision: body.revision, status: 'ready' });
    expect(claimed.status).toBe(400);
    await t.db.insert(schema.clientReports).values({ tenantId: TENANT, projectId: 'proj_demo_local', reportId: 'r1', subjectKind: 'project', subjectId: v.projectId, kind: 'readiness', payload: { passed: true }, reportedBy: 'x' });
    const still = (await check(noChecker, body)).body;
    expect(still.state).toBe('readiness_check');
  });
});

describe('readiness probes from the environment', () => {
  it('a demo stack gets no trusted checker', () => {
    expect(readinessProbesFromEnv({ SELARIKRU_DEMO: '1' })).toBeUndefined();
  });
  it('a real stack gets one, built on its configured checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-env-'));
    try {
      execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
      const probes = readinessProbesFromEnv({ SELARIKRU_SOURCE_REPO: dir });
      expect(probes?.sourceCheckout).toBe(dir);
      expect(readinessProbesFromEnv({})?.sourceCheckout).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readiness', () => {
  it('reports each failed fact with its own reason', async () => {
    const h = harness(goodProbes({
      git: async () => ({ checkout: { ok: false, reason: 'The path does not exist on this machine' }, identity: { status: 'unknown', reason: 'Could not read the checkout' }, base: { sha: null, reason: 'Could not read the checkout' }, stack: { status: 'unknown', reason: 'Could not read the checkout' } }),
      githubAccess: async () => ({ status: 'failed', reason: 'gh is not signed in' }),
    }));
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(body.state).toBe('readiness_check');
    expect(statusOf(body, 'checkout_present')).toBe('failed');
    expect(statusOf(body, 'repository_identity')).toBe('unknown');
    expect(statusOf(body, 'base_commit')).toBe('failed');
    expect(statusOf(body, 'runner_enrolled')).toBe('failed');
    expect(statusOf(body, 'repository_reachable')).toBe('failed');
    expect(body.readiness.checks.find((c: any) => c.id === 'checkout_present').reason).toContain('does not exist');
  });

  it('an unknown required check blocks exactly as a failure does', async () => {
    const h = harness(goodProbes({ githubAccess: async () => ({ status: 'unknown', reason: 'gh is not installed' }) }));
    const v = await configuredWithRunner(h);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'repository_reachable')).toBe('unknown');
    expect(body.state).toBe('readiness_check');
    expect((await activate(h, body)).status).toBe(409);
  });

  it('a checker that throws records unknown, never a pass', async () => {
    const h = harness(goodProbes({ git: async () => { throw new Error('boom token=abcdefghijklmnop1234567890'); } }));
    const v = await configuredWithRunner(h);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'checkout_present')).toBe('unknown');
    expect(body.state).toBe('readiness_check');
    expect(JSON.stringify(body)).not.toContain('abcdefghijklmnop');
  });

  it('a runner from another location does not count', async () => {
    const h = harness();
    await enrolRunner(h.app, 'cloud');
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'runner_enrolled')).toBe('failed');
  });

  it('a revoked runner does not count', async () => {
    const h = harness();
    const r = await enrolRunner(h.app);
    await t.db.update(schema.runners).set({ revokedAt: new Date() }).where(eq(schema.runners.runnerId, r.runnerId));
    const v = await configured(h);
    expect(statusOf((await check(h, v)).body, 'runner_enrolled')).toBe('failed');
  });

  it('a runner long out of touch does not count', async () => {
    const h = harness();
    const r = await enrolRunner(h.app);
    await t.db.update(schema.runners).set({ lastSeenAt: new Date(h.clock.now().getTime() - 3_600_000) }).where(eq(schema.runners.runnerId, r.runnerId));
    const v = await configured(h);
    expect(statusOf((await check(h, v)).body, 'runner_enrolled')).toBe('failed');
  });

  it('missing policy fails the policy check', async () => {
    const h = makeHarness(t, {}, null, { readiness: goodProbes(), drivers: DRIVERS_ON, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    const v = await configured(h);
    expect(statusOf((await check(h, v)).body, 'policy_loaded')).toBe('failed');
  });

  it('no budget ceiling fails the budget check', async () => {
    const h = harness();
    const v = await configuredWithRunner(h, ['saas_web'], null);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'budget_limit')).toBe('failed');
    expect(body.state).toBe('readiness_check');
  });

  it('activation re-checks the machine, so an old pass cannot start a run', async () => {
    let auth: { status: 'passed' | 'failed' | 'unknown'; reason: string } = { status: 'passed', reason: 'signed in' };
    const h = harness(goodProbes({ githubAccess: async () => auth }));
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    expect(v.state).toBe('ready');
    auth = { status: 'failed', reason: 'gh signed out' };
    const r = await activate(h, v);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('readiness_failed');
    expect(await countRuns(v.projectId)).toBe(0);
    const after = (await get(h.app, `/v1/onboarding/${v.projectId}`)).body;
    expect(after.state).toBe('readiness_check');
    expect(after.condition.kind).toBe('blocked');
  });

  it('checks a real git checkout, its origin and a real commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    try {
      const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
      g('init', '-q', '-b', 'main');
      g('commit', '-q', '--allow-empty', '-m', 'x');
      g('remote', 'add', 'origin', 'git@github.com:acme/clinic.git');
      const contract = join(dir, 'contract');
      mkdirSync(contract);
      writeFileSync(join(contract, 'api.ts'), 'export const X = 1;\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'contract');
      const frozen = hashTree(contract);
      const probes = createGitProbes({ sourceCheckout: dir, githubAccess: async () => ({ status: 'unknown', reason: 'not checked here' }), certifiedContractSha256: frozen });
      const ok = await probes.git({ checkout: dir, repository: 'acme/clinic', branch: 'main' });
      expect(ok.checkout.ok).toBe(true);
      expect(ok.stack.status).toBe('passed');
      expect(ok.identity.status).toBe('passed');
      expect(ok.base.sha).toMatch(/^[0-9a-f]{40}$/);

      const wrongRepo = await probes.git({ checkout: dir, repository: 'acme/other', branch: 'main' });
      expect(wrongRepo.identity.status).toBe('failed');
      expect(wrongRepo.identity.reason).toContain('acme/clinic');

      const noBranch = await probes.git({ checkout: dir, repository: 'acme/clinic', branch: 'nope' });
      expect(noBranch.base.sha).toBeNull();
      expect(noBranch.base.reason).toContain('nope');

      const notThere = await probes.git({ checkout: join(dir, 'missing'), repository: 'acme/clinic', branch: 'main' });
      expect(notThere.checkout.ok).toBe(false);

      // Another repository's contract is not the pilot stack, and an unknown record says unknown.
      const other = createGitProbes({ sourceCheckout: dir, githubAccess: async () => ({ status: 'unknown', reason: '' }), certifiedContractSha256: 'f'.repeat(64) });
      expect((await other.git({ checkout: dir, repository: 'acme/clinic', branch: 'main' })).stack.status).toBe('failed');
      const noRecord = createGitProbes({ sourceCheckout: dir, githubAccess: async () => ({ status: 'unknown', reason: '' }), certifiedContractSha256: null });
      expect((await noRecord.git({ checkout: dir, repository: 'acme/clinic', branch: 'main' })).stack.status).toBe('unknown');

      g('remote', 'set-url', 'origin', 'https://notgithub.com/acme/clinic.git');
      expect((await probes.git({ checkout: dir, repository: 'acme/clinic', branch: 'main' })).identity.status).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fix round 1', () => {
  const CLOUD = { ...POLICY_WITH_PR, policyVersion: 'cloud.1', limits: { repairAttempts: 2, maxConcurrentTotal: 2 }, destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'execution', classifications: ['public', 'internal'] }] } as const;
  const withPolicy = (policy: object, probes: ReadinessProbes = goodProbes()) => makeHarness(t, {}, policy as never, { readiness: probes, drivers: DRIVERS_ON, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
  /** Up to the execution step, in browser order. */
  async function toExecution(h: Harness) {
    let v = await start(h);
    for (const [path, body] of [['answers', { source: { kind: 'new' } }], ['answers', { focus: { tracks: ['saas_web'] } }], ['blueprints', {}]] as const) v = (await write(h, v.projectId, path, body, v.revision)).body;
    v = (await write(h, v.projectId, 'blueprint/accept', { version: v.blueprint.version }, v.revision)).body;
    return (await write(h, v.projectId, 'cost-plan', costBody(25), v.revision)).body;
  }
  const lineIds = (view: any): string[] => view.costPlan.ledgers.agent_usage.lines.map((l: any) => l.id);

  it('the browser order reaches ready: choosing local after the cost plan does not unconfirm it', async () => {
    const h = harness();
    const v = await configuredWithRunner(h);
    expect(v.costPlan.confirmed).toBe(true);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'budget_limit')).toBe('passed');
    expect(body.state).toBe('ready');
  });

  it('a choice that changes the cost lines returns the plan for review and shows the new line', async () => {
    const h = harness();
    const v = await toExecution(h);
    expect(lineIds(v)).not.toContain('cloud_worker');
    const cloud = (await write(h, v.projectId, 'execution', { execution: 'hybrid', inference: 'PREFER_ON_DEVICE' }, v.revision)).body;
    expect(cloud.costPlan.confirmed).toBe(false);
    expect(lineIds(cloud)).toEqual(expect.arrayContaining(['cloud_worker', 'local_hardware']));
  });

  it('changing only the assistant route leaves the cost plan confirmed', async () => {
    const h = harness();
    const v = await toExecution(h);
    const first = (await write(h, v.projectId, 'execution', { execution: 'local', inference: 'PREFER_ON_DEVICE' }, v.revision)).body;
    const second = (await write(h, v.projectId, 'execution', { execution: 'local', inference: 'ONLY_ON_DEVICE' }, first.revision)).body;
    expect(second.costPlan.confirmed).toBe(true);
  });

  it('a runner that has not said which projects it holds is unknown and blocks', async () => {
    const h = harness();
    await enrolRunner(h.app);
    const body = (await check(h, await configured(h))).body;
    expect(statusOf(body, 'runner_enrolled')).toBe('passed');
    expect(statusOf(body, 'runner_has_project')).toBe('unknown');
    expect(body.state).toBe('readiness_check');
  });

  it('a runner configured for other projects fails, and says how to fix it', async () => {
    const h = harness();
    const r = await enrolRunner(h.app);
    const v = await configured(h);
    await reportProjects(h, r.token, ['proj_other']);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'runner_has_project')).toBe('failed');
    expect(body.readiness.checks.find((c: any) => c.id === 'runner_has_project').nextAction).toContain(v.projectId);
  });

  it('a runner report carries ids only: a path is refused', async () => {
    const h = harness();
    const r = await enrolRunner(h.app);
    expect((await post(h.app, '/v1/runners/claim', { projects: ['/Users/me/code'] }, bearer(r.token))).status).toBe(400);
  });

  async function cloudSetup(h: Harness, choice: 'cloud' | 'hybrid') {
    const v = await toExecution(h);
    const saved = (await write(h, v.projectId, 'execution', { execution: choice, inference: 'PREFER_ON_DEVICE' }, v.revision)).body;
    const confirmed = (await write(h, saved.projectId, 'cost-plan', costBody(25), saved.revision)).body;
    return (await write(h, confirmed.projectId, 'connections', { repository: 'acme/clinic', defaultBranch: 'main' }, confirmed.revision)).body;
  }

  it('the default policy, with no destinations, cannot reach ready on cloud', async () => {
    const h = harness();
    const r = await enrolRunner(h.app, 'cloud');
    const v = await cloudSetup(h, 'cloud');
    await reportProjects(h, r.token, [v.projectId]);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'runner_enrolled')).toBe('passed');
    expect(statusOf(body, 'cloud_destination')).toBe('failed');
    expect(body.state).toBe('readiness_check');
  });

  it('a destination that does not name this project as a source still refuses', async () => {
    const h = withPolicy(CLOUD);
    const r = await enrolRunner(h.app, 'cloud');
    const v = await cloudSetup(h, 'cloud');
    await reportProjects(h, r.token, [v.projectId]);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'cloud_destination')).toBe('failed');
    expect(body.readiness.checks.find((c: any) => c.id === 'cloud_destination').reason).toMatch(/source not selected/);
  });

  it('models are matched per location: a hybrid project needs each side to launch one', async () => {
    const h = harness();
    const local = await enrolRunner(h.app, 'local');
    const cloud = await enrolRunner(h.app, 'cloud', []);
    const v = await cloudSetup(h, 'hybrid');
    await reportProjects(h, local.token, [v.projectId]);
    await reportProjects(h, cloud.token, [v.projectId]);
    const body = (await check(h, v)).body;
    const c = body.readiness.checks.find((x: any) => x.id === 'runner_enrolled');
    expect(c.status).toBe('failed');
    expect(c.reason).toMatch(/cloud runner reports no model/);
  });

  it('says unknown when it cannot tell the drivers are running', async () => {
    const unknownH = makeHarness(t, {}, POLICY_WITH_PR, { readiness: goodProbes(), github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    expect(statusOf((await check(unknownH, await configuredWithRunner(unknownH))).body, 'pipeline_drivers')).toBe('unknown');
  });

  it('fails when a driver is off', async () => {
    const off = makeHarness(t, {}, POLICY_WITH_PR, { readiness: goodProbes(), drivers: () => ({ assembly: true, verification: false }), github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    const body = (await check(off, await configuredWithRunner(off))).body;
    expect(statusOf(body, 'pipeline_drivers')).toBe('failed');
  });

  it('a checkout that is not the pilot stack blocks readiness', async () => {
    const h = harness(goodProbes({ git: async () => ({ checkout: { ok: true, reason: 'ok' }, identity: { status: 'passed', reason: 'ok' }, base: { sha: SHA, reason: 'ok' }, stack: { status: 'failed', reason: 'not the contract' } }) }));
    const body = (await check(h, await configuredWithRunner(h))).body;
    expect(statusOf(body, 'stack_certified')).toBe('failed');
    expect(body.state).toBe('readiness_check');
  });

  it('nothing claims more than the pilot stack', async () => {
    const h = harness();
    const body = (await check(h, await configuredWithRunner(h))).body;
    expect(JSON.stringify(body.readiness.checks)).not.toMatch(/certified to run/i);
  });

  describe('gh repo view', () => {
    const fakeGh = (stdout: string) => async () => stdout;
    const failing = (stderr: string, code?: string) => async () => { throw Object.assign(new Error('x'), { stderr, ...(code ? { code } : {}) }); };
    it('passes only with write access', async () => {
      for (const p of ['ADMIN', 'MAINTAIN', 'WRITE']) expect((await ghRepoAccess('a/b', fakeGh(JSON.stringify({ viewerPermission: p })))).status).toBe('passed');
      const read = await ghRepoAccess('a/b', fakeGh(JSON.stringify({ viewerPermission: 'READ' })));
      expect(read.status).toBe('failed');
      expect(read.reason).toContain('write access');
    });
    it('asks gh about exactly this repository', async () => {
      let seen: readonly string[] = [];
      await ghRepoAccess('acme/clinic', async (args) => { seen = args; return '{"viewerPermission":"WRITE"}'; });
      expect(seen).toEqual(['repo', 'view', 'acme/clinic', '--json', 'viewerPermission']);
    });
    it('tells apart signed out, not found, not installed and unreachable, and quotes none of it', async () => {
      expect((await ghRepoAccess('a/b', failing('To get started, run: gh auth login'))).reason).toMatch(/not signed in/);
      expect((await ghRepoAccess('a/b', failing('GraphQL: Could not resolve to a Repository'))).reason).toMatch(/does not exist/);
      expect((await ghRepoAccess('a/b', failing('', 'ENOENT'))).status).toBe('unknown');
      const net = await ghRepoAccess('a/b', failing('dial tcp ghp_abcdefghijklmnopqrstuvwxyz0123'));
      expect(net.status).toBe('unknown');
      expect(net.reason).not.toContain('ghp_');
    });
  });

  it('a run started from onboarding carries the snapshot that authorised it, and later edits cannot change it', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    expect(v.readiness.snapshot).toMatchObject({ blueprintVersion: 1, execution: 'local', inference: 'PREFER_ON_DEVICE', agentBudgetUsd: 25, repository: 'acme/clinic', defaultBranch: 'main', baseSha: SHA });
    v = (await activate(h, v)).body;
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.projectId, v.projectId));
    expect(run!.setupSnapshot).toMatchObject({ execution: 'local', inference: 'PREFER_ON_DEVICE', agentBudgetUsd: 25, repository: 'acme/clinic', baseSha: SHA });
    await expect(t.db.update(schema.onboardingReadinessPasses).set({ baseSha: 'x' }).where(eq(schema.onboardingReadinessPasses.projectId, v.projectId))).rejects.toThrow();
  });

  it('later runs are bound to the recorded ceiling and location', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    v = (await activate(h, v)).body;
    const run = (body: object) => post(h.app, `/v1/projects/${v.projectId}/runs`, { idempotencyKey: k('run'), title: 'Next', ...body });
    expect((await run({})).body.error.code).toBe('outside_recorded_limits');
    expect((await run({ budgetLimitUsd: 26 })).body.error.code).toBe('outside_recorded_limits');
    expect((await run({ budgetLimitUsd: 5, placement: { mode: 'C1', cloudDestination: 'x' } })).body.error.code).toBe('outside_recorded_limits');
    expect((await run({ budgetLimitUsd: 25 })).status).toBe(201);
  });

  it('a cancelled project does not hold the checkout', async () => {
    const h = harness();
    const first = await configured(h);
    const cancelled = await post(h.app, `/v1/onboarding/${first.projectId}/cancel`, { expectedRevision: first.revision });
    expect(cancelled.status).toBe(200);
    let other = await start(h, { name: 'Another app' });
    for (const [path, body] of [['answers', { source: { kind: 'new' } }], ['answers', { focus: { tracks: ['saas_web'] } }], ['blueprints', {}]] as const) other = (await write(h, other.projectId, path, body, other.revision)).body;
    other = (await write(h, other.projectId, 'blueprint/accept', { version: other.blueprint.version }, other.revision)).body;
    const free = await write(h, other.projectId, 'connections', { repository: 'acme/different', defaultBranch: 'main' }, other.revision);
    expect(free.status, JSON.stringify(free.body)).toBe(200);
  });

  it('re-saving unchanged focus keeps owner edits and acceptance', async () => {
    const h = harness();
    let v = await start(h);
    for (const [path, body] of [['answers', { source: { kind: 'new' } }], ['answers', { focus: { tracks: ['saas_web'] } }], ['blueprints', {}]] as const) v = (await write(h, v.projectId, path, body, v.revision)).body;
    v = (await write(h, v.projectId, 'blueprints', { content: { ...v.blueprint.content, nonGoals: ['Payments'] } }, v.revision)).body;
    v = (await write(h, v.projectId, 'blueprint/accept', { version: 2 }, v.revision)).body;
    const again = (await write(h, v.projectId, 'answers', { focus: { tracks: ['saas_web'] } }, v.revision)).body;
    const draft = (await write(h, v.projectId, 'blueprints', {}, again.revision)).body;
    expect(draft.blueprint.version).toBe(2);
    expect(draft.blueprint.accepted).toBe(true);
    expect(draft.blueprint.content.nonGoals).toEqual(['Payments']);
    expect(draft.state).toBe('configuring');
  });

  it('after activation a write gets a plain refusal, not internal state names', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    v = (await activate(h, v)).body;
    const r = await write(h, v.projectId, 'blueprints', { content: { ...v.blueprint.content, nonGoals: ['X'] } }, v.revision);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('This project has started, so its setup can no longer change.');
  });

  it('the assistant answer is held to the recorded route', async () => {
    const h = harness();
    const v = await toExecution(h);
    const saved = (await write(h, v.projectId, 'execution', { execution: 'local', inference: 'ONLY_ON_DEVICE' }, v.revision)).body;
    const envelope = { operation: 'draftBrief', status: 'ok', data: { summary: 'A queue', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'Works' }] } };
    const wrong = await post(h.app, '/v1/onboarding/assist-review', { envelope, projectId: saved.projectId, observed: { source: 'IN_CLOUD', requestedMode: 'ONLY_ON_DEVICE' } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('route_not_recorded');
    expect((await post(h.app, '/v1/onboarding/assist-review', { envelope, projectId: saved.projectId })).status).toBe(422);
    expect((await post(h.app, '/v1/onboarding/assist-review', { envelope, projectId: saved.projectId, observed: { source: 'ON_DEVICE', requestedMode: 'ONLY_ON_DEVICE' } })).status).toBe(200);
  });

  it('records where applied assistant wording came from', async () => {
    const h = harness();
    const r = await post(h.app, '/v1/onboarding', { idempotencyKey: k('a'), goal: goal(), goalAssist: { observedSource: 'ON_DEVICE', requestedMode: 'ONLY_ON_DEVICE', provenance: 'assistant_proposal_reviewed' } });
    expect(r.body.goalAssist.observedSource).toBe('ON_DEVICE');
  });
});

describe('controller', () => {
  it('the browser cannot name a state or skip a step', async () => {
    const h = harness();
    const v = await start(h);
    expect(v.state).toBe('draft');
    const skip = await post(h.app, `/v1/onboarding/${v.projectId}/blueprint/accept`, { idempotencyKey: k('a'), expectedRevision: v.revision, version: 1 });
    expect(skip.status).toBe(409);
    const named = await post(h.app, `/v1/onboarding/${v.projectId}/answers`, { idempotencyKey: k('b'), expectedRevision: v.revision, state: 'ready', source: { kind: 'new' } });
    expect(named.status).toBe(400);
  });

  it('a stale revision is refused', async () => {
    const h = harness();
    const v = await start(h);
    const moved = await write(h, v.projectId, 'answers', { source: { kind: 'new' } }, v.revision);
    expect(moved.status).toBe(200);
    const stale = await write(h, v.projectId, 'answers', { source: { kind: 'existing' } }, v.revision);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_revision');
  });

  it('asks for what is missing instead of guessing a blueprint', async () => {
    const h = harness();
    const v = await start(h);
    const r = await write(h, v.projectId, 'blueprints', {}, v.revision);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('draft');
    expect(r.body.condition.kind).toBe('needs_input');
    expect(r.body.condition.reason).toMatch(/starting point|focus/i);
    expect(r.body.blueprint).toBeNull();
  });

  it('activation records a real run on the project', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    const r = await activate(h, v);
    expect(r.status).toBe(200);
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.projectId, v.projectId));
    expect(run!.lifecycle).toBe('planning');
    expect(run!.budget).toEqual({ limitUsd: 25 });
    const snapshot = await get(h.app, `/v1/projects/${v.projectId}/snapshot`);
    expect(snapshot.status).toBe(200);
  });

  it('a project still in setup cannot start a run another way', async () => {
    const h = harness();
    const v = await configured(h);
    const r = await post(h.app, `/v1/projects/${v.projectId}/runs`, { idempotencyKey: k('r'), title: 'Early', budgetLimitUsd: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_not_activated');
  });

  it('projects from other paths are not touched by the gate', async () => {
    const h = harness();
    await seedDemo(t.db, { tenantId: TENANT });
    const r = await post(h.app, '/v1/projects/proj_demo_local/runs', { idempotencyKey: k('r'), title: 'Fine', budgetLimitUsd: 1 });
    expect(r.status).toBe(201);
  });

  it('a second repository is refused with a reason', async () => {
    const h = harness();
    const first = await configured(h);
    expect(first.connection.repository).toBe('acme/clinic');
    let other = await start(h, { name: 'Another app' });
    for (const [path, body] of [['answers', { source: { kind: 'new' } }], ['answers', { focus: { tracks: ['saas_web'] } }], ['blueprints', {}]] as const) {
      other = (await write(h, other.projectId, path, body, other.revision)).body;
    }
    other = (await write(h, other.projectId, 'blueprint/accept', { version: other.blueprint.version }, other.revision)).body;
    const refused = await write(h, other.projectId, 'connections', { repository: 'acme/different', defaultBranch: 'main' }, other.revision);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('second_repository_refused');
    expect(refused.body.error.message).toContain('acme/clinic');
    expect(refused.body.error.details.servesRepository).toBe('acme/clinic');
    expect(await countProjects()).toBe(1);
    // The same repository is what the one checkout can serve.
    const same = await write(h, other.projectId, 'connections', { repository: 'acme/clinic', defaultBranch: 'main' }, other.revision);
    expect(same.status).toBe(200);
    expect(await countProjects()).toBe(2);
  });

  it('refuses a credential in any free text and never stores it', async () => {
    const h = harness();
    const r = await post(h.app, '/v1/onboarding', { idempotencyKey: k('s'), goal: goal({ idea: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123 for the build' }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('credential_in_input');
    expect(JSON.stringify(r.body)).not.toContain('ghp_');
    expect(await countOnboardings()).toBe(0);
  });

  it('asks for no credential: the connection step refuses token and path fields', async () => {
    const h = harness();
    const v = await configured(h);
    for (const extra of [{ token: 'x' }, { checkoutPath: '/etc' }]) {
      const r = await post(h.app, `/v1/onboarding/${v.projectId}/connections`, { idempotencyKey: k('c'), expectedRevision: v.revision, repository: 'acme/clinic', defaultBranch: 'main', ...extra });
      expect(r.status).toBe(400);
    }
  });

  it('every response matches the published view contract', async () => {
    const h = harness();
    const v = await configuredWithRunner(h);
    const body = (await check(h, v)).body;
    expect(OnboardingViewSchema.safeParse(body).success, JSON.stringify(OnboardingViewSchema.safeParse(body).error?.issues)).toBe(true);
  });

  it('never accepts a browser-supplied reference price', async () => {
    const h = harness();
    const v = await configured(h);
    const line = { id: 'x', label: 'Hosting', cadence: 'monthly', unit: 'usd', payer: 'your_accounts', lowUsd: 1, baseUsd: 1, highUsd: 1, provenance: 'reference_price', basis: 'someone said so' };
    const r = await write(h, v.projectId, 'cost-plan', costBody(25, { production: [line] }), v.revision);
    expect(r.status).toBe(400);
  });

  it('unknown costs stay null and owner estimates are labelled', async () => {
    const h = harness();
    const v = await configured(h);
    const unknown = { id: 'db', label: 'Database', cadence: 'monthly', unit: 'usd', payer: 'your_accounts', lowUsd: null, baseUsd: null, highUsd: null, provenance: 'unknown', basis: 'Not chosen yet' };
    const estimate = { id: 'host', label: 'Hosting', cadence: 'monthly', unit: 'usd', payer: 'your_accounts', lowUsd: 5, baseUsd: 10, highUsd: 20, provenance: 'user_estimate', basis: 'My current bill' };
    const assumptions = { ...NO_ASSUMPTIONS, users: { value: '200 patients a day', confidence: 'low' } };
    const r = await write(h, v.projectId, 'cost-plan', costBody(25, { production: [unknown, estimate], assumptions }), v.revision);
    expect(r.status).toBe(200);
    const production = r.body.costPlan.ledgers.production;
    expect(production.totals).toEqual({ knownLow: 5, knownBase: 10, knownHigh: 20, unit: 'usd', cadence: 'monthly', unknownLines: 1 });
    expect(production.lines.find((l: any) => l.id === 'db').baseUsd).toBeNull();
    expect(r.body.costPlan.assumptions.users).toEqual({ value: '200 patients a day', confidence: 'low' });
    expect(r.body.costPlan.ledgers.build_effort.lines[0].provenance).toBe('unknown');
  });

  it('every route requires the owner', async () => {
    const h = harness();
    const res = await h.app.inject({ method: 'GET', url: '/v1/onboarding' });
    expect(res.statusCode).toBe(401);
    const res2 = await h.app.inject({ method: 'POST', url: '/v1/onboarding', payload: { idempotencyKey: k('x'), goal: goal() }, headers: { origin: ORIGIN } });
    expect(res2.statusCode).toBe(401);
  });

  it('cancelling frees the name and blocks further writes', async () => {
    const h = harness();
    const v = await start(h);
    const c = await post(h.app, `/v1/onboarding/${v.projectId}/cancel`, { expectedRevision: v.revision });
    expect(c.status).toBe(200);
    const after = await write(h, v.projectId, 'answers', { source: { kind: 'new' } }, c.body.revision);
    expect(after.status).toBe(409);
    const list = await get(h.app, '/v1/onboarding');
    expect(list.body.items).toEqual([]);
    expect((await post(h.app, '/v1/onboarding', { idempotencyKey: k('z'), goal: goal() })).status).toBe(201);
  });

  it('owner: the assistant proposal is reviewed by the server and moves nothing', async () => {
    const h = harness();
    const v = await start(h);
    const ok = await post(h.app, '/v1/onboarding/assist-review', {
      envelope: { operation: 'draftBrief', status: 'ok', data: { summary: 'A queue screen', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'A patient sees their position' }] } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('valid');
    expect(ok.body.acceptanceCriteria[0]).toEqual({ id: 'AC-1', text: 'A patient sees their position' });
    const after = (await get(h.app, `/v1/onboarding/${v.projectId}`)).body;
    expect(after.state).toBe('draft');
    expect(after.revision).toBe(v.revision);

    const authority = await post(h.app, '/v1/onboarding/assist-review', { envelope: { operation: 'draftBrief', status: 'ok', data: { summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'y' }], tools: ['shell'] } } });
    expect(authority.status).toBe(422);
    expect(authority.body.error.code).toBe('proposal_rejected');

    const wrongRoute = await post(h.app, '/v1/onboarding/assist-review', { envelope: { operation: 'draftBrief', status: 'route_violation', data: { summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'y' }] } } });
    expect(wrongRoute.status).toBe(422);

    const restricted = await post(h.app, '/v1/onboarding/assist-review', { restricted: true, envelope: { operation: 'draftBrief', status: 'ok', data: { summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'y' }] } } });
    expect(restricted.status).toBe(422);
    expect(restricted.body.error.code).toBe('restricted_stays_on_device');
  });

  it('activated projects feed the plan assistant from their own blueprint', async () => {
    const h = harness();
    let v = await configuredWithRunner(h);
    v = (await check(h, v)).body;
    v = (await activate(h, v)).body;
    const review = await post(h.app, `/v1/runs/${v.firstRunId}/proposals/review`, {
      envelope: { operation: 'draftTaskPlan', status: 'ok', data: { tasks: [{ title: 'Queue screen', description: 'Show position', requirementIds: ['FB-01'], role: 'backend' }] } },
    });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.tasks[0].baseSha).toBe(SHA);
    expect(review.body.tasks[0].allowedPaths).toEqual(['server', 'migrations', 'tests/backend']);
    expect(review.body.tasks[0].requirementIds).toEqual(['FB-01']);
    expect(review.body.tasks[0].acceptanceCheckIds).toEqual(['FB-01']);
  });

  describe('a run on the pilot stack is judged on FB-01 to FB-08', () => {
    const CRITERIA = ['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-05', 'FB-06', 'FB-07', 'FB-08'];
    const TRUSTED = { checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64) };
    const CANDIDATE = 'c'.repeat(40);
    const planOf = (tasks: readonly { title: string; requirementIds: readonly string[]; role: string; description?: string }[]) => ({ operation: 'draftTaskPlan', status: 'ok', data: { tasks: tasks.map((x) => ({ description: 'Build it', ...x })) } });
    const TWO_ROLES = [{ title: 'API and storage', requirementIds: ['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-06'], role: 'backend' }, { title: 'Form, list and filters', requirementIds: ['FB-05', 'FB-07', 'FB-08'], role: 'frontend' }];

    /** What the verifier writes once it has passed a candidate: a stored record with all eight results and one check run per criterion per task. */
    async function recordVerified(artifacts: LocalDiskArtifactStore, projectId: string, runId: string, taskIds: readonly string[]) {
      await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status) VALUES (${TENANT}, ${projectId}, 'cand_pilot', ${runId}, 'main', ${CANDIDATE}, ${SHA}, ${'d'.repeat(40)}, ${JSON.stringify(taskIds.map((taskId) => ({ taskId })))}::jsonb, 'assembled')`);
      const record = VerificationRecordSchema.parse({
        schemaVersion: 1, recordId: 'rec_pilot', taskId: taskIds[0], runId, partTaskIds: [...taskIds], candidateSha: CANDIDATE, candidateTreeSha: 'd'.repeat(40), candidateContentSha256: 'd'.repeat(64), baseSha: SHA, contractRevisions: [],
        ...TRUSTED, toolVersions: {}, configVersions: {}, environmentImageDigest: 'sha256:img', host: 'local-docker', fixtures: [], startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', result: 'passed', exitCode: 0,
        results: CRITERIA.map((checkId) => ({ checkId, status: 'passed', tests: [{ runner: 'vitest', title: `${checkId} holds`, status: 'passed' }], failures: [], evidenceReferences: [] })),
        runs: [{ attempt: 1, startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: null, logArtifactId: null }],
        flaky: [], taskOutcomes: [], artifactIds: [], verifier: { kind: 'verifier', id: 'verifier-local-1' },
      });
      const ref = await artifacts.put(Buffer.from(JSON.stringify(record)));
      const checkRunIds = taskIds.flatMap((taskId) => CRITERIA.map((checkId) => `chk_${taskId}_${checkId}`));
      for (const taskId of taskIds) for (const checkId of CRITERIA) {
        await t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result) VALUES (${TENANT}, ${projectId}, ${`chk_${taskId}_${checkId}`}, ${taskId}, 1, NULL, ${checkId}, '0.1', ${CANDIDATE}, 'passed')`);
      }
      await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator) VALUES (${TENANT}, ${projectId}, 'rec_pilot', ${runId}, 'verification_record', ${ref.sha256}, ${CANDIDATE}, 'internal', ${JSON.stringify({ recordId: 'rec_pilot', candidateSha: CANDIDATE, applied: true, checkRunIds })}::jsonb)`);
      await t.db.execute(sql`UPDATE task_status SET status = 'verified' WHERE project_id = ${projectId}`);
      await t.db.execute(sql`UPDATE runs SET lifecycle = 'ready_for_review' WHERE run_id = ${runId}`);
    }

    it('from activation through plan, verdict, per-criterion evidence and the pull request body', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pilot-criteria-'));
      const artifacts = new LocalDiskArtifactStore(dir);
      const gh = new FakeGitHub();
      const loadRecord = (key: { tenantId: string; projectId: string; sha: string }) => loadValidRecord(t.db, artifacts, key, { trusted: TRUSTED });
      const h = makeHarness(t, {}, POLICY_WITH_PR, { readiness: goodProbes(), drivers: DRIVERS_ON, evidence: { trusted: () => TRUSTED, artifacts, loadRecord }, github: { pullRequests: { port: gh, repoPath: CHECKOUT, loadRecord } } });
      try {
        let v = await configuredWithRunner(h);
        expect(v.blueprint.content.acceptanceCriteria.map((c: { id: string }) => c.id)).toEqual(CRITERIA);
        v = (await check(h, v)).body;
        v = (await activate(h, v)).body;
        const runId = v.firstRunId as string;

        // The plan the assistant drafts from a brief naming these ids is the one the server accepts.
        const review = await post(h.app, `/v1/runs/${runId}/proposals/review`, { envelope: planOf(TWO_ROLES) });
        expect(review.status, JSON.stringify(review.body)).toBe(200);
        expect(review.body.tasks.map((x: { acceptanceCheckIds: string[] }) => x.acceptanceCheckIds)).toEqual([['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-06'], ['FB-05', 'FB-07', 'FB-08']]);

        // A plan that left a criterion out would shrink the denominator, so it is refused and says which.
        const partialReview = await post(h.app, `/v1/runs/${runId}/proposals/review`, { envelope: planOf([{ title: 'Only the form', requirementIds: ['FB-01'], role: 'frontend' }]) });
        expect(partialReview.status).toBe(200);
        const partial = await post(h.app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, idempotencyKey: k('partial'), tasks: partialReview.body.tasks });
        expect(partial.status).toBe(422);
        expect(partial.body.error.code).toBe('criteria_not_covered');
        expect(partial.body.error.details.missing).toEqual(CRITERIA.slice(1));

        // Every criterion on one role would leave the other half of the app unbuilt.
        const oneRole = await post(h.app, `/v1/runs/${runId}/proposals/review`, { envelope: planOf([{ title: 'Everything', requirementIds: CRITERIA, role: 'backend' }]) });
        expect(oneRole.status).toBe(200);
        const refused = await post(h.app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, idempotencyKey: k('one-role'), tasks: oneRole.body.tasks });
        expect(refused.status).toBe(422);
        expect(refused.body.error).toMatchObject({ code: 'roles_not_covered', details: { missing: ['frontend'] } });

        const accepted = await post(h.app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, idempotencyKey: k('plan'), tasks: review.body.tasks });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
        await recordVerified(artifacts, v.projectId, runId, accepted.body.taskIds);

        const snapshot = await get(h.app, `/v1/projects/${v.projectId}/snapshot`, owner());
        const run = snapshot.body.runs.find((r: { runId: string }) => r.runId === runId);
        expect(run.criteria).toEqual({ verified: 8, total: 8 });
        expect(run.evidence.criteria.map((c: { criterionId: string; state: string; verified: boolean }) => [c.criterionId, c.state, c.verified])).toEqual(CRITERIA.map((id) => [id, 'passed', true]));

        const pr = await h.app.inject({ method: 'POST', url: `/v1/runs/${runId}/pull-request`, payload: {}, headers: owner() });
        expect(pr.statusCode, pr.body).toBe(200);
        const body = gh.prs[0]!.body;
        for (const id of CRITERIA) expect(body).toContain(`| ${id} | passed |`);
        expect(body).not.toContain('untested');
      } finally {
        await h.app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a two-role plan runs as two workers at once, each with its role, its own paths and what it needs to know', async () => {
      const h = harness();
      const runner = await enrolRunner(h.app);
      let v = await configured(h);
      await reportProjects(h, runner.token, [v.projectId]);
      v = (await check(h, v)).body;
      v = (await activate(h, v)).body;
      const runId = v.firstRunId as string;
      const assigned = await post(h.app, `/v1/projects/${v.projectId}/model-assignments`, { scope: 'role', key: 'frontend', selection: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, expectedRevision: 0, idempotencyKey: k('assign') });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

      const SECRET = 'sk_live_CANARY0123456789abcdefXYZ';
      const WHAT = `Build the Express routes and SQLite persistence; the token ${SECRET} is not for you.`;
      const review = await post(h.app, `/v1/runs/${runId}/proposals/review`, { envelope: planOf([{ ...TWO_ROLES[0]!, description: WHAT }, { ...TWO_ROLES[1]!, description: 'Build the one-screen form, list and status filters.' }]) });
      expect(review.status, JSON.stringify(review.body)).toBe(200);
      const accepted = await post(h.app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, idempotencyKey: k('plan'), tasks: review.body.tasks });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

      const claim = async () => (await post(h.app, '/v1/runners/claim', { projects: [v.projectId] }, bearer(runner.token))).body;
      const [first, second, third] = [await claim(), await claim(), await claim()];
      expect(first.lease, JSON.stringify(first)).not.toBeNull();
      expect(second.lease, JSON.stringify(second)).not.toBeNull();
      expect(first.lease.attemptId).not.toBe(second.lease.attemptId);
      expect(third.lease).toBeNull(); // both tasks are running: the limit of two is reached

      const leases = [first.lease, second.lease];
      // Through the route the runner itself reads its task from.
      const specOf = async (lease: { attemptId: string; fence: number; leaseToken: string }) => (await post(h.app, '/v1/runners/task', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken } }, bearer(runner.token))).body.task as TaskSpec;
      const specs = await Promise.all(leases.map(specOf));
      const backend = specs.find((s) => s.role === 'backend')!;
      const frontend = specs.find((s) => s.role === 'frontend')!;
      expect(backend.allowedPaths).toEqual(['server', 'migrations', 'tests/backend']);
      expect(frontend.allowedPaths).toEqual(['src', 'tests/frontend']);
      expect([backend.limits.maxCostUsd, frontend.limits.maxCostUsd]).toEqual([12.5, 12.5]); // both fit under the $25 run budget at once
      expect(leases.find((l) => l.taskId === frontend.taskId).assignment).toMatchObject({ model: 'claude-sonnet-5-5', source: 'role' });
      expect(leases.find((l) => l.taskId === backend.taskId).assignment).toMatchObject({ source: 'default' });

      // What the worker reads: its own brief and the full text of only the criteria it carries.
      const backendFile = renderTaskFile(backend);
      const frontendFile = renderTaskFile(frontend);
      expect(backendFile).toContain('Build the Express routes and SQLite persistence');
      expect(backendFile).toContain('- FB-01: Create feedback with a trimmed title of 3–120 characters');
      expect(backendFile).toContain('Valid POST returns 201 and a persisted item');
      expect(backendFile).not.toContain('FB-05:');
      expect(backendFile).not.toContain(SECRET);
      expect(frontendFile).toContain('Build the one-screen form');
      expect(frontendFile).toContain('- FB-05: Filter by All/Open/Planned/Done');
      expect(frontendFile).not.toContain('FB-01:');

      // It goes to the worker and nowhere else: the owner's snapshot and the event log carry neither.
      const snapshot = JSON.stringify((await get(h.app, `/v1/projects/${v.projectId}/snapshot`, owner())).body);
      expect(snapshot).not.toContain('Build the Express routes');
      const events = JSON.stringify(await t.db.execute(sql`SELECT payload FROM events WHERE project_id = ${v.projectId}`));
      expect(events).not.toContain('Build the Express routes');
    });

    it('refuses an owner edit that would replace the criteria, and an older blueprint that already did', async () => {
      const h = harness();
      let v = await configuredWithRunner(h);
      const content = { ...v.blueprint.content, acceptanceCriteria: [{ id: 'AC-1', text: 'A patient sees their position' }] };
      const edit = await write(h, v.projectId, 'blueprints', { content }, v.revision);
      expect(edit.status).toBe(422);
      expect(edit.body.error.code).toBe('pilot_criteria_fixed');

      // A blueprint drafted before the pilot criteria were fixed: versions are immutable, so it arrives as a later version the owner already accepted.
      await t.db.execute(sql`INSERT INTO project_blueprints (tenant_id, project_id, version, content, content_sha256, origin, created_by) VALUES (${TENANT}, ${v.projectId}, ${v.blueprint.version + 1}, ${JSON.stringify(content)}::jsonb, ${'f'.repeat(64)}, 'owner', 'owner')`);
      await t.db.execute(sql`UPDATE project_onboardings SET current_blueprint_version = ${v.blueprint.version + 1}, accepted_blueprint_version = ${v.blueprint.version + 1}, cost_confirmed_for_version = ${v.blueprint.version + 1} WHERE project_id = ${v.projectId}`);
      v = (await get(h.app, `/v1/onboarding/${v.projectId}`, owner())).body;
      v = (await check(h, v)).body;
      const started = await activate(h, v);
      expect(started.status).toBe(422);
      expect(started.body.error.code).toBe('pilot_criteria_fixed');
      expect(await countRuns(v.projectId)).toBe(0);
    });
  });

  it('owner routes never expose the source checkout to a non-owner', async () => {
    const h = harness();
    const v = await start(h);
    const stranger = await get(h.app, `/v1/onboarding/${v.projectId}`, owner({ authorization: 'Bearer firebase-intruder-token' }));
    expect(stranger.status).toBe(403);
  });
});

describe('runner_has_project', () => {
  it('needs every recent runner at the location to hold the project, because the scheduler does not filter by it', async () => {
    const h = harness();
    const holder = await enrolRunner(h.app);
    const other = await enrolRunner(h.app);
    const v = await configured(h);
    await reportProjects(h, holder.token, [v.projectId]);
    await reportProjects(h, other.token, ['some-other-project']);
    const result = await check(h, v);
    expect(statusOf(result.body, 'runner_has_project')).toBe('failed');
    expect(result.body.readiness.checks.find((c: any) => c.id === 'runner_has_project').reason).toContain(other.runnerId);

    await reportProjects(h, other.token, [v.projectId]);
    const fixed = await check(h, result.body);
    expect(statusOf(fixed.body, 'runner_has_project')).toBe('passed');
  });
});

describe('the certified contract', () => {
  it('is the starter shell\'s own, so stack_certified passes for a copy of it', () => {
    const root = new URL('../../../', import.meta.url);
    const hashes = JSON.parse(readFileSync(new URL('services/verifier/suites/feedback-board/HASHES.json', root), 'utf8')) as { contractSha256: string };
    expect(hashTree(fileURLToPath(new URL('examples/feedback-board-starter/contract', root)))).toBe(hashes.contractSha256);
  });
});

describe('plan task roles', () => {
  it('are exactly the roles the role-pinned placement mode maps', () => {
    expect(Object.keys(PLACEMENT_MODES.H2.rolePlacement).sort()).toEqual([...PLAN_TASK_ROLES].sort());
  });
});
