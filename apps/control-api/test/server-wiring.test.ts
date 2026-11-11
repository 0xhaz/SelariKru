/** What the documented environment actually starts, through `startServer` rather than `buildApp`. Never reaches GitHub: the port is a fake and the run is not ready. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { schema } from '@selarikru/persistence';
import { TEST_DATABASE_URL } from '@selarikru/workflow/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { evaluate, parsePolicy } from '@selarikru/policy';
import { ProjectPlanSettingsSchema } from '../src/index.ts';
import { readRealRunConfig, realOwnerAccount, seedRealRun, writeRealRunFiles } from '../src/real-run.ts';
import { githubOptionsFromEnv, startServer, type RunningServer } from '../src/server.ts';
import { OWNER_TOKEN, RUN, TENANT, TEST_RUNNER_REPORT, fakeVerifier, resetDb, seedTask, setupTestDb, specFor, testConfig, type TestDb } from './helpers.ts';
import { loadConfigFromEnv } from '../src/config.ts';

let t: TestDb;
let root: string;
let repo: string;
let baseSha: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  t = await setupTestDb(8);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wiring-')));
  repo = join(root, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'source\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  baseSha = git('rev-parse', 'HEAD');
});
afterAll(async () => { await t.close(); rmSync(root, { recursive: true, force: true }); });

async function withServer(env: NodeJS.ProcessEnv, fn: (address: string) => Promise<void>): Promise<void> {
  await resetDb(t.db);
  const server: RunningServer = await startServer({ config: testConfig(), databaseUrl: `${TEST_DATABASE_URL}?search_path=${t.schema}`, verifier: fakeVerifier, github: { ...githubOptionsFromEnv(env), port: new FakeGitHub() } });
  try {
    await fn(server.address);
  } finally {
    await server.stop();
  }
}
const openPr = (address: string) => fetch(`${address}/v1/runs/${RUN}/pull-request`, { method: 'POST', headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });

describe('the pull request route through startServer', () => {
  it('exists with SELARIKRU_SOURCE_REPO and SELARIKRU_GITHUB_ENABLED=1, and is reached (409 run_not_ready, nothing sent to GitHub)', async () => {
    await withServer({ SELARIKRU_SOURCE_REPO: repo, SELARIKRU_GITHUB_ENABLED: '1', SELARIKRU_ARTIFACT_DIR: join(root, 'artifacts') }, async (address) => {
      const res = await openPr(address);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject({ code: 'pull_request_not_allowed', details: { reason: 'run_not_ready' } });
    });
  });

  it('does not exist with a source repository alone', async () => {
    await withServer({ SELARIKRU_SOURCE_REPO: repo, SELARIKRU_ARTIFACT_DIR: join(root, 'artifacts') }, async (address) => {
      expect((await openPr(address)).status).toBe(404);
    });
  });
});

describe('coding workers through startServer (H5/H6)', () => {
  it('the documented environment, with no SELARIKRU_CODING_WORKERS, dispatches no model worker: a ready task waits for an accepted proposal', async () => {
    await resetDb(t.db);
    const config = loadConfigFromEnv({
      SELARIKRU_TENANT_ID: TENANT, SELARIKRU_OWNER_UID: 'owner_uid_1', FIREBASE_PROJECT_ID: 'selarikru', SELARIKRU_API_PORT: '0', SELARIKRU_MAX_CONCURRENT_TOTAL: '2', SELARIKRU_ATTEMPT_TIMEOUT_SECONDS: '1800',
      SELARIKRU_MAX_INFRA_RETRIES: '3', SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS: '10', SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS: '40', SELARIKRU_PAIRING_CODE_TTL_SECONDS: '600', SELARIKRU_EXPIRE_LEASES_INTERVAL_MS: '60000',
    });
    expect(config.codingWorkers).toBe('off');
    await seedTask(t.db, specFor('t1'));
    const server: RunningServer = await startServer({ config, databaseUrl: `${TEST_DATABASE_URL}?search_path=${t.schema}`, verifier: fakeVerifier });
    try {
      const json = async (path: string, body: unknown, token: string) => (await (await fetch(`${server.address}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Record<string, any>;
      const code = await json('/v1/runners/pairing-codes', { location: 'local' }, OWNER_TOKEN);
      const enrolled = await json('/v1/runners/enroll', { harnesses: TEST_RUNNER_REPORT }, code['pairingCode']);
      const claim = await json('/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: ['proj_a'] }, enrolled['token']);
      expect(claim['lease']).toBeNull();
      expect(claim['skipped']).toEqual([{ taskId: 't1', reason: 'awaiting_accepted_proposal' }]);
    } finally {
      await server.stop();
      // The enrolment's harness report would read as an installed harness to the tests after this one.
      await t.db.execute(sql`DELETE FROM runners`);
    }
  });
});

describe('real-run seed', () => {
  it('names the owner account after the configured UID, with emulator-only defaults', () => {
    expect(realOwnerAccount({ SELARIKRU_OWNER_UID: 'uid_x' })).toEqual({ uid: 'uid_x', email: 'owner@selarikru.invalid', password: 'real-run-local-only-password' });
    expect(realOwnerAccount({ SELARIKRU_OWNER_UID: 'uid_x', SELARIKRU_REAL_OWNER_EMAIL: 'me@selarikru.invalid' }).email).toBe('me@selarikru.invalid');
    expect(() => realOwnerAccount({})).toThrow(/SELARIKRU_OWNER_UID/);
  });

  const env = (over: Record<string, string> = {}) => ({ SELARIKRU_TENANT_ID: 'tenant_local', SELARIKRU_OWNER_UID: 'owner', SELARIKRU_SOURCE_REPO: repo, SELARIKRU_REAL_REPOSITORY: 'acme/feedback-board', SELARIKRU_REAL_ALLOWED_PATHS: 'src,public', SELARIKRU_REAL_BUDGET_LIMIT_USD: '5', ...over });

  it('takes the repository, branch and full base SHA from the environment and the checkout', () => {
    expect(readRealRunConfig(env())).toMatchObject({ repository: 'acme/feedback-board', defaultBranch: 'main', baseSha, allowedPaths: ['src', 'public'], budgetLimitUsd: 5, projectId: 'proj_real_local', runId: 'run_real_local' });
    expect(() => readRealRunConfig(env({ SELARIKRU_REAL_REPOSITORY: 'no-slash' }))).toThrow(/owner\/repo/);
    expect(() => readRealRunConfig(env({ SELARIKRU_REAL_BASE_BRANCH: 'absent' }))).toThrow(/does not exist/);
    const { SELARIKRU_REAL_REPOSITORY: _r, ...missing } = env();
    expect(() => readRealRunConfig(missing)).toThrow(/SELARIKRU_REAL_REPOSITORY/);
  });

  it('seeds the project and run idempotently, in planning, and writes a policy that allows a draft PR with the real base commit', async () => {
    await resetDb(t.db);
    const cfg = readRealRunConfig(env({ SELARIKRU_TENANT_ID: 'tenant_real' }));
    expect(await seedRealRun(t.db, cfg)).toEqual({ created: true });
    expect(await seedRealRun(t.db, cfg)).toEqual({ created: false });
    const runs = await t.db.select().from(schema.runs).where(eq(schema.runs.tenantId, 'tenant_real'));
    expect(runs).toEqual([expect.objectContaining({ runId: cfg.runId, lifecycle: 'planning', budget: { limitUsd: 5 } })]);
    const project = await t.db.select().from(schema.projects).where(eq(schema.projects.tenantId, 'tenant_real'));
    expect(project).toEqual([expect.objectContaining({ repository: 'acme/feedback-board', defaultBranch: 'main' })]);
    await expect(seedRealRun(t.db, { ...cfg, repository: 'other/repo' })).rejects.toThrow(/already targets/);

    const dir = join(root, 'real');
    const { planConfigFile, policyFile } = writeRealRunFiles(dir, cfg);
    expect(evaluate({ kind: 'create_draft_pr' }, parsePolicy(JSON.parse(readFileSync(policyFile, 'utf8'))))).toMatchObject({ decision: 'allow' });
    const settings = ProjectPlanSettingsSchema.parse((JSON.parse(readFileSync(planConfigFile, 'utf8')) as { projects: Record<string, unknown> }).projects[cfg.projectId]);
    expect(settings.baseSha).toBe(baseSha);
    expect(settings.allowedPaths).toEqual(['src', 'public']);
  });

  it('leaves control mode off unless asked, and a grant changes the policy version that tasks are pinned to', () => {
    const read = (dir: string, cfg: ReturnType<typeof readRealRunConfig>) => {
      const { planConfigFile, policyFile } = writeRealRunFiles(join(root, dir), cfg);
      const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { policyVersion: string; operations: Record<string, string> };
      return { policy, plan: (JSON.parse(readFileSync(planConfigFile, 'utf8')) as { projects: Record<string, { policyVersion: string }> }).projects[cfg.projectId]! };
    };
    const off = read('off', readRealRunConfig(env()));
    const on = read('on', readRealRunConfig(env({ SELARIKRU_REAL_TERMINAL_CONTROL: '1' })));
    expect(off.policy.operations['terminal_control']).toBe('deny');
    expect(on.policy.operations['terminal_control']).toBe('allow');
    expect(on.policy.policyVersion).not.toBe(off.policy.policyVersion);
    expect(on.plan.policyVersion).toBe(on.policy.policyVersion);
    expect(off.plan.policyVersion).toBe(off.policy.policyVersion);
  });
});

describe('the API host', () => {
  it('starts and serves with no `claude` on its PATH, and reports nothing until a runner does', async () => {
    const path = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      await withServer({}, async (address) => {
        const res = await fetch(`${address}/v1/projects/proj_a/snapshot`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
        expect(res.status).toBe(200);
        const catalog = ((await res.json()) as { modelCatalog: { status: string; providers: unknown[]; detail: string } }).modelCatalog;
        expect(catalog).toMatchObject({ status: 'none', providers: [] });
        expect(catalog.detail).toMatch(/No runner has reported/);
      });
    } finally {
      process.env['PATH'] = path;
    }
  });
});
