/** The record, end to end: real control API over HTTP, real Compose Postgres, the real runner, and a scripted harness that captures its launch arguments. No model is called. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, TEST_CATALOG, enrolRunner, fakeVerifier, testConfig, PROJECT, resetDb, seedTask, setupTestDb, specFor, owner, type TestDb } from '@selarikru/control-api/test-helpers';
import { createScheduler } from '@selarikru/workflow';
import { POLICY } from '@selarikru/workflow/test-helpers';
import { HttpRunnerApi} from '../src/api.ts';
import { runAttempt, type AttemptDeps, type RunnerHarness } from '../src/attempt.ts';
import { makeWorld, type World } from './world.ts';

const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' };

describe('assigned model reaches the harness', () => {
  let t: TestDb;
  let w: World | undefined;
  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.db); });
  afterEach(async () => { await w?.cleanup(); w = undefined; });

  const apiFor = async () => {
    const app = buildApp({ config: testConfig(), db: t.db, verifier: fakeVerifier, now: () => new Date(), policy: API_POLICY, catalog: TEST_CATALOG, scheduler: createScheduler({ codingWorkers: 'claude_code', db: t.db, now: () => new Date(), policy: POLICY, catalog: TEST_CATALOG }) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { token, runnerId } = await enrolRunner(app, 'local');
    return { app, runnerId, api: new HttpRunnerApi(`http://127.0.0.1:${port}`, token) };
  };
  const deps = (world: World, api: AttemptDeps['api'], over: Partial<AttemptDeps> = {}): AttemptDeps => ({
    api, runtime: world.runtime, artifacts: world.artifacts, workRoot: world.workRoot, repos: { [PROJECT]: world.repo, [world.task.projectId]: world.repo }, codingWorkers: 'claude_code', heartbeatMs: 10_000, maxMissedHeartbeats: 6, maxTurns: 4, cpus: 2, memoryMiB: 4096, log: () => undefined, ...over,
  });
  const launchArgs = (world: World): string[] => world.sbx.calls.find((c) => c[0] === 'exec' && c.includes('claude'))!;

  it('assigned model is the model the harness receives', async () => {
    const world = (w = await makeWorld({ task: { allowedPaths: ['src'] }, initModel: 'claude-opus-5-5' }));
    await seedTask(t.db, specFor('t1', { baseSha: world.sha, allowedPaths: ['src'], role: 'backend', maxCostUsd: 1 }), 'ready');
    const { app, api } = await apiFor();
    try {
      const assigned = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/model-assignments`, payload: { scope: 'role', key: 'backend', selection: OPUS, expectedRevision: 0, idempotencyKey: 'pick' }, headers: owner() });
      expect(assigned.statusCode).toBe(200);
      const claim = await api.claim();
      expect(claim.lease?.assignment).toEqual({ ...OPUS, source: 'role', route: 'cloud' });
      const report = await runAttempt(deps(world, api), claim.lease!);
      expect(report).toMatchObject({ outcome: 'completed' });
      const args = launchArgs(world);
      expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
      expect(args.filter((a) => a === '--model')).toHaveLength(1);
      const row = (await t.db.execute(sql`SELECT model_provider, model_id, model_route, assignment_source FROM attempts`))[0]!;
      expect(row).toEqual({ model_provider: 'anthropic', model_id: 'claude-opus-5-5', model_route: 'cloud', assignment_source: 'role' });
      // The same record the badge reads: a later change does not rewrite it.
      const events = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'attempt.started'`);
      expect(events[0]!['payload']).toMatchObject({ modelRoute: 'cloud', assignment: { ...OPUS, source: 'role' } });
    } finally {
      await app.close();
    }
  });

  it('fails the attempt when the stream reports a different model from the record', async () => {
    const world = (w = await makeWorld({ assignment: { ...OPUS, source: 'role', route: 'cloud' }, agent: async () => undefined }));
    // The scripted init event reports claude-sonnet-5-5; this attempt was recorded as opus.
    const report = await runAttempt(deps(world, world.api), world.lease);
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/^model_mismatch: recorded claude-opus-5-5, the stream reports claude-sonnet-5-5/);
    expect(world.api.published[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('an init event that names no model stops the attempt as unverified', async () => {
    const world = (w = await makeWorld({ initModel: null }));
    const report = await runAttempt(deps(world, world.api), world.lease);
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/^model_unverified: recorded claude-sonnet-5-5/);
  });

  it('an attempt whose stream never sent an init event cannot complete', async () => {
    const world = (w = await makeWorld({ noInit: true }));
    const report = await runAttempt(deps(world, world.api), world.lease);
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/^model_unverified: .*never reported a model/);
  });

  it('a runner sends its report with each claim, and one without the model is refused', async () => {
    const world = (w = await makeWorld({}));
    await seedTask(t.db, specFor('t1', { baseSha: world.sha, allowedPaths: ['src'] }), 'ready');
    // Runners enrolled by earlier tests still report the model; this one must be the only runner.
    await t.db.execute(sql`DELETE FROM runners`);
    const { app, api, runnerId } = await apiFor();
    try {
      const without = await api.claim([{ provider: 'anthropic', harnessVersion: '2.1.316', models: ['claude-haiku-5-5'] }]);
      expect(without.lease).toBeNull();
      const row = (await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`))[0]!;
      expect(row['placement_block']).toBe('model_not_on_runner:anthropic/claude-sonnet-5-5');
      expect(await t.db.execute(sql`SELECT 1 FROM attempts`)).toHaveLength(0);
      const stored = (await t.db.execute(sql`SELECT harness_report FROM runners WHERE runner_id = ${runnerId}`))[0]!;
      expect(stored['harness_report']).toEqual([{ provider: 'anthropic', harnessVersion: '2.1.316', models: ['claude-haiku-5-5'] }]);
      const able = await api.claim([{ provider: 'anthropic', harnessVersion: '2.1.316', models: ['claude-sonnet-5-5'] }]);
      expect(able.lease?.assignment?.model).toBe('claude-sonnet-5-5');
    } finally {
      await app.close();
    }
  });

  it('refuses a model it cannot launch before any sandbox exists', async () => {
    for (const [assignment, code] of [
      [{ provider: 'codex', model: 'gpt-x', source: 'role', route: 'cloud' }, 'unsupported_provider:codex/gpt-x'],
      [{ provider: 'anthropic', model: 'claude-made-up', source: 'role', route: 'cloud' }, 'unsupported_model:anthropic/claude-made-up'],
    ] as const) {
      const world = (w = await makeWorld({ assignment }));
      const report = await runAttempt(deps(world, world.api), world.lease);
      expect(report).toMatchObject({ outcome: 'blocked', reason: code });
      expect(world.sbx.calls.filter((c) => c[0] === 'create')).toEqual([]);
      expect(world.sbx.streams).toHaveLength(0);
      await world.cleanup();
      w = undefined;
    }
    const world = (w = await makeWorld({ assignment: null }));
    expect(await runAttempt(deps(world, world.api), world.lease)).toMatchObject({ outcome: 'blocked', reason: expect.stringMatching(/^no_model_recorded/) });
  });

  it('the seam accepts another adapter, and that adapter receives the recorded model', async () => {
    const world = (w = await makeWorld({ assignment: { provider: 'test-provider', model: 'test-1', source: 'role', route: 'cloud' } }));
    const received: unknown[] = [];
    const harnesses: readonly RunnerHarness[] = [{
      provider: 'test-provider', models: ['test-1'],
      create: () => ({
        capabilities: () => { throw new Error('unused'); },
        cancel: async (attemptId) => ({ attemptId, status: 'stop_requested', terminationConfirmed: false, detail: null }),
        async *run(input) {
          received.push(input.model);
          yield { type: 'session_started', attemptId: input.attemptId, seq: 0, harnessVersion: null, permissionMode: null, model: 'test-1', initObserved: true, connectedMcpServers: [] };
          yield { type: 'result', attemptId: input.attemptId, seq: 1, subtype: 'success', isError: false, terminalReason: null, numTurns: 1, durationMs: 1 };
          yield { type: 'exit', attemptId: input.attemptId, seq: 2, code: 0, signal: null, failed: false };
        },
      }),
    }];
    const report = await runAttempt(deps(world, world.api, { harnesses }), world.lease);
    expect(report.outcome).toBe('completed');
    expect(received).toEqual([{ provider: 'test-provider', model: 'test-1' }]);
  });
});
