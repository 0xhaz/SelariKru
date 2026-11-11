import { describe, expect, it } from 'vitest';
import { iso, snapshotOf, task } from '../../features/overview/testing.ts';
import { aiRunCounts, latestFallback, recentActivity } from './activity.ts';

describe('the activity feed', () => {
  it('lists what the snapshot recorded, newest first, each with its own time', () => {
    const s = snapshotOf({ tasks: [task('a', { title: 'Add table', status: 'running', enteredStatusAt: iso(30), attemptIds: ['x'] }), task('b', { title: 'Feedback API', status: 'verified', enteredStatusAt: iso(5) })] });
    s.attempts = { x: { attemptId: 'x', taskId: 'a', number: 1, fence: 1, outcome: 'running', exitReason: null, runnerId: 'r', startedAt: iso(20), endedAt: null, lastHeartbeatAt: iso(1), assignment: null } };
    s.changeRequests = [{ runId: 'run', prNumber: 7, url: 'u', status: 'open', candidateSha: 'c', baseRef: 'main', observedHeadSha: null, mergeCommitSha: null, observedAt: iso(10), outOfDate: null }];
    const items = recentActivity(s, 7);
    expect(items.map((i) => i.text)).toEqual(['Feedback API: verified, awaiting merge', 'Pull request #7 is open', 'Attempt 1 started on Add table', 'Add table: running']);
    expect(items[0]!.at).toBe(iso(5));
  });

  it('keeps to the limit', () => {
    const s = snapshotOf({ tasks: Array.from({ length: 12 }, (_, i) => task(`t${i}`, { enteredStatusAt: iso(i) })) });
    expect(recentActivity(s, 7)).toHaveLength(7);
  });

  it('records a decision once it was made, with its outcome', () => {
    const s = snapshotOf({ tasks: [task('a', { title: 'Add table', enteredStatusAt: iso(100) })] });
    s.approvalHistory = [{ approvalId: 'ap', runId: 'run', taskId: 'a', revision: 1, outcome: 'granted', approver: 'owner', scopeHash: null, operation: null, destination: null, requestedAt: iso(60), resolvedAt: iso(50), consumedAt: null, consumedBy: null }];
    expect(recentActivity(s, 7)[0]).toMatchObject({ text: 'Approval granted for Add table', at: iso(50) });
  });

  it('describes a pull request as merged only when the merge was recorded', () => {
    const cr = { runId: 'run', prNumber: 9, url: 'u', status: 'merged_sha_mismatch', candidateSha: 'c', baseRef: 'main', observedHeadSha: null, mergeCommitSha: 'm', observedAt: iso(10), outOfDate: null };
    const s = snapshotOf({});
    s.changeRequests = [cr];
    expect(recentActivity(s, 7)[0]).toMatchObject({ text: 'Pull request #9 merged a commit that is not the verified one; no merge is recorded' });
    s.changeRequests = [{ ...cr, status: 'stale_candidate' }];
    expect(recentActivity(s, 7)[0]!.text).toBe("Pull request #9 no longer holds the run's candidate");
    s.changeRequests = [{ ...cr, status: 'merged' }];
    expect(recentActivity(s, 7)[0]!.text).toBe('Pull request #9 was merged');
  });

  it('says nothing when nothing was recorded', () => {
    expect(recentActivity(snapshotOf({}), 7)).toEqual([]);
  });

  it('lists where each task\'s last AI call ran: on device, in cloud, or fell back to cloud', () => {
    const rec = (over: Record<string, unknown>) => ({
      recordId: 'r', taskId: 'a', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
      observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'm', sdkVersion: '12.5.0' }, timing: { totalMs: 900, firstOutputMs: null },
      validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(3), ...over,
    });
    const route = (lastObserved: unknown) => ({ effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null, suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false }, lastObserved }) as never;
    const s = snapshotOf({ tasks: [
      task('a', { title: 'Add table', enteredStatusAt: iso(100), route: route(rec({})) }),
      task('b', { title: 'Feedback API', enteredStatusAt: iso(100), route: route(rec({ taskId: 'b', observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', reportedAt: iso(2) })) }),
      task('c', { title: 'List UI', enteredStatusAt: iso(100), route: route(rec({ taskId: 'c', observedSource: 'IN_CLOUD', fellBack: true, reportedAt: iso(1) })) }),
      task('d', { title: 'Search', enteredStatusAt: iso(100), route: route(rec({ taskId: 'd', observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified', reportedAt: iso(4) })) }),
    ] });
    const ai = recentActivity(s, 7).filter((i) => i.id.startsWith('ai:'));
    expect(ai.map((i) => i.text)).toEqual(['List UI: AI fell back to cloud', 'Feedback API: AI ran in cloud', 'Add table: AI ran on device', 'Search: AI ran, source unknown']);
    expect(ai[0]!.at).toBe(iso(1));
  });
});

describe('the run\'s AI counter and the fallback banner (H7)', () => {
  const rec = (over: Record<string, unknown>) => ({
    recordId: `r-${String(over['taskId'] ?? 'a')}`, taskId: 'a', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
    observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'm', sdkVersion: '12.5.0' }, timing: { totalMs: 900, firstOutputMs: null },
    validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(3), ...over,
  });
  const route = (lastObserved: unknown) => ({ effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null, suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false }, lastObserved }) as never;
  const s = snapshotOf({ tasks: [
    task('a', { title: 'Add table', route: route(rec({})) }),
    task('b', { title: 'Feedback API', route: route(rec({ taskId: 'b', observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD' })) }),
    task('c', { title: 'List UI', route: route(rec({ taskId: 'c', observedSource: 'IN_CLOUD', fellBack: true, reportedAt: iso(1) })) }),
    task('d', { title: 'Search', route: route(rec({ taskId: 'd', observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified' })) }),
    task('e', { title: 'Blocked call', route: route(rec({ taskId: 'e', observedSource: 'UNKNOWN', fellBack: null, status: 'blocked', blockedReason: 'device_unavailable' })) }),
    task('f', { title: 'No call yet', route: route(null) }),
    task('g', { title: 'Other run', runId: 'other', route: route(rec({ taskId: 'g' })) }),
  ] });

  it('counts the run\'s route records: on device, in cloud and fell back apart, unknown said, blocked and no call left out', () => {
    const c = aiRunCounts(s, 'run');
    expect(c).toEqual({ device: 1, cloud: 1, fellBack: 1, unknown: 1, total: 4 });
    expect(c.total).toBe(c.device + c.cloud + c.fellBack + c.unknown);
  });

  it('counts records only: the function sees the snapshot and nothing that is in flight, and a run with no records counts zero', () => {
    expect(aiRunCounts.length).toBe(2);
    expect(aiRunCounts(snapshotOf({ tasks: [task('x', { route: route(null) })] }), 'run')).toEqual({ device: 0, cloud: 0, fellBack: 0, unknown: 0, total: 0 });
    expect(aiRunCounts(s, null)).toEqual({ device: 0, cloud: 0, fellBack: 0, unknown: 0, total: 0 });
  });

  it('names the latest fallback with its task and its reason in one plain line, from the record', () => {
    const f = latestFallback(s)!;
    expect(f.title).toBe('Fell back to cloud');
    expect(f.task).toBe('List UI');
    expect(f.reason).toBe('The device model was not ready, so the cloud answered, which this route allows.');
    expect(f.at).toBe(iso(1));
    expect(latestFallback(snapshotOf({ tasks: [task('a', { route: route(rec({})) })] }))).toBeNull();
  });
});
