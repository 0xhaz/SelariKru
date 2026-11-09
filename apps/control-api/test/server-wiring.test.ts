/** What the documented environment actually starts, through `startServer` rather than `buildApp`. Never reaches GitHub: the port is a fake and the run is not ready. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { schema } from '@selarikru/persistence';
import { TEST_DATABASE_URL } from '@selarikru/workflow/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { evaluate, parsePolicy } from '@selarikru/policy';
import { ProjectPlanSettingsSchema } from '../src/index.ts';
import { readRealRunConfig, seedRealRun, writeRealRunFiles } from '../src/real-run.ts';
import { githubOptionsFromEnv, startServer, type RunningServer } from '../src/server.ts';
import { OWNER_TOKEN, RUN, fakeVerifier, resetDb, setupTestDb, testConfig, type TestDb } from './helpers.ts';

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

describe('real-run seed', () => {
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
});
