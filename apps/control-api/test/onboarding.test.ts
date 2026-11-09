import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@selarikru/persistence';
import { OnboardingViewSchema } from '@selarikru/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGitProbes, readinessProbesFromEnv, seedDemo, type ReadinessProbes } from '../src/index.ts';
import { API_POLICY, ORIGIN, TENANT, enrolRunner, get, makeHarness, owner, post, setupTestDb, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
const CHECKOUT = '/srv/source';
const SHA = 'a'.repeat(40);
/** A checker that sees a healthy machine. Each test breaks one fact. */
const goodProbes = (over: Partial<ReadinessProbes> = {}): ReadinessProbes => ({
  sourceCheckout: CHECKOUT,
  git: async () => ({ reachable: { ok: true, reason: 'ok' }, identity: { status: 'passed', reason: 'origin matches' }, base: { sha: SHA, reason: 'resolved' } }),
  githubAuth: async () => ({ status: 'passed', reason: 'gh is signed in' }),
  ...over,
});

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.db.execute(sql`TRUNCATE project_onboardings, project_blueprints, onboarding_readiness_passes, onboarding_receipts, projects, project_sequences, runs, runners, operation_receipts, events, outbox CASCADE`); });

const POLICY_WITH_PR = { ...API_POLICY, operations: { ...API_POLICY.operations, create_draft_pr: 'allow' } } as const;
const harness = (probes: ReadinessProbes | undefined = goodProbes()): Harness => makeHarness(t, {}, POLICY_WITH_PR, { readiness: probes, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
const goal = (over = {}) => ({ name: 'Clinic queue', idea: 'Patients see their place in the queue', audience: 'Small clinics', firstOutcome: 'A patient sees their position', ...over });
const k = (s: string) => `key:${s.replace(/\//g, "-")}:${Math.random().toString(36).slice(2)}`;

async function start(h: Harness, over = {}) {
  const r = await post(h.app, '/v1/onboarding', { idempotencyKey: k('create'), goal: goal(over) });
  expect(r.status).toBe(201);
  return r.body;
}
const write = async (h: Harness, id: string, path: string, body: object, rev: number) => post(h.app, `/v1/onboarding/${id}/${path}`, { idempotencyKey: k(path), expectedRevision: rev, ...body });

/** Through the real routes up to the readiness step. */
async function configured(h: Harness, focus: readonly string[] = ['saas_web'], budget: number | null = 25) {
  let v = await start(h);
  for (const [path, body] of [
    ['answers', { source: { kind: 'new' }, focus: { tracks: focus } }],
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
    ['execution', { execution: 'local', inference: 'PREFER_ON_DEVICE' }],
    ['cost-plan', { agentBudgetUsd: budget, provider: [], app: [] }],
    ['connections', { repository: 'acme/clinic', defaultBranch: 'main' }],
  ] as const) {
    const r = await write(h, v.projectId, path, body, v.revision);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    v = r.body;
  }
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
    await enrolRunner(h.app);
    let v = await configured(h);
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
    await enrolRunner(h.app);
    let v = await configured(h);
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
    await enrolRunner(h.app);
    let v = await configured(h, ['mobile']);
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
    const noChecker = makeHarness(t, {}, POLICY_WITH_PR, { readiness: undefined, github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    let v = await configured(noChecker);
    const body = (await check(noChecker, v)).body;
    expect(body.state).toBe('readiness_check');
    expect(body.condition.kind).toBe('blocked');
    for (const id of ['repository_path', 'repository_identity', 'base_commit', 'github_auth']) {
      const c = body.readiness.checks.find((x: any) => x.id === id);
      expect(c.status, id).toBe('unknown');
      expect(c.reason).toMatch(/checker|confirm/i);
    }
    expect((await activate(noChecker, body)).status).toBe(409);
    expect(await countRuns(v.projectId)).toBe(0);

    // A client cannot report its own results: unknown fields are refused, and client reports are never read.
    const forged = await post(noChecker.app, `/v1/onboarding/${v.projectId}/readiness`, { expectedRevision: body.revision, checks: [{ id: 'repository_path', status: 'passed' }] });
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
      git: async () => ({ reachable: { ok: false, reason: 'The path does not exist on this machine' }, identity: { status: 'unknown', reason: 'Could not read the checkout' }, base: { sha: null, reason: 'Could not read the checkout' } }),
      githubAuth: async () => ({ status: 'failed', reason: 'gh is not signed in' }),
    }));
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(body.state).toBe('readiness_check');
    expect(statusOf(body, 'repository_path')).toBe('failed');
    expect(statusOf(body, 'repository_identity')).toBe('unknown');
    expect(statusOf(body, 'base_commit')).toBe('failed');
    expect(statusOf(body, 'runner_enrolled')).toBe('failed');
    expect(statusOf(body, 'github_auth')).toBe('failed');
    expect(body.readiness.checks.find((c: any) => c.id === 'repository_path').reason).toContain('does not exist');
  });

  it('an unknown required check blocks exactly as a failure does', async () => {
    const h = harness(goodProbes({ githubAuth: async () => ({ status: 'unknown', reason: 'gh is not installed' }) }));
    await enrolRunner(h.app);
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'github_auth')).toBe('unknown');
    expect(body.state).toBe('readiness_check');
    expect((await activate(h, body)).status).toBe(409);
  });

  it('a checker that throws records unknown, never a pass', async () => {
    const h = harness(goodProbes({ git: async () => { throw new Error('boom token=abcdefghijklmnop1234567890'); } }));
    await enrolRunner(h.app);
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'repository_path')).toBe('unknown');
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
    const h = makeHarness(t, {}, null, { readiness: goodProbes(), github: { pullRequests: { port: {} as never, repoPath: CHECKOUT, loadRecord: async () => null } } });
    const v = await configured(h);
    expect(statusOf((await check(h, v)).body, 'policy_loaded')).toBe('failed');
  });

  it('no budget ceiling fails the budget check', async () => {
    const h = harness();
    await enrolRunner(h.app);
    const v = await configured(h, ['saas_web'], null);
    const body = (await check(h, v)).body;
    expect(statusOf(body, 'budget_limit')).toBe('failed');
    expect(body.state).toBe('readiness_check');
  });

  it('activation re-checks the machine, so an old pass cannot start a run', async () => {
    let auth: { status: 'passed' | 'failed' | 'unknown'; reason: string } = { status: 'passed', reason: 'signed in' };
    const h = harness(goodProbes({ githubAuth: async () => auth }));
    await enrolRunner(h.app);
    let v = await configured(h);
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
      const probes = createGitProbes({ sourceCheckout: dir, githubAuth: async () => ({ status: 'unknown', reason: 'not checked here' }) });
      const ok = await probes.git({ checkout: dir, repository: 'acme/clinic', branch: 'main' });
      expect(ok.reachable.ok).toBe(true);
      expect(ok.identity.status).toBe('passed');
      expect(ok.base.sha).toMatch(/^[0-9a-f]{40}$/);

      const wrongRepo = await probes.git({ checkout: dir, repository: 'acme/other', branch: 'main' });
      expect(wrongRepo.identity.status).toBe('failed');
      expect(wrongRepo.identity.reason).toContain('acme/clinic');

      const noBranch = await probes.git({ checkout: dir, repository: 'acme/clinic', branch: 'nope' });
      expect(noBranch.base.sha).toBeNull();
      expect(noBranch.base.reason).toContain('nope');

      const notThere = await probes.git({ checkout: join(dir, 'missing'), repository: 'acme/clinic', branch: 'main' });
      expect(notThere.reachable.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    await enrolRunner(h.app);
    let v = await configured(h);
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
    for (const [path, body] of [['answers', { source: { kind: 'new' }, focus: { tracks: ['saas_web'] } }], ['blueprints', {}]] as const) {
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
    await enrolRunner(h.app);
    const v = await configured(h);
    const body = (await check(h, v)).body;
    expect(OnboardingViewSchema.safeParse(body).success, JSON.stringify(OnboardingViewSchema.safeParse(body).error?.issues)).toBe(true);
  });

  it('never accepts a browser-supplied reference price', async () => {
    const h = harness();
    const v = await configured(h);
    const line = { id: 'x', label: 'Hosting', cadence: 'monthly', lowUsd: 1, baseUsd: 1, highUsd: 1, provenance: 'reference_price', basis: 'someone said so' };
    const r = await write(h, v.projectId, 'cost-plan', { agentBudgetUsd: 25, provider: [], app: [line] }, v.revision);
    expect(r.status).toBe(400);
  });

  it('unknown costs stay null and owner estimates are labelled', async () => {
    const h = harness();
    const v = await configured(h);
    const unknown = { id: 'db', label: 'Database', cadence: 'monthly', lowUsd: null, baseUsd: null, highUsd: null, provenance: 'unknown', basis: 'Not chosen yet' };
    const estimate = { id: 'host', label: 'Hosting', cadence: 'monthly', lowUsd: 5, baseUsd: 10, highUsd: 20, provenance: 'user_estimate', basis: 'My current bill' };
    const r = await write(h, v.projectId, 'cost-plan', { agentBudgetUsd: 25, provider: [], app: [unknown, estimate] }, v.revision);
    expect(r.status).toBe(200);
    const app = r.body.costPlan.ledgers.app;
    expect(app.totals).toEqual({ knownLowUsd: 5, knownBaseUsd: 10, knownHighUsd: 20, unknownLines: 1 });
    expect(app.lines.find((l: any) => l.id === 'db').baseUsd).toBeNull();
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
    await enrolRunner(h.app);
    let v = await configured(h);
    v = (await check(h, v)).body;
    v = (await activate(h, v)).body;
    const review = await post(h.app, `/v1/runs/${v.firstRunId}/proposals/review`, {
      envelope: { operation: 'draftTaskPlan', status: 'ok', data: { tasks: [{ title: 'Queue screen', description: 'Show position', requirementIds: ['AC-1'] }] } },
    });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.tasks[0].baseSha).toBe(SHA);
    expect(review.body.tasks[0].allowedPaths).toEqual(['src', 'tests']);
  });

  it('owner routes never expose the source checkout to a non-owner', async () => {
    const h = harness();
    const v = await start(h);
    const stranger = await get(h.app, `/v1/onboarding/${v.projectId}`, owner({ authorization: 'Bearer firebase-intruder-token' }));
    expect(stranger.status).toBe(403);
  });
});
