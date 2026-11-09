import { describe, expect, it } from 'vitest';
import { ATTENTION_ORDER, buildAttention } from './attention.ts';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task, worker } from './testing.ts';

describe('attention queue', () => {
  it('attention sorted per design §4 order', () => {
    // Listed worst-last, and with the oldest item at the lowest rank, so neither insertion order nor age can pass this by accident.
    const snapshot = snapshotOf({
      tasks: [
        task('stalled', { activeAttemptId: 'a-stall', enteredStatusAt: iso(9000) }),
        task('budget', { status: 'cancelled', cancelReason: 'budget_exhausted', enteredStatusAt: iso(500) }),
        task('lost', { activeAttemptId: 'a-lost', enteredStatusAt: iso(400) }),
        task('decide', { status: 'awaiting_approval', enteredStatusAt: iso(300) }),
        task('gate', { status: 'failed', statusReason: 'verification_failed', enteredStatusAt: iso(200) }),
        task('policy', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination', enteredStatusAt: iso(100) }),
      ],
      approvals: [approval('apr', { taskId: 'decide', taskRevision: 1 })],
      workers: [
        worker('w-stall', { taskId: 'stalled', attemptId: 'a-stall', lastHeartbeatAt: iso(40) }),
        worker('w-lost', { taskId: 'lost', attemptId: 'a-lost', lastHeartbeatAt: iso(90) }),
      ],
    });
    const items = buildAttention(snapshot, NOW, NOW);
    expect(items.map((i) => i.kind)).toEqual(['policy_incident', 'failed_gate', 'decision', 'worker_lost', 'budget_resource', 'information']);
    expect(items.map((i) => i.kind)).toEqual([...ATTENTION_ORDER]);
  });

  it('puts the longest-waiting item first within a rank and is stable for the same input', () => {
    const snapshot = snapshotOf({
      tasks: [task('a', { status: 'awaiting_approval' }), task('b', { status: 'awaiting_approval' })],
      approvals: [approval('newer', { taskId: 'a', requestedAt: iso(10) }), approval('older', { taskId: 'b', requestedAt: iso(50) })],
    });
    expect(buildAttention(snapshot, NOW, NOW).map((i) => i.id)).toEqual(['decision:older', 'decision:newer']);
  });

  it('every item says how old it is, what it affects, who owns it, what happens if ignored and one next action', async () => {
    for (const id of ['policy-block', 'human-wait', 'runner-loss', 'failed-ci', 'expired-approval', 'unknown-costs', 'long-build-stall'] as const) {
      const { snapshot, nowMs } = await fixtureSnapshot(id);
      const items = buildAttention(snapshot, nowMs, nowMs);
      expect(items.length, id).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.since, `${id} ${item.id}`).not.toBeNull();
        expect(item.affectedTaskIds.length, `${id} ${item.id}`).toBeGreaterThan(0);
        expect(item.owner, `${id} ${item.id}`).not.toBe('');
        expect(item.consequence, `${id} ${item.id}`).not.toBe('');
        expect(item.nextAction, `${id} ${item.id}`).not.toBe('');
      }
    }
  });

  it('counts downstream tasks as affected, following dependencies transitively', () => {
    const snapshot = snapshotOf({
      tasks: [task('root', { status: 'failed' }), task('mid', { status: 'planned', dependsOn: ['root'] }), task('leaf', { status: 'planned', dependsOn: ['mid'] }), task('other', { status: 'planned' })],
    });
    expect(buildAttention(snapshot, NOW, NOW)[0]!.affectedTaskIds).toEqual(['root', 'mid', 'leaf']);
  });

  it('separates a policy denial, a request for approval and a missing limit', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('policy-block');
    const items = buildAttention(snapshot, nowMs, nowMs);
    expect(items[0]).toMatchObject({ kind: 'policy_incident', code: 'policy_denied:restricted_data_cloud_destination' });
    const before = snapshotOf({ tasks: [task('x', { status: 'ready', placementBlock: 'approval_required:cloud_start' })] });
    expect(buildAttention(before, NOW, NOW)[0]!.kind).toBe('decision');
    const missing = snapshotOf({ tasks: [task('y', { status: 'ready', placementBlock: 'policy_denied:missing_limit:maxConcurrentTotal' })] });
    expect(buildAttention(missing, NOW, NOW)[0]!.kind).toBe('budget_resource');
  });

  it('shows an expired approval as expired, never as granted or still open', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('expired-approval');
    expect(buildAttention(snapshot, nowMs, nowMs)[0]).toMatchObject({ kind: 'decision', status: 'expired' });
  });

  it('asks for a human review when every criterion is verified', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('merge-flow');
    expect(buildAttention(snapshot, nowMs, nowMs)[0]).toMatchObject({ kind: 'decision', status: 'review' });
  });

  it('reports a lost runner from its heartbeat age, and offers inspection rather than a relaunch', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const [item] = buildAttention(snapshot, nowMs, nowMs);
    expect(item).toMatchObject({ kind: 'worker_lost' });
    expect(item!.nextAction).toMatch(/inspect/i);
  });

  it('does not call a worker lost when our own liveness data is stale', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    expect(buildAttention(snapshot, nowMs, null).map((i) => i.kind)).not.toContain('worker_lost');
  });

  it('treats a suspected stall as information, not a failure', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('long-build-stall');
    expect(buildAttention(snapshot, nowMs, nowMs).map((i) => i.kind)).toEqual(['information']);
  });

  it('stops raising a failed check once the task has moved on, and ignores superseded work', () => {
    const failed = { ci: { checkId: 'ci', taskId: 'a', state: 'failed' as const, summary: 'bad', updatedAt: iso(50), evidenceRef: 'e' } };
    expect(buildAttention(snapshotOf({ tasks: [task('a', { status: 'running' })], checks: failed }), NOW, NOW)).toEqual([]);
    expect(buildAttention(snapshotOf({ tasks: [task('a', { status: 'superseded', placementBlock: 'policy_denied:x' })] }), NOW, NOW)).toEqual([]);
  });

  it('raises nothing for healthy parallel work', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(buildAttention(snapshot, nowMs, nowMs)).toEqual([]);
  });
});
