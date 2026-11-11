/**
 * Checkpoint continuation end to end with real sockets: the real control API on a throwaway schema, and two real runner enrolments, one `local` and one `cloud`, each
 * running the runner's own attempt code over HTTP against the fake sandbox runtime. No cloud adapter is mocked: the cloud runner is the same binary's code with a cloud
 * enrolment, and drives its own poll loop (`RunnerLoop`). It runs in this process: a separate runner process would need the fake sandbox runtime injected into the binary,
 * which `main.ts` does not offer. Hosted cloud infrastructure (and the release gate on it) is T7.3.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, OWNER_TOKEN, PROJECT, enrolRunner, fakeVerifier, resetDb, seedTask, setupTestDb, specFor, testConfig, type TestDb } from '@selarikru/control-api/test-helpers';
import { createScheduler } from '@selarikru/workflow';
import { CLOUD_POLICY, TEST_CATALOG, testClock } from '@selarikru/workflow/test-helpers';
import { HttpRunnerApi, LeaseLostError } from '../src/api.ts';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { RunnerLoop } from '../src/loop.ts';
import { makeWorld, type World } from './world.ts';

/** The cloud test policy with the API's own operations. Typed through the scheduler's context: this package does not depend on the policy package. */
const POLICY = { ...CLOUD_POLICY, operations: { ...API_POLICY.operations } } as unknown as NonNullable<Parameters<typeof createScheduler>[0]['policy']>;
const SECRET = 'sk_live_CANARY0123456789abcdefXYZ';

let t: TestDb;
let w: World | null = null;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
afterEach(async () => { await w?.cleanup(); w = null; });

const until = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('continue in cloud, two real runner enrolments', () => {
  it('the local attempt stops and checkpoints, is fenced, and the cloud runner continues from the checked checkpoint; the prior attempt cannot publish after', async () => {
    await resetDb(t.db);
    await t.db.execute(sql`DELETE FROM runners`);
    await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'H2', cloudDestination: 'cloud-sandbox-eu' })}::jsonb`);
    // Lease deadlines are real time here: the runner arms its own timer from them.
    const clock = testClock(new Date().toISOString());
    const app = buildApp({ config: testConfig(), db: t.db, verifier: fakeVerifier, now: clock.now, policy: POLICY, scheduler: createScheduler({ codingWorkers: 'claude_code', catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY }), catalog: TEST_CATALOG });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      let streams = 0;
      let wrote = false;
      let carried: string | null = null;
      w = await makeWorld({
        agent: async ({ cwd, write }) => {
          streams += 1;
          if (streams === 1) {
            // The local worker: some work inside its paths, a secret file and a note outside them, then it keeps going until it is stopped.
            await write('src/feature.ts', 'export const feature = 1;\n');
            await write('.env', `API_KEY=${SECRET}\n`);
            wrote = true;
            return false;
          }
          // The cloud worker finds the carried work in its workspace and finishes the task.
          carried = await readFile(join(cwd, 'src/feature.ts'), 'utf8').catch(() => null);
          await write('src/more.ts', 'export const more = 2;\n');
        },
      });
      await seedTask(t.db, specFor('T1', { baseSha: w.sha, allowedPaths: ['src'], projectId: PROJECT }));
      const local = await enrolRunner(app, 'local');
      const cloud = await enrolRunner(app, 'cloud');
      const deps = (api: HttpRunnerApi): AttemptDeps => ({
        api, runtime: w!.runtime, artifacts: w!.artifacts, workRoot: w!.workRoot, repos: { [PROJECT]: w!.repo },
        codingWorkers: 'claude_code', heartbeatMs: 20, maxMissedHeartbeats: 3, maxTurns: 8, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l),
      });
      const localApi = new HttpRunnerApi(base, local.token);
      const cloudApi = new HttpRunnerApi(base, cloud.token);

      const first = await localApi.claim();
      expect(first.lease).toMatchObject({ taskId: 'T1' });
      const prior = runAttempt(deps(localApi), first.lease!);
      await until(() => wrote);

      const asked = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/tasks/T1/handover`, headers: { authorization: `Bearer ${OWNER_TOKEN}` }, payload: { mode: 'resume', idempotencyKey: 'e2e-1' } });
      expect(asked.statusCode).toBe(202);
      // While the prior attempt is open, the cloud runner gets nothing.
      expect((await cloudApi.claim()).lease).toBeNull();

      const priorReport = await prior;
      expect(priorReport.outcome).toBe('failed');
      // The checkpoint waits for the owner's review, with its line diff; nothing may claim before the release.
      const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
      const review = (await app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/tasks/T1/handover`, headers: owner })).json() as { current: { state: string; checkpointId: string; patch: { files: { path: string; added: number }[] } } };
      expect(review.current).toMatchObject({ state: 'awaiting_review', patch: { files: [{ path: 'src/feature.ts', added: 2 }] } });
      expect((await cloudApi.claim()).lease).toBeNull();
      const released = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/tasks/T1/handover/decision`, headers: owner, payload: { checkpointId: review.current.checkpointId, choice: 'release', idempotencyKey: 'e2e-r' } });
      expect(released.statusCode).toBe(200);

      // The cloud runner takes it through its own poll loop, as the runner process does, and runs it to completion.
      const reports: string[] = [];
      const stop = new AbortController();
      const loop = new RunnerLoop({ api: cloudApi, runtime: w.runtime, attempt: deps(cloudApi), pollMs: 20, log: (l) => { reports.push(l); w!.logs.push(l); } });
      const running = loop.run(stop.signal);
      try {
        await until(async () => (await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 'T1'`))[0]!['status'] === 'verifying', 20_000);
      } finally {
        stop.abort();
        await running;
      }
      expect(carried).toBe('export const feature = 1;\n');
      const [succ] = await t.db.execute(sql`SELECT attempt_id, lease_fence, detail FROM attempts WHERE attempt_id <> ${first.lease!.attemptId} ORDER BY attempt_number DESC LIMIT 1`);
      const second = { lease: { attemptId: String(succ!['attempt_id']) } };
      expect(Number(succ!['lease_fence'])).toBe(first.lease!.fence + 1);
      expect((succ!['detail'] as { location?: string }).location).toBe('cloud');
      const manifestSha = (succ!['detail'] as { changeManifestSha256?: string }).changeManifestSha256!;
      const report = { changeManifest: manifestSha };

      // The combined candidate: the carried file and the cloud worker's own, never the secret file.
      const manifest = JSON.parse(Buffer.from((await w.artifacts.get(report.changeManifest!))!).toString()) as { changes: { path: string }[] };
      expect(manifest.changes.map((c) => c.path)).toEqual(['src/feature.ts', 'src/more.ts']);
      const [status] = await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 'T1'`);
      expect(status!['status']).toBe('verifying');

      // The fence came before the successor's start, and the prior attempt cannot publish after the handover.
      const log = (await t.db.execute(sql`SELECT sequence, type, attempt_id FROM events ORDER BY sequence`)).map((r) => ({ seq: Number(r['sequence']), type: String(r['type']), attemptId: r['attempt_id'] }));
      const fenced = log.find((e) => e.type === 'attempt.fenced')!;
      const started = log.find((e) => e.type === 'attempt.started' && e.attemptId === second.lease!.attemptId)!;
      expect(fenced.seq).toBeLessThan(started.seq);
      await expect(localApi.result({ attemptId: first.lease!.attemptId, fence: first.lease!.fence, leaseToken: first.lease!.leaseToken }, { outcome: 'completed', headSha: 'c'.repeat(40) })).rejects.toBeInstanceOf(LeaseLostError);
      const [row] = await t.db.execute(sql`SELECT state, exclusions, late_publishes FROM checkpoints`);
      // The successor completed: the handover closed, its stored copy dropped, and the one late publish recorded.
      expect(row).toMatchObject({ state: 'closed', exclusions: [{ path: '.env', reason: 'secret_file_name' }], late_publishes: 1 });
      const everything = JSON.stringify([log, row, w.logs, await t.db.execute(sql`SELECT payload FROM events`)]);
      expect(everything).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});
