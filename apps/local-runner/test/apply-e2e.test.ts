/**
 * H5 end to end, with real sockets: the real control API on a throwaway schema with coding workers off, a real runner enrolment running this runner's own loop over
 * HTTP against the fake sandbox runtime (no sandbox, no model, no network), and the verifier's real assembly driver over the same database, artifact store and repository.
 *
 * The browser's part is played by the same domain code the browser runs: the patch is checked with `checkPatch` against the base files the runner relayed, and the
 * accepted proposal carries its checked results. Verification's verdict is recorded through the workflow's verifier path (`applyVerification`), the step the verifier
 * service takes after running the suite in Docker, which this test does not start.
 */
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkPatch, selectFilesByName, sha256Hex, type AcceptedProposal } from '@selarikru/domain';
import { buildApp } from '@selarikru/control-api';
import { OWNER_TOKEN, PROJECT, enrolRunner, fakeVerifier, resetDb, seedTask, setupTestDb, specFor, testConfig, type TestDb } from '@selarikru/control-api/test-helpers';
import { applyVerification, createScheduler } from '@selarikru/workflow';
import { POLICY, TEST_CATALOG, TENANT, testClock } from '@selarikru/workflow/test-helpers';
import { createAssemblyDriver } from '../../../services/verifier/src/assembly-driver.ts';
import { HttpRunnerApi } from '../src/api.ts';
import type { AttemptDeps } from '../src/attempt.ts';
import { RunnerLoop, harnessReportFor } from '../src/loop.ts';
import { makeWorld, type World } from './world.ts';

let t: TestDb;
let w: World | null = null;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
afterEach(async () => { await w?.cleanup(); w = null; });

const until = async (pred: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const DIFF = [
  '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-export const a = 1;', '+export const a = 2;',
  '--- /dev/null', '+++ b/src/posts.ts', '@@ -0,0 +1 @@', '+export const posts: string[] = [];', '',
].join('\n');

describe('a proposal accepted in the browser becomes a verified candidate, with no model anywhere (H5)', () => {
  it('relay base files, accept, apply with no model, change set, assembled candidate, verified', async () => {
    await resetDb(t.db);
    await t.db.execute(sql`DELETE FROM runners`);
    // Lease deadlines are real time here: the runner arms its own timer from them.
    const clock = testClock(new Date().toISOString());
    const config = testConfig({ codingWorkers: 'off' });
    const app = buildApp({ config, db: t.db, verifier: fakeVerifier, now: clock.now, policy: POLICY, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY, codingWorkers: 'off' }), catalog: TEST_CATALOG });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const stop = new AbortController();
    let running: Promise<void> | null = null;
    try {
      w = await makeWorld();
      execFileSync('git', ['-C', w.repo, 'branch', '-M', 'main']);
      await seedTask(t.db, specFor('T1', { baseSha: w.sha, allowedPaths: ['src'], projectId: PROJECT, requirementIds: ['R1'] }));
      const enrolled = await enrolRunner(app, 'local', []);
      const api = new HttpRunnerApi(base, enrolled.token);
      const spawned: string[] = [];
      const deps: AttemptDeps = {
        api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { [PROJECT]: w.repo },
        heartbeatMs: 20, maxMissedHeartbeats: 3, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l), codingWorkers: 'off', harnesses: [],
      };
      const loop = new RunnerLoop({
        api, runtime: w.runtime, attempt: deps, pollMs: 20, fileRequestMs: 20, log: (l) => w!.logs.push(l),
        // Coding workers off: the Claude probe must never run.
        harnessReport: harnessReportFor('off', async () => { spawned.push('claude --version'); return []; }),
      });
      running = loop.run(stop.signal);
      const owner = { authorization: `Bearer ${OWNER_TOKEN}` };

      // 1. The patch agent's input, in two steps: list what is under the allowed paths (paths and sizes), choose by name, then read only those, by the runner with git,
      // relayed. Nothing is kept.
      const listed = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/tasks/T1/files/list`, headers: owner, payload: {} });
      expect(listed.statusCode).toBe(200);
      const entries = (listed.json() as { entries: { path: string; size: number }[] }).entries;
      expect(entries).toEqual([{ path: 'src/app.ts', size: 20 }]);
      const chosen = selectFilesByName(entries, ['Change the app constant']);
      expect(chosen).toEqual(['src/app.ts']);
      const files = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/tasks/T1/files`, headers: owner, payload: { paths: chosen } });
      expect(files.statusCode).toBe(200);
      const given = (files.json() as { files: { path: string; content: string }[]; baseSha: string }).files;
      expect(given).toEqual([{ path: 'src/app.ts', content: 'export const a = 1;\n' }]);

      // 2. The browser's check of the agent's diff against those files gives the results an accept carries.
      const checked = checkPatch(DIFF, { allowedPaths: ['src'], files: new Map(given.map((f) => [f.path, f.content])) });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      const proposal: AcceptedProposal = {
        proposalId: 'req_e2e', taskId: 'T1', taskRevision: 1, baseSha: w.sha, routeRecordId: 'req_e2e', diff: DIFF,
        results: [...checked.results].map(([path, content]) => ({ path, sha256: content === null ? null : sha256Hex(content), content })),
      };
      // The browser's route record of the patch call (route.report).
      await t.db.execute(sql`INSERT INTO client_reports (tenant_id, project_id, report_id, subject_kind, subject_id, kind, trust, payload, reported_by)
        VALUES (${TENANT}, ${PROJECT}, 'rpt_e2e', 'task', 'T1', 'route', 'untrusted', ${JSON.stringify({ requestId: 'req_e2e', stepKind: 'patch', status: 'ok', outputSha256: sha256Hex(DIFF) })}::jsonb, 'owner')`);

      // 3. Accept.
      const accepted = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/tasks/T1/proposals/accept`, headers: owner, payload: { idempotencyKey: 'e2e', proposal } });
      expect(accepted.statusCode).toBe(201);

      // 4. The apply attempt: claimed through the runner's own loop, results written, change set published. The task waits for verification.
      const status = async () => String((await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 'T1'`))[0]!['status']);
      await until(async () => (await status()) === 'verifying');
      const [attempt] = await t.db.execute(sql`SELECT attempt_id, revision, model_provider, model_id, model_route, detail FROM attempts WHERE task_id = 'T1'`);
      expect(attempt).toMatchObject({ model_provider: 'selarikru', model_id: 'apply-proposal', model_route: 'none' });
      const manifestSha = (attempt!['detail'] as { changeManifestSha256: string }).changeManifestSha256;
      const manifest = JSON.parse(Buffer.from((await w.artifacts.get(manifestSha))!).toString()) as { changes: { path: string; sha256: string }[] };
      expect(manifest.changes.map((c) => [c.path, c.sha256])).toEqual(proposal.results.map((r) => [r.path, r.sha256]));

      // 5. Candidate assembly by the verifier's driver, from the published change set.
      const tick = await createAssemblyDriver({ db: t.db, artifacts: w.artifacts, tenantId: TENANT, repoPath: w.repo, workRoot: `${w.root}/assembly` }).tick();
      expect(tick.failed).toEqual([]);
      expect(tick.assembled).toHaveLength(1);
      const sha = tick.assembled[0]!;
      expect(execFileSync('git', ['-C', w.repo, 'show', `${sha}:src/app.ts`], { encoding: 'utf8' })).toBe('export const a = 2;\n');
      expect(execFileSync('git', ['-C', w.repo, 'show', `${sha}:src/posts.ts`], { encoding: 'utf8' })).toBe('export const posts: string[] = [];\n');

      // 6. Verification's verdict on that candidate's part.
      const applied = await applyVerification({ db: t.db, now: clock.now }, { tenantId: TENANT, projectId: PROJECT, taskId: 'T1' }, {
        actor: { kind: 'verifier', id: 'verifier-e2e' }, outcome: 'passed', detail: { candidateSha: sha }, expect: { revision: Number(attempt!['revision']), attemptId: String(attempt!['attempt_id']) },
      });
      expect(applied).toMatchObject({ applied: true, taskStatus: 'verified' });

      // The change a review and a PR description read is the applied diff.
      const ctx = await app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/tasks/T1/context?destination=local`, headers: owner });
      expect((ctx.json() as { change: { diff: string } | null }).change?.diff).toBe(DIFF);
      // No model process was started anywhere, and the only sandbox streams were none at all: this base has no toolchain to build with.
      expect(spawned).toEqual([]);
      expect(w.sbx.streams).toHaveLength(0);
      const types = (await t.db.execute(sql`SELECT type FROM events ORDER BY sequence`)).map((r) => String(r['type']));
      expect(types).toEqual(expect.arrayContaining(['proposal.accepted', 'attempt.started', 'attempt.completed', 'candidate.assembled']));
      expect(JSON.stringify(await t.db.execute(sql`SELECT payload FROM events`))).not.toContain('posts: string[]');
    } finally {
      stop.abort();
      await running;
      await app.close();
    }
  });
});
