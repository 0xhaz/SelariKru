import { buildFixture, createMockDataSource, createSeededClock, FIXTURE_T0_MS, type FixtureId } from '@selarikru/data-source-mock';
import { emptySnapshot, type ApprovalView, type ProjectViewSnapshot, type TaskView, type WorkerView } from '@selarikru/view-protocol';

export const NOW = Date.parse('2026-11-16T10:00:00.000Z');
export const iso = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();

export function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    taskId: id, runId: 'run', revision: 1, aggregateRevision: 1, title: `Task ${id}`, role: 'backend', dependsOn: [], status: 'running', statusReason: null, placementBlock: null,
    cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: iso(60), latestEvidence: null, ...over,
  };
}

export function worker(id: string, over: Partial<WorkerView> = {}): WorkerView {
  return {
    workerId: id, taskId: null, taskRevision: null, attemptId: null, availability: 'assigned', activity: 'coding', health: 'healthy', leaseHeld: true, stateReason: null, enteredStateAt: iso(60),
    latestAction: null, latestEvidence: null, lastHeartbeatAt: iso(5), execution: 'local', modelRoute: 'cloud', blockedByTaskIds: [], blockedByApprovalId: null, ...over,
  };
}

export function approval(id: string, over: Partial<ApprovalView> = {}): ApprovalView {
  return { approvalId: id, taskId: null, taskRevision: null, runId: 'run', scopeHash: 's', reason: 'allow_domain', operation: null, destination: null, requester: null, state: 'pending', requestedAt: iso(30), expiresAt: null, resolvedAt: null, ...over };
}

const byId = <T,>(items: readonly T[], key: (t: T) => string): Record<string, T> => Object.fromEntries(items.map((i) => [key(i), i]));

export function snapshotOf(parts: { tasks?: TaskView[]; workers?: WorkerView[]; approvals?: ApprovalView[]; checks?: ProjectViewSnapshot['checks']; criteria?: { verified: number; total: number } | null }): ProjectViewSnapshot {
  const base = emptySnapshot({ projectId: 'p', observedAt: iso(0), provenance: 'observed' });
  return {
    ...base, runs: { run: { runId: 'run', lifecycle: 'running', planRevision: 1, latestEvidence: null, criteria: parts.criteria ?? null, reducedScope: null, scopeAssessment: null } }, tasks: byId(parts.tasks ?? [], (t) => t.taskId), workers: byId(parts.workers ?? [], (w) => w.workerId),
    approvals: byId(parts.approvals ?? [], (a) => a.approvalId), checks: parts.checks ?? {},
  };
}

/** A fixture as the UI would read it: `nowMs` is the fixture's own clock and liveness was refreshed at that moment. */
export async function fixtureSnapshot(id: FixtureId, advanceMs = 0): Promise<{ snapshot: ProjectViewSnapshot; nowMs: number }> {
  const fixture = buildFixture(id);
  const clock = createSeededClock(new Date(FIXTURE_T0_MS).toISOString());
  const source = createMockDataSource({ clock, fixtures: [fixture] });
  if (advanceMs > 0) clock.advance(advanceMs);
  const snapshot = await source.getSnapshot(fixture.projectId);
  const nowMs = source.clockFor(fixture.projectId).nowMs();
  source.disconnect();
  return { snapshot, nowMs };
}
