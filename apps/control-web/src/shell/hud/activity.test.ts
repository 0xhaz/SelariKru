import { describe, expect, it } from 'vitest';
import { iso, snapshotOf, task } from '../../features/overview/testing.ts';
import { recentActivity } from './activity.ts';

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
});
