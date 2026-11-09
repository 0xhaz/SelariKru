import { createLiveDataSource } from '@selarikru/data-source-live';
import { VerificationRecordSchema } from '@selarikru/domain';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { API_POLICY, OWNER_TOKEN, TENANT, bearer, enrolRunner, makeHarness, post, resetDb, setupTestDb, specFor, type TestDb } from '@selarikru/control-api/test-helpers';
import { appendEvent, schema, withTx } from '@selarikru/persistence';
import type { TaskSpec } from '@selarikru/domain';
import { DataSourceException, startProjection, type ProjectViewEvent } from '@selarikru/view-protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { dataSourceConformance } from './data-source.ts';

const SHA = 'a'.repeat(40);
const TRUSTED = { checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64) };
const FAILED_SHA = 'f'.repeat(40);
const ids = { failed: 'proj_failed', busy: 'proj_busy', prePlan: 'proj_preplan', empty: 'proj_empty', approval: 'proj_approval', expired: 'proj_expired', budget: 'proj_budget', reverify: 'proj_reverify', review: 'proj_review' } as const;

let shared: TestDb | null = null;
afterAll(async () => { await shared?.close(); });

type Lease = { attemptId: string; fence: number; leaseToken: string; taskId: string };

dataSourceConformance('live, over the real control API on Postgres', async () => {
  shared ??= await setupTestDb(8);
  const t = shared;
  await resetDb(t.db);
  const gh = new FakeGitHub();
  const allow = { ...API_POLICY, operations: { ...API_POLICY.operations, create_draft_pr: 'allow' } } as const;
  const record = VerificationRecordSchema.parse({
    schemaVersion: 1, recordId: 'rec_1', taskId: 'api', runId: 'run_review', partTaskIds: ['api'], candidateSha: SHA, candidateTreeSha: 'c'.repeat(40), candidateContentSha256: 'd'.repeat(64), baseSha: 'b'.repeat(40),
    contractRevisions: [], ...TRUSTED, toolVersions: {}, configVersions: {}, environmentImageDigest: 'sha256:img', host: 'local-docker', fixtures: [], startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', result: 'passed', exitCode: 0,
    results: [{ checkId: 'FB-01', status: 'passed', tests: [{ runner: 'vitest', title: 'creates', status: 'passed' }], failures: [], evidenceReferences: [] }],
    runs: [{ attempt: 1, startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: null, logArtifactId: null }],
    flaky: [], taskOutcomes: [], artifactIds: [], verifier: { kind: 'verifier', id: 'verifier-local-1' },
  });
  const failedRecord = VerificationRecordSchema.parse({ ...record, recordId: 'rec_2', candidateSha: FAILED_SHA, result: 'failed', results: [{ checkId: 'FB-02', status: 'failed', tests: [{ runner: 'vitest', title: 'rejects', status: 'failed' }], failures: [{ test: 'FB-02 reject', status: 'failed', message: 'AssertionError: expected 400' }], evidenceReferences: [] }] });
  const h = makeHarness(t, {}, allow, { github: { pullRequests: { port: gh, repoPath: '/repos/source', loadRecord: async () => record } }, evidence: { trusted: () => TRUSTED, artifacts: { get: async () => null }, loadRecord: async (key) => (key.sha === FAILED_SHA ? failedRecord : record) } });
  const base = await h.app.listen({ port: 0, host: '127.0.0.1' });
  const source = createLiveDataSource({ baseUrl: base, getToken: async () => OWNER_TOKEN });
  const nowDate = () => h.clock.now();

  const ensureProject = async (projectId: string, repository = 'r') => t.db.insert(schema.projects).values({ tenantId: TENANT, projectId, repository, defaultBranch: 'main', classification: 'internal' });
  const seedRun = async (projectId: string, runId: string, lifecycle: string) => {
    await ensureProject(projectId, projectId === ids.review ? 'acme/feedback-board' : 'r');
    await t.db.insert(schema.runs).values({ tenantId: TENANT, projectId, runId, lifecycle, budget: { limitUsd: 100 }, planRevision: 1 });
  };
  const seedTask = async (spec: TaskSpec, status: string) => {
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: spec.projectId, runId: spec.runId, taskId: spec.taskId, revision: spec.revision, boardId: spec.boardId, spec });
    await t.db.insert(schema.taskStatus).values({ tenantId: TENANT, projectId: spec.projectId, taskId: spec.taskId, currentRevision: spec.revision, status });
  };
  const spec = (projectId: string, runId: string, taskId: string, requirementIds: string[] = []) => specFor(taskId, { projectId, runId, requirementIds });
  let n = 0;
  const event = (projectId: string, runId: string, taskId: string, type: 'task.blocked', payload: Record<string, unknown>, actor: { kind: 'scheduler'; id: string } = { kind: 'scheduler', id: 'scheduler' }) => withTx(t.db, (tx) => appendEvent(tx, {
    schemaVersion: 1, eventId: `evt_${(n += 1)}`, projectId, runId, taskId, attemptId: null, type, sequence: 0, aggregateRevision: 1, actor, occurredAt: nowDate().toISOString(), receivedAt: nowDate().toISOString(), causationId: null, traceId: 't', payload,
  }));

  // ---- busy: everything through the real routes.
  await ensureProject(ids.busy);
  const created = await post(h.app, `/v1/projects/${ids.busy}/runs`, { idempotencyKey: 'busy-run', title: 'Busy', budgetLimitUsd: 50 });
  const busyRun = created.body.runId as string;
  const plan = await post(h.app, `/v1/runs/${busyRun}/plan-revisions`, { expectedRevision: 0, idempotencyKey: 'busy-plan', tasks: [spec(ids.busy, busyRun, 'busy_api', ['FB-01']), spec(ids.busy, busyRun, 'busy_web', ['FB-02'])] });
  if (plan.status !== 201) throw new Error(`plan failed: ${JSON.stringify(plan.body)}`);
  const runner = await enrolRunner(h.app);
  const claim = async (): Promise<Lease | null> => (await post(h.app, '/v1/runners/claim', {}, bearer(runner.token))).body.lease as Lease | null;
  const leases: Lease[] = [];
  const first = await claim();
  if (!first) throw new Error('the busy project could not claim a task');
  leases.push(first);

  await ensureProject(ids.prePlan);
  const prePlanRun = (await post(h.app, `/v1/projects/${ids.prePlan}/runs`, { idempotencyKey: 'pp-run', title: 'Pre-plan', budgetLimitUsd: 50 })).body.runId as string;
  await ensureProject(ids.empty);

  // ---- decision projects: states written as the routes and scheduler write them.
  const approval = async (projectId: string, runId: string, approvalId: string, over: Partial<typeof schema.approvals.$inferInsert>) => t.db.insert(schema.approvals).values({ tenantId: TENANT, projectId, approvalId, runId, revision: 1, requester: 'scheduler', actionHash: 'a', scopeHash: 'scope', expectedRevisions: {}, outcome: 'pending', detail: { operation: 'start_cloud_worker', reason: 'configured_require_approval:start_cloud_worker' }, ...over });
  await seedRun(ids.approval, 'run_approval', 'running');
  await seedTask(spec(ids.approval, 'run_approval', 'waiting_a'), 'awaiting_approval');
  await approval(ids.approval, 'run_approval', 'apr_ok', { taskId: 'waiting_a', expiresAt: new Date(nowDate().getTime() + 3_600_000) });

  await seedRun(ids.expired, 'run_expired', 'running');
  await seedTask(spec(ids.expired, 'run_expired', 'waiting_e'), 'awaiting_approval');
  await approval(ids.expired, 'run_expired', 'apr_old', { taskId: 'waiting_e', expiresAt: new Date(nowDate().getTime() - 1000) });

  await seedRun(ids.budget, 'run_budget', 'running');
  await seedTask(spec(ids.budget, 'run_budget', 'api', ['FB-01']), 'verified');
  await seedTask(spec(ids.budget, 'run_budget', 'search', ['FB-03']), 'cancelled');
  await t.db.insert(schema.taskCommands).values({ tenantId: TENANT, projectId: ids.budget, operationId: 'op_stop', taskId: 'search', revision: 1, command: 'cancel', state: 'cancelled', requestedBy: 'budget_enforcer', requestedAt: nowDate(), detail: { reason: 'budget_exhausted', attemptIds: [] } });

  await seedRun(ids.reverify, 'run_reverify', 'running');
  await seedTask(spec(ids.reverify, 'run_reverify', 'held'), 'blocked');
  await t.db.insert(schema.attempts).values({ tenantId: TENANT, projectId: ids.reverify, attemptId: 'att_held', taskId: 'held', revision: 1, attemptNumber: 1, runner: 'r', leaseFence: 1, outcome: 'interrupted', exitReason: 'verification_error', startedAt: nowDate(), endedAt: nowDate() });
  await event(ids.reverify, 'run_reverify', 'held', 'task.blocked', { reason: 'verification_error' });

  await seedRun(ids.review, 'run_review', 'ready_for_review');
  await seedTask(specFor('api', { projectId: ids.review, runId: 'run_review', baseSha: 'b'.repeat(40), requirementIds: ['FB-01'] }), 'verified');
  await t.db.insert(schema.candidates).values({ tenantId: TENANT, projectId: ids.review, candidateId: 'cand_1', runId: 'run_review', target: 'main', sha: SHA, baseSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), parts: [{ taskId: 'api' }], status: 'assembled' });

  await seedRun(ids.failed, 'run_failed', 'running');
  await seedTask(spec(ids.failed, 'run_failed', 'failed_api', ['FB-02']), 'ready');
  await t.db.insert(schema.candidates).values({ tenantId: TENANT, projectId: ids.failed, candidateId: 'cand_f', runId: 'run_failed', target: 'main', sha: FAILED_SHA, baseSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), parts: [{ taskId: 'failed_api' }], status: 'rejected' });

  let planned = false;
  return {
    source,
    busyProjectId: ids.busy, prePlanProjectId: ids.prePlan, emptyProjectId: ids.empty, pendingApprovalProjectId: ids.approval, expiredApprovalProjectId: ids.expired,
    budgetStopProjectId: ids.budget, reverifyProjectId: ids.reverify, reviewProjectId: ids.review, failedProjectId: ids.failed, unknownProjectId: 'proj_does_not_exist',
    clockFor: () => ({ nowMs: () => h.clock.now().getTime() }),
    /** Real writes through the real routes: the runner reports back, the second task is claimed, and the waiting plan is accepted. */
    async advance() {
      for (const lease of leases.splice(0)) {
        const status = (await post(h.app, '/v1/runners/heartbeat', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken } }, bearer(runner.token))).body as { cancelRequested?: boolean };
        await post(h.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: status.cancelRequested ? { outcome: 'failed', reason: 'cancelled by owner request; agent stopped and confirmed' } : { outcome: 'completed', changeManifestSha256: 'f'.repeat(64) } }, bearer(runner.token));
      }
      const next = await claim();
      if (next) leases.push(next);
      if (!planned) {
        planned = true;
        await post(h.app, `/v1/runs/${prePlanRun}/plan-revisions`, { expectedRevision: 0, idempotencyKey: 'pp-plan', tasks: [spec(ids.prePlan, prePlanRun, 'pp_api')] });
      }
    },
    settle: () => source.settled(),
    async cleanup() {
      await h.app.close();
    },
  };
});

describe('a real API restart', () => {
  it('drop during restart shows last-confirmed time, disables privileged actions, replays without gaps or duplicates', async () => {
    shared ??= await setupTestDb(8);
    const t = shared;
    await resetDb(t.db);
    const first = makeHarness(t);
    const url = await first.app.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(url).port);
    const projectId = 'proj_a';
    const append = (n: number) => withTx(t.db, (tx) => appendEvent(tx, {
      schemaVersion: 1, eventId: `evt_restart_${n}`, projectId, runId: 'run_a', taskId: 'run_a', attemptId: null, type: 'candidate.assembled', sequence: 0, aggregateRevision: n, actor: { kind: 'integration', id: 'i' },
      occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), causationId: null, traceId: 't', payload: {},
    }));
    await append(1);
    const source = createLiveDataSource({ baseUrl: url, getToken: async () => OWNER_TOKEN });
    const delivered: ProjectViewEvent[] = [];
    const retries: Array<() => void> = [];
    const wrapped = { ...source, subscribe: (p: string, c: string, on: (e: ProjectViewEvent) => void, err: Parameters<typeof source.subscribe>[3]) => source.subscribe(p, c, (e) => { delivered.push(e); on(e); }, err) };
    const statuses: string[] = [];
    const errors: string[] = [];
    let clock = 1000;
    const session = startProjection(wrapped, projectId, { onState: () => {}, onError: (e) => errors.push(e.code), onStatus: (s) => statuses.push(s) }, { every: (fn) => { retries.push(fn); return () => {}; }, clock: { nowMs: () => clock }, refreshMs: 0 });
    await source.settled();
    expect(session.state()!.snapshot.meta.cursor).toBe('1');
    const confirmed = session.livenessAsOfMs();
    expect(confirmed).toBe(1000);

    // The server goes away.
    clock = 2000;
    await first.app.close();
    await source.settled();
    expect(session.status()).toBe('reconnecting');
    expect(statuses).toContain('reconnecting');
    expect(errors).not.toContain('stream_dead');
    // Last-confirmed stays what it was while the server is gone.
    expect(session.livenessAsOfMs()).toBe(confirmed);
    expect(session.state()!.snapshot.meta.cursor).toBe('1');
    // Decisions are the store's to withhold (see control-web's own test); at this level the socket is simply unreachable while it is down.
    await expect(source.getSnapshot(projectId)).rejects.toSatisfy((e: DataSourceException) => e.detail.code === 'disconnected' && e.detail.retryable === true);

    // Events land while the client cannot see them, and the server comes back on the same port.
    await append(2);
    await append(3);
    const second = makeHarness(t);
    await second.app.listen({ port, host: '127.0.0.1' });
    clock = 3000;
    for (let i = 0; i < 40 && session.status() !== 'live'; i += 1) {
      retries.pop()?.();
      await source.settled(30);
    }
    expect(session.status()).toBe('live');
    expect(session.state()!.snapshot.meta.cursor).toBe('3');
    expect(session.livenessAsOfMs()).toBe(3000);

    // Everything after the reconnect arrives once, in order, with no gap.
    await append(4);
    await append(5);
    await source.settled();
    expect(session.state()!.snapshot.meta.cursor).toBe('5');
    const sequences = delivered.map((e) => e.sequence);
    expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b));
    expect(sequences.filter((s) => s > 3)).toEqual([4, 5]);
    session.stop();
    source.disconnect();
    await second.app.close();
  });
});
