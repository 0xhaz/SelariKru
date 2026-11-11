import { ProjectViewSnapshotSchema } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { createLiveDataSource, toViewSnapshot, type RawSnapshot } from '../src/index.ts';
import { DataSourceException } from '@selarikru/view-protocol';

const T = '2026-11-09T01:00:00.000Z';
const attempt = (over = {}) => ({ attemptId: 'a1', number: 1, runner: 'r1', fence: 1, outcome: 'running', exitReason: null, location: 'local' as const, activity: null, assignment: { provider: 'anthropic', model: 'sonnet', source: 'role', route: 'cloud' }, startedAt: T, endedAt: null, lastHeartbeatAt: T, ...over });
const task = (over = {}) => ({ taskId: 't1', runId: 'r', revision: 1, aggregateRevision: 2, status: 'running' as const, placementBlock: null, blockedReason: null, title: 'T', role: 'backend', dependsOn: [], enteredStatusAt: T, latestEvidence: null, attempts: [attempt()], cancel: null, ...over });
const raw = (over: Partial<RawSnapshot> = {}): RawSnapshot => ({
  projectId: 'p', cursor: 3, generatedAt: T, modelCatalog: { status: 'none', detail: null, projectDefault: null, providers: [] }, modelAssignments: [], limits: { maxConcurrentTotal: 2 }, runners: [], checks: [], usage: [], clientReports: [],
  runs: [{ runId: 'r', lifecycle: 'running', planRevision: 1, pinnedModel: null, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null }],
  tasks: [task()], approvals: [], approvalHistory: [], changeRequests: [], ...over,
});

describe('toViewSnapshot', () => {
  it('carries a run\'s set budget limit, and anything else is unknown, never zero', () => {
    const run = (budget: unknown) => toViewSnapshot(raw({ runs: [{ ...raw().runs[0]!, budget }] })).runs['r']!.budgetLimitUsd;
    expect(run({ status: 'set', limitUsd: 25 })).toBe(25);
    expect(run({ status: 'missing', limitUsd: null })).toBeNull();
    expect(run(undefined)).toBeNull();
  });

  it('passes the strict schema and strips the route the recorded model must not carry', () => {
    const v = toViewSnapshot(raw());
    expect(ProjectViewSnapshotSchema.safeParse(v).success).toBe(true);
    expect(v.attempts['a1']!.assignment).toEqual({ provider: 'anthropic', model: 'sonnet', source: 'role' });
    expect(v.workers['r1']!.modelRoute).toBe('cloud');
  });

  it('maps blockedReason to statusReason, and an open attempt to activeAttemptId', () => {
    const v = toViewSnapshot(raw({ tasks: [task({ status: 'blocked', blockedReason: 'verification_error', attempts: [attempt({ endedAt: T, outcome: 'interrupted', exitReason: 'verification_error' })] })] }));
    expect(v.tasks['t1']).toMatchObject({ statusReason: 'verification_error', activeAttemptId: null });
    expect(toViewSnapshot(raw()).tasks['t1']!.activeAttemptId).toBe('a1');
  });

  it('a finished attempt awaiting its verdict is not yet a success, the same reading as the event fold', () => {
    const v = toViewSnapshot(raw({ tasks: [task({ status: 'verifying', attempts: [attempt({ outcome: 'succeeded', endedAt: T })] })] }));
    expect(v.attempts['a1']!.outcome).toBe('running');
  });

  it('an unknown outcome is never read as a success', () => {
    expect(toViewSnapshot(raw({ tasks: [task({ attempts: [attempt({ outcome: 'mystery', endedAt: T })] })] })).attempts['a1']!.outcome).toBe('interrupted');
  });

  it('builds one worker per runner from its latest attempt, carrying the tool name and nothing else', () => {
    const v = toViewSnapshot(raw({ tasks: [task({ attempts: [attempt({ activity: { tool: 'Edit', at: T } })] })] }));
    expect(v.workers['r1']).toMatchObject({ availability: 'assigned', leaseHeld: true, attemptId: 'a1', activity: null, latestAction: { tool: 'Edit', summary: null }, execution: 'local' });
  });

  it('a lost lease reads as offline and disconnected, never idle', () => {
    expect(toViewSnapshot(raw({ tasks: [task({ status: 'ready', attempts: [attempt({ outcome: 'interrupted', exitReason: 'lease_expired', endedAt: T })] })] })).workers['r1']).toMatchObject({ availability: 'offline', health: 'disconnected', leaseHeld: false });
  });

  it('a waiting worker points at its approval and holds no lease', () => {
    const approval = { outcome: 'pending', approvalId: 'ap', runId: 'r', taskId: 't1', revision: 1, requester: 'x', scopeHash: 's', expiresAt: null, requestedAt: T, resolvedAt: null, operation: 'start_cloud_worker', reason: 'why', destination: null };
    const v = toViewSnapshot(raw({ approvals: [approval], tasks: [task({ status: 'awaiting_approval', attempts: [attempt({ outcome: 'interrupted', exitReason: 'approval_requested', endedAt: T })] })] }));
    expect(v.workers['r1']).toMatchObject({ activity: 'waiting_human', leaseHeld: false, blockedByApprovalId: 'ap' });
  });

  it('a resolved approval stays listed, and an expired one in history does not build a card', () => {
    const hist = (outcome: string, approvalId: string) => ({ approvalId, runId: 'r', taskId: 't1', revision: 1, outcome, approver: 'o', scopeHash: 's', operation: null, destination: null, requestedAt: T, resolvedAt: T, consumedAt: null, consumedBy: null });
    const v = toViewSnapshot(raw({ approvalHistory: [hist('granted', 'g'), hist('expired', 'e')] }));
    expect(v.approvals['g']!.state).toBe('granted');
    expect(v.approvals['e']).toBeUndefined();
  });

  it('a shape the view was not built for throws instead of reaching a screen', () => {
    expect(() => toViewSnapshot(raw({ limits: { maxConcurrentTotal: 'lots' } }))).toThrow();
  });
});

describe('transport errors', () => {
  const source = (status: number) => createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch: (async () => new Response(JSON.stringify({ error: { code: 'x', message: 'no' } }), { status })) as typeof fetch });
  const err = (p: Promise<unknown>) => p.then(() => null, (e: DataSourceException) => e.detail);

  it.each([408, 429, 500, 503])('a %i is retryable', async (status) => {
    expect(await err(source(status).getSnapshot('p'))).toMatchObject({ code: 'disconnected', retryable: true });
  });

  it('a 400 or 403 is not', async () => {
    expect(await err(source(403).getSnapshot('p'))).toMatchObject({ code: 'unauthorized', retryable: false });
    expect(await err(source(400).getSnapshot('p'))).toMatchObject({ retryable: false });
  });

  it('a 429 on a command is not a refusal: it throws, so the screen cannot read it as one', async () => {
    await expect(source(429).execute({ command: 'task.cancel', expectedRevision: 0, idempotencyKey: 'k', args: { taskId: 't' } })).rejects.toBeInstanceOf(DataSourceException);
  });

  const withToken = (error: unknown) => createLiveDataSource({ baseUrl: 'http://x', getToken: async () => { throw error; }, fetch: (async () => new Response('{}')) as typeof fetch });
  it.each([['auth/network-request-failed', true], ['auth/too-many-requests', true], ['auth/user-token-expired', false], ['auth/no-current-user', false]] as const)('Firebase %s retryable: %s', async (code, retryable) => {
    expect(await err(withToken(Object.assign(new Error('Sign-in token problem'), { code })).getSnapshot('p'))).toMatchObject({ retryable });
  });

  it('wording never decides: a network failure that mentions a token is a drop', async () => {
    expect(await err(withToken(new TypeError('failed to fetch token')).getSnapshot('p'))).toMatchObject({ code: 'disconnected', retryable: true });
  });

  describe('run.start_new goes through the owner route under the recorded ceiling', () => {
    const start = { command: 'run.start_new' as const, expectedRevision: 0, idempotencyKey: 'k-new', args: { projectId: 'p1', title: 'Follow-up run' } };
    const onboarding = (over: Record<string, unknown> = {}) => ({ projectId: 'p1', costPlan: { agentBudgetUsd: 25 }, execution: { execution: 'local', inference: 'PREFER_ON_DEVICE' }, ...over });
    function recording(replies: Record<string, () => Response>) {
      const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
      const fetch = (async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname;
        calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body as string) : null, auth: new Headers(init.headers).get('authorization') });
        return (replies[`${init.method ?? 'GET'} ${path}`] ?? (() => new Response('{}', { status: 404 })))();
      }) as unknown as typeof globalThis.fetch;
      return { calls, source: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 'tok', fetch }) };
    }
    const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it('reads the ceiling, then creates the run with it, the same key and the title', async () => {
      const { calls, source } = recording({ 'GET /v1/onboarding/p1': json(onboarding()), 'POST /v1/projects/p1/runs': json({ runId: 'run_9', budget: { status: 'set', limitUsd: 25 } }, 201) });
      expect(await source.execute(start)).toMatchObject({ accepted: true, execution: 'applied', operationId: 'run_9', rejection: null });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/onboarding/p1', 'POST /v1/projects/p1/runs']);
      expect(calls[1]!.body).toEqual({ idempotencyKey: 'k-new', title: 'Follow-up run', budgetLimitUsd: 25 });
      expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    });

    it('places a cloud or hybrid project the way its recorded setup was placed', async () => {
      for (const [execution, mode] of [['cloud', 'C1'], ['hybrid', 'H2']] as const) {
        const { calls, source } = recording({ 'GET /v1/onboarding/p1': json(onboarding({ execution: { execution, inference: 'PREFER_ON_DEVICE' } })), 'POST /v1/projects/p1/runs': json({ runId: 'r', budget: {} }, 201) });
        await source.execute(start);
        expect(calls[1]!.body).toMatchObject({ budgetLimitUsd: 25, placement: { mode } });
      }
    });

    it('sends nothing when no ceiling or setup is recorded: a missing limit is never unlimited', async () => {
      for (const view of [onboarding({ costPlan: null }), onboarding({ costPlan: { agentBudgetUsd: null } }), onboarding({ execution: null })]) {
        const { calls, source } = recording({ 'GET /v1/onboarding/p1': json(view) });
        expect(await source.execute(start)).toMatchObject({ accepted: false, rejection: 'outside_recorded_limits' });
        expect(calls.map((c) => c.method)).toEqual(['GET']);
      }
      const none = recording({});
      expect(await none.source.execute(start)).toMatchObject({ accepted: false, rejection: 'outside_recorded_limits' });
    });

    it('reads the route\'s own refusals', async () => {
      const refuse = (code: string, status: number) => json({ error: { code, message: 'no' } }, status);
      for (const [code, status, rejection] of [['outside_recorded_limits', 422, 'outside_recorded_limits'], ['onboarding_not_activated', 409, 'onboarding_not_activated'], ['policy_denied', 403, 'policy_denied']] as const) {
        const { source } = recording({ 'GET /v1/onboarding/p1': json(onboarding()), 'POST /v1/projects/p1/runs': refuse(code, status) });
        expect(await source.execute(start)).toMatchObject({ accepted: false, rejection });
      }
    });

    it('a 429 while reading the ceiling is not a refusal', async () => {
      const { source } = recording({ 'GET /v1/onboarding/p1': json({}, 429) });
      await expect(source.execute(start)).rejects.toBeInstanceOf(DataSourceException);
    });
  });
});

describe('settings and run controls', () => {
  const recording = (answer: Record<string, unknown>, status = 200) => {
    const calls: { url: string; body: unknown }[] = [];
    const source = createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(answer), { status }); }) as unknown as typeof fetch });
    return { source, calls };
  };

  it('a saved setting a runner must acknowledge is pending, never applied by the save', async () => {
    const { source, calls } = recording({ state: 'applying' });
    const r = await source.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'k1', args: { projectId: 'p', key: 'r', change: { scope: 'run', field: 'paused', value: true } } });
    expect(r).toMatchObject({ accepted: true, execution: 'pending' });
    expect(calls[0]).toEqual({ url: 'http://x/v1/projects/p/settings', body: { key: 'r', change: { scope: 'run', field: 'paused', value: true }, expectedRevision: 0, idempotencyKey: 'k1' } });
    expect((await recording({ state: 'applied' }).source.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'k2', args: { projectId: 'p', key: 'r', change: { scope: 'run', field: 'cloud_eligible', value: false } } })).execution).toBe('applied');
    expect((await recording({ state: 'applying' }).source.execute({ command: 'assignment.set', expectedRevision: 0, idempotencyKey: 'k3', args: { projectId: 'p', scope: 'role', key: 'backend', selection: null } })).execution).toBe('pending');
  });

  it('a run cancel is requested until the server says it is done, and a refusal keeps its name', async () => {
    const { source, calls } = recording({ operationId: 'op_1', state: 'cancel_requested' });
    expect(await source.execute({ command: 'run.cancel', expectedRevision: 2, idempotencyKey: 'c1', args: { runId: 'r' } })).toMatchObject({ execution: 'cancel_requested', operationId: 'op_1' });
    expect(calls[0]).toEqual({ url: 'http://x/v1/runs/r/cancel', body: { expectedPlanRevision: 2, idempotencyKey: 'c1' } });
    const refused = recording({ error: { code: 'resume_refused', message: 'no', details: { reason: 'budget:exhausted' } } }, 409);
    expect(await refused.source.execute({ command: 'setting.set', expectedRevision: 1, idempotencyKey: 'k4', args: { projectId: 'p', key: 'r', change: { scope: 'run', field: 'paused', value: false } } })).toMatchObject({ accepted: false, rejection: 'resume_refused' });
  });

  it('carries settings, the run policy, a run cancel and why a task is stopping', () => {
    const setting = { scope: 'run', key: 'r', field: 'paused', desired: true, effective: null, desiredRevision: 1, effectiveRevision: 0, enforcer: 'runner', state: 'applying', updatedBy: 'u', updatedAt: T, appliedAt: null };
    const v = toViewSnapshot(raw({ settings: [setting], runs: [{ ...raw().runs[0]!, cancel: { requestedAt: T, requestedBy: 'u' } }], tasks: [task({ cancel: { operationId: 'op', requestedAt: T, reason: 'policy_revoked:allowed_paths' } })] }));
    expect(v.settings).toEqual([setting]);
    expect(v.runs['r']!.cancel).toEqual({ requestedAt: T, requestedBy: 'u' });
    expect(v.tasks['t1']!.cancelRequested).toMatchObject({ reason: 'policy_revoked:allowed_paths' });
  });
});

describe('route policy', () => {
  const recording = (answer: Record<string, unknown>, status = 200) => {
    const calls: { url: string; body: unknown }[] = [];
    const source = createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(answer), { status }); }) as unknown as typeof fetch });
    return { source, calls };
  };
  const route = {
    effective: 'ONLY_ON_DEVICE', source: 'lock', runDefault: 'PREFER_IN_CLOUD', override: null, overrideRevision: 0, lock: { label: 'restricted', reason: 'This task reads restricted data.' },
    suggestion: { mode: 'ONLY_ON_DEVICE', rule: 'restricted', reason: 'Local only, fixed.', locked: true }, lastObserved: null,
  };
  const report = {
    kind: 'route' as const, requestId: 'req-1', stepKind: 'triage' as const, callOverride: null, requestedMode: 'ONLY_ON_DEVICE' as const, observedSource: 'ON_DEVICE' as const, status: 'ok' as const,
    model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 5, firstOutputMs: null }, validation: 'passed' as const, blockedReason: null,
  };

  it("carries each task's route and the run default", () => {
    const v = toViewSnapshot(raw({ runs: [{ ...raw().runs[0]!, routePolicy: { value: 'PREFER_IN_CLOUD', origin: 'onboarding', revision: 0 } }], tasks: [task({ route })] }));
    expect(v.tasks['t1']!.route).toEqual(route);
    expect(v.runs['r']!.routePolicy).toEqual({ value: 'PREFER_IN_CLOUD', origin: 'onboarding', revision: 0 });
    // A server that does not report routes leaves them absent.
    expect(toViewSnapshot(raw()).tasks['t1']!.route).toBeUndefined();
  });

  it('the assistant axis reads only inference reports', () => {
    const v = toViewSnapshot(raw({ clientReports: [{ kind: 'route', payload: { observedSource: 'IN_CLOUD' }, createdAt: T }, { kind: 'inference', payload: { mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' }, createdAt: T }] }));
    expect(v.assistant).toEqual({ mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' });
  });

  it('reads a task route fresh, with its history, and a read it cannot parse is an error, never a guess', async () => {
    const rec = {
      recordId: 'rte_1', taskId: 't1', taskRevision: 1, requestId: 'req-1', stepKind: 'triage', callOverride: null, requestedMode: 'ONLY_ON_DEVICE', effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', locked: true,
      observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 5, firstOutputMs: null },
      validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: T,
    };
    const calls: string[] = [];
    const answer = (body: unknown) => createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch: (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch });
    const read = await answer({ taskId: 't1', revision: 1, runId: 'r', route, records: [rec] }).getTaskRoute!('p', 't1');
    expect(calls[0]).toBe('http://x/v1/projects/p/tasks/t1/route');
    expect(read.route.lock).toMatchObject({ label: 'restricted' });
    expect(read.records).toHaveLength(1);
    await expect(answer({ taskId: 't1', revision: 1, runId: 'r', route: { ...route, effective: 'PREFER_IN_CLOUD' }, records: [] }).getTaskRoute!('p', 't1')).rejects.toBeInstanceOf(DataSourceException);
  });

  it('reports a route record to the task, and a locked override keeps its refusal name', async () => {
    const { source, calls } = recording({ reportId: 'rte_t1_req-1', trust: 'untrusted' }, 201);
    expect(await source.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'k1', args: { projectId: 'p', taskId: 't1', report } })).toMatchObject({ accepted: true, execution: 'applied', operationId: 'rte_t1_req-1' });
    expect(calls[0]).toEqual({ url: 'http://x/v1/tasks/t1/client-reports', body: report });
    const refused = recording({ error: { code: 'route_locked_restricted', message: 'locked', details: { label: 'restricted', reason: 'This task reads restricted data.' } } }, 409);
    expect(await refused.source.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'k2', args: { projectId: 'p', key: 't1', change: { scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' } } }))
      .toMatchObject({ accepted: false, rejection: 'route_locked_restricted' });
    const mismatch = recording({ error: { code: 'replay_mismatch', message: 'different body' } }, 409);
    expect(await mismatch.source.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'k3', args: { projectId: 'p', taskId: 't1', report } })).toMatchObject({ accepted: false, rejection: 'invalid_command' });
  });
});
