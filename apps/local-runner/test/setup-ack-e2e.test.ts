/**
 * T7.6 against the real control API with a real clock: a runner whose setup-complete call never lands (and whose result is lost too) starts no worker, so the server's reading
 * of "no setup acknowledged" as a setup interruption is true, and its release of the hold costs nothing that was spent. The runner and the API run in this process; the
 * control-api package cannot import the runner, so the test lives here.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, PROJECT, enrolRunner, fakeVerifier, resetDb, seedTask, setupTestDb, specFor, testConfig, type TestDb } from '@selarikru/control-api/test-helpers';
import { createScheduler } from '@selarikru/workflow';
import { CLOUD_POLICY, TEST_CATALOG } from '@selarikru/workflow/test-helpers';
import { HttpRunnerApi, type RunnerApi } from '../src/api.ts';
import { runAttempt } from '../src/attempt.ts';
import { makeWorld } from './world.ts';

const POLICY = { ...CLOUD_POLICY, operations: { ...API_POLICY.operations } } as unknown as NonNullable<Parameters<typeof createScheduler>[0]['policy']>;

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('a setup the server never acknowledged (T7.6)', () => {
  it('starts no worker, and the server reaps it as the setup\'s interruption with the hold released', async () => {
    await resetDb(t.db);
    await t.db.execute(sql`DELETE FROM runners`);
    const now = () => new Date();
    const app = buildApp({ config: testConfig(), db: t.db, verifier: fakeVerifier, now, policy: POLICY, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now, policy: POLICY }), catalog: TEST_CATALOG });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    // A worker that would run silently past the deadline, if it were ever launched.
    const w = await makeWorld({ agent: async () => { await new Promise((r) => setTimeout(r, 1500)); return false; } });
    try {
      await seedTask(t.db, specFor('T1', { baseSha: w.sha, allowedPaths: ['src'], projectId: PROJECT, timeoutSeconds: 5 }));
      const local = await enrolRunner(app, 'local');
      const real = new HttpRunnerApi(base, local.token);
      // The network drops the setup-complete call and the result, every time.
      const api = new Proxy(real, {
        get(target, prop) {
          if (prop === 'setupComplete' || prop === 'result') return async () => { throw new Error('network blip'); };
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as RunnerApi;
      const claimed = await api.claim();
      const report = await runAttempt({ api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { [PROJECT]: w.repo }, heartbeatMs: 50, maxMissedHeartbeats: 3, maxTurns: 4, cpus: 2, memoryMiB: 4096, log: (l) => w.logs.push(l) }, claimed.lease!);
      // Fail closed: no worker stream was ever opened.
      expect(w.sbx.streams).toHaveLength(0);
      expect(w.logs.join('\n')).toMatch(/setup could not be confirmed/);
      expect(report.outcome).toBe('lease_lost'); // its result could not be delivered either
      const [before] = await t.db.execute(sql`SELECT ended_at, detail FROM attempts`);
      expect(before!['ended_at']).toBeNull();
      expect((before!['detail'] as { setupCompletedAt?: unknown }).setupCompletedAt).toBeUndefined();
      // The server's deadline passes and its reaper decides.
      await createScheduler({ catalog: TEST_CATALOG, db: t.db, now, policy: POLICY }).expireLeases(new Date(Date.now() + 6_000));
      expect((await t.db.execute(sql`SELECT outcome, exit_reason FROM attempts`))[0]).toMatchObject({ outcome: 'interrupted', exit_reason: 'infrastructure:attempt timeout reached during setup' });
      expect((await t.db.execute(sql`SELECT status FROM task_status`))[0]).toMatchObject({ status: 'ready' });
      expect((await t.db.execute(sql`SELECT state FROM budget_reservations`))[0]).toMatchObject({ state: 'released' });
    } finally {
      await app.close();
      await w.cleanup();
    }
  });
});
