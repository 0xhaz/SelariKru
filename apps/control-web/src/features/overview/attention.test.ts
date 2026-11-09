import { describe, expect, it } from 'vitest';
import { ATTENTION_ORDER, buildAttention } from './attention.ts';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task, worker } from './testing.ts';

const placed = (code: string) => snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: code })] });
const blockedBy = (code: string) => snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: code })] });

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
        task('other', { status: 'ready', placementBlock: 'location_disabled:cloud', enteredStatusAt: iso(9500) }),
        task('policy', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination', enteredStatusAt: iso(100) }),
      ],
      approvals: [approval('apr', { taskId: 'decide', taskRevision: 1 })],
      workers: [
        worker('w-stall', { taskId: 'stalled', attemptId: 'a-stall', lastHeartbeatAt: iso(40) }),
        worker('w-lost', { taskId: 'lost', attemptId: 'a-lost', lastHeartbeatAt: iso(90) }),
      ],
    });
    const items = buildAttention(snapshot, NOW, NOW);
    expect(items.map((i) => i.kind)).toEqual(['policy_incident', 'failed_gate', 'decision', 'worker_lost', 'budget_resource', 'blocked', 'information']);
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

  it.each(['policy_denied:source_not_cloud_eligible', 'policy_denied:hard_deny:x', 'classification_not_cloud_eligible'])('%s is a policy incident', (code) => {
    expect(buildAttention(placed(code), NOW, NOW)[0]!.kind).toBe('policy_incident');
  });

  it.each(['policy_denied:missing_budget_limit', 'policy_denied:budget:exceeded', 'policy_denied:missing_limit:maxConcurrentTotal', 'missing_limit:local'])('%s is a budget or limit problem the operator fixes', (code) => {
    expect(buildAttention(placed(code), NOW, NOW)[0]).toMatchObject({ kind: 'budget_resource', needsOperator: true });
  });

  it.each(['no_free_slot', 'concurrency_limit_reached', 'policy_denied:concurrency_limit_reached'])('%s is a Scheduler-owned wait that does not need the operator', (code) => {
    expect(buildAttention(placed(code), NOW, NOW)[0]).toMatchObject({ kind: 'budget_resource', owner: 'Scheduler', needsOperator: false });
  });

  it('maps exhausted repairs to a failed gate with a truthful action, not a budget problem', () => {
    const [item] = buildAttention(blockedBy('repair_budget_exhausted'), NOW, NOW);
    expect(item).toMatchObject({ kind: 'failed_gate', code: 'repair_budget_exhausted', needsOperator: true });
    expect(item!.detail).toMatch(/repair attempts/i);
    expect(item!.nextAction).not.toMatch(/budget increase|repair attempt run/i);
  });

  it.each([
    ['resource_conflict:db', /resource/i, true],
    ['role_not_mapped:backend', /backend/, true],
    ['location_disabled:cloud', /cloud/, true],
    ['something_new', /something new/i, true],
  ] as const)('%s is a neutral Blocked item showing its real reason', (code, detail, needs) => {
    const [item] = buildAttention(placed(code), NOW, NOW);
    expect(item).toMatchObject({ kind: 'blocked', code, needsOperator: needs });
    expect(item!.detail).toMatch(detail);
  });

  it('a restricted-data block names one action and never suggests downgrading the data', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('policy-block');
    expect(buildAttention(snapshot, nowMs, nowMs)[0]!.nextAction).toBe('Run it in a local sandbox with a device model only.');
  });

  it('omits the silence duration when the heartbeat age is unknown', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', health: 'suspected_stall', leaseHeld: false })] });
    const [item] = buildAttention(snapshot, NOW, NOW);
    expect(item!.detail).toBe('No recent heartbeat from w. It is still connected.');
  });

  it('a budget stop needs the operator while its run is open, as a closed record', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    expect(buildAttention(snapshot, nowMs, nowMs)[0]).toMatchObject({ kind: 'budget_resource', needsOperator: true, closedRecord: true });
  });

  it.each(['merged', 'failed', 'cancelled'] as const)('a budget stop on a %s run needs no one', (lifecycle) => {
    const snapshot = snapshotOf({ tasks: [task('a', { status: 'cancelled', cancelReason: 'budget_exhausted' })] });
    snapshot.runs['run'] = { ...snapshot.runs['run']!, lifecycle };
    expect(buildAttention(snapshot, NOW, NOW)[0]).toMatchObject({ needsOperator: false, closedRecord: true });
  });

  it('a resource conflict needs a person, because nothing unblocks it', () => {
    const [item] = buildAttention(blockedBy('resource_conflict:db'), NOW, NOW);
    expect(item).toMatchObject({ kind: 'blocked', owner: 'You', needsOperator: true });
    expect(item!.nextAction).toBe('Replan or cancel the task once the resource is free.');
    expect(item!.consequence).not.toMatch(/starts once/i);
  });

  it('says exceeded and unknown budgets differently, with their own actions', () => {
    const [over] = buildAttention(placed('policy_denied:budget:exceeds_limit'), NOW, NOW);
    const [unknown] = buildAttention(placed('policy_denied:budget:unknown_cost'), NOW, NOW);
    expect(over!.detail).toMatch(/exceed/i);
    expect(unknown!.detail).toMatch(/cost/i);
    expect(over!.nextAction).not.toBe(unknown!.nextAction);
    expect(over!.nextAction).not.toMatch(/set the limit/i);
    expect(unknown!.consequence).toMatch(/never treated as zero/i);
  });

  it('a stale-labelled loss clears once fresh data shows the worker recovered', () => {
    const lost = snapshotOf({ tasks: [task('a', { activeAttemptId: 'att' })], workers: [worker('w', { taskId: 'a', attemptId: 'att', lastHeartbeatAt: iso(90) })] });
    expect(buildAttention(lost, NOW, null, NOW)[0]).toMatchObject({ kind: 'worker_lost', asOfLastConfirmed: true });
    const recovered = snapshotOf({ tasks: [task('a', { activeAttemptId: 'att' })], workers: [worker('w', { taskId: 'a', attemptId: 'att', lastHeartbeatAt: iso(2) })] });
    expect(buildAttention(recovered, NOW, NOW, NOW)).toEqual([]);
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

  it('keeps a worker loss evaluated at the last confirmed time while liveness is stale, and labels it so', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const [item] = buildAttention(snapshot, nowMs + 300_000, null, nowMs);
    expect(item).toMatchObject({ kind: 'worker_lost', asOfLastConfirmed: true });
    expect(item!.detail).toMatch(/last confirmed/i);
  });

  it('does not invent a loss from stale liveness when the heartbeat was fine at the last confirmed time', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(buildAttention(snapshot, nowMs + 300_000, null, nowMs).map((i) => i.kind)).toEqual([]);
  });

  it('raises no worker loss when liveness was never confirmed', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    expect(buildAttention(snapshot, nowMs, null, null).map((i) => i.kind)).not.toContain('worker_lost');
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
