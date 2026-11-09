import { ProjectViewSnapshotSchema } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { toViewSnapshot, type RawSnapshot } from '../src/index.ts';

const T = '2026-11-09T01:00:00.000Z';
const attempt = (over = {}) => ({ attemptId: 'a1', number: 1, runner: 'r1', fence: 1, outcome: 'running', exitReason: null, location: 'local' as const, activity: null, assignment: { provider: 'anthropic', model: 'sonnet', source: 'role', route: 'cloud' }, startedAt: T, endedAt: null, lastHeartbeatAt: T, ...over });
const task = (over = {}) => ({ taskId: 't1', runId: 'r', revision: 1, aggregateRevision: 2, status: 'running' as const, placementBlock: null, blockedReason: null, title: 'T', role: 'backend', dependsOn: [], enteredStatusAt: T, latestEvidence: null, attempts: [attempt()], cancel: null, ...over });
const raw = (over: Partial<RawSnapshot> = {}): RawSnapshot => ({
  projectId: 'p', cursor: 3, generatedAt: T, modelCatalog: { status: 'none', detail: null, projectDefault: null, providers: [] }, modelAssignments: [], limits: { maxConcurrentTotal: 2 }, runners: [], checks: [], usage: [], clientReports: [],
  runs: [{ runId: 'r', lifecycle: 'running', planRevision: 1, pinnedModel: null, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null }],
  tasks: [task()], approvals: [], approvalHistory: [], changeRequests: [], ...over,
});

describe('toViewSnapshot', () => {
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
