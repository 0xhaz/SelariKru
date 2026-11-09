import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerificationRecordSchema } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { loadValidRecord } from '../../../services/verifier/src/service.ts';
import { ConfigError } from '../src/config.ts';
import { validateGithubOptions } from '../src/server.ts';
import { INTRUDER_TOKEN, PROJECT, RUN, TENANT, bearer, makeHarness, owner, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TRUSTED = { checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64) };
const URL = `/v1/runs/${RUN}/pull-request`;

let t: TestDb;
let h: Harness;
let gh: FakeGitHub;
let dir: string;
let artifacts: LocalDiskArtifactStore;

beforeAll(async () => {
  t = await setupTestDb(8);
  dir = mkdtempSync(join(tmpdir(), 'pr-route-'));
  artifacts = new LocalDiskArtifactStore(dir);
  gh = new FakeGitHub();
  h = makeHarness(t, {}, undefined, {
    github: { pullRequests: { port: gh, repoPath: '/repos/source', loadRecord: (key) => loadValidRecord(t.db, artifacts, key, { trusted: TRUSTED }) } },
  });
  await h.app.ready();
});
afterAll(async () => { await h.app.close(); await t.close(); rmSync(dir, { recursive: true, force: true }); });

/** A ready run whose candidate has a real, stored, applied verification record that `loadValidRecord` accepts. */
async function seedVerified(): Promise<void> {
  await resetDb(t.db);
  gh.calls.length = 0; gh.prs.length = 0; gh.pushes.length = 0; gh.branches.clear(); gh.fastForwards.clear();
  await t.db.execute(sql`UPDATE projects SET repository = 'acme/feedback-board'`);
  await t.db.execute(sql`UPDATE runs SET lifecycle = 'ready_for_review'`);
  await seedTask(t.db, specFor('task_a', { baseSha: BASE }), 'verified');
  await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status)
    VALUES (${TENANT}, ${PROJECT}, 'cand_1', ${RUN}, 'main', ${SHA}, ${BASE}, ${'c'.repeat(40)}, '[{"taskId":"task_a"}]'::jsonb, 'assembled')`);
  const record = VerificationRecordSchema.parse({
    schemaVersion: 1, recordId: 'rec_1', taskId: 'task_a', runId: RUN, partTaskIds: ['task_a'], candidateSha: SHA, candidateTreeSha: 'c'.repeat(40),
    candidateContentSha256: 'd'.repeat(64), baseSha: BASE, contractRevisions: [], ...TRUSTED, toolVersions: {}, configVersions: {}, environmentImageDigest: 'sha256:img',
    host: 'local-docker', fixtures: [], startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', result: 'passed', exitCode: 0,
    results: [{ checkId: 'FB-01', status: 'passed', tests: [{ runner: 'vitest', title: 'creates', status: 'passed' }], failures: [], evidenceReferences: [] }],
    runs: [{ attempt: 1, startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: null, logArtifactId: null }],
    flaky: [], taskOutcomes: [], artifactIds: [], verifier: { kind: 'verifier', id: 'verifier-local-1' },
  });
  const ref = await artifacts.put(Buffer.from(JSON.stringify(record)));
  await t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result)
    VALUES (${TENANT}, ${PROJECT}, 'chk_1', 'task_a', 1, NULL, 'FB-01', '1', ${SHA}, 'passed')`);
  await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator)
    VALUES (${TENANT}, ${PROJECT}, 'rec_1', ${RUN}, 'verification_record', ${ref.sha256}, ${SHA}, 'internal', ${JSON.stringify({ recordId: 'rec_1', candidateSha: SHA, applied: true, checkRunIds: ['chk_1'] })}::jsonb)`);
}
beforeEach(seedVerified);

describe('POST /v1/runs/:id/pull-request', () => {
  it('needs the owner', async () => {
    expect((await h.app.inject({ method: 'POST', url: URL, payload: {} })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: URL, payload: {}, headers: bearer(INTRUDER_TOKEN) })).statusCode).toBe(403);
    expect(gh.calls).toEqual([]);
  });

  it('opens a draft PR for the candidate whose record the real loadValidRecord returns, into the project repository', async () => {
    const res = await h.app.inject({ method: 'POST', url: URL, payload: { repository: 'evil/other' }, headers: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'opened', branch: `selarikru/${RUN}`, candidateSha: SHA, adopted: false });
    expect(gh.pushes).toEqual([{ branch: `selarikru/${RUN}`, sha: SHA }]);
    expect(gh.prs[0]).toMatchObject({ draft: true, baseRef: 'main' });
    expect(gh.prs[0]!.url).toContain('acme/feedback-board');
    const again = await h.app.inject({ method: 'POST', url: URL, payload: {}, headers: owner() });
    expect(again.statusCode).toBe(200);
    expect(gh.prs).toHaveLength(1);
  });

  it('refuses when the record is no longer live', async () => {
    await t.db.execute(sql`UPDATE check_runs SET result = 'invalidated'`);
    const res = await h.app.inject({ method: 'POST', url: URL, payload: {}, headers: owner() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'pull_request_not_allowed', details: { reason: 'no_valid_record' } });
    expect(gh.calls).toEqual([]);
  });

  it('a trial run skips the PR path entirely', async () => {
    await t.db.execute(sql`UPDATE runs SET trial = true`);
    const res = await h.app.inject({ method: 'POST', url: URL, payload: {}, headers: owner() });
    expect(res.json()).toEqual({ status: 'skipped', reason: 'trial' });
    expect(gh.calls).toEqual([]);
  });

  it('exposes no merge route', () => {
    const urls = h.app.routeTable.map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain(`POST /v1/runs/:id/pull-request`);
    expect(urls.filter((u) => /merge/i.test(u))).toEqual([]);
  });
});

describe('github startup configuration', () => {
  const port = {} as never;
  it('fails clearly on a bad poll interval or a secret without a poller', () => {
    for (const pollIntervalMs of [0, -5, Number.NaN, 1.5]) expect(() => validateGithubOptions({ port, pollIntervalMs })).toThrow(ConfigError);
    expect(() => validateGithubOptions({ webhookSecret: 's' })).toThrow(/SELARIKRU_GITHUB_POLL_INTERVAL_MS/);
    expect(() => validateGithubOptions({ pollIntervalMs: 1000 })).toThrow(ConfigError);
    expect(() => validateGithubOptions({ sourceRepoPath: '/r', port })).toThrow(ConfigError);
    expect(() => validateGithubOptions({ webhookSecret: 's', port, pollIntervalMs: 1000 })).not.toThrow();
    expect(() => validateGithubOptions(undefined)).not.toThrow();
  });
});
