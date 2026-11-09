import { describe, expect, it } from 'vitest';
import type { TaskView } from '@selarikru/view-protocol';
import { ATTENTION_ORDER, blockItem, buildAttention } from './attention.ts';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task, worker } from './testing.ts';

const placed = (code: string) => snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: code })] });
const blockedBy = (code: string) => snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: code })] });

const attentionTask = (): TaskView => ({ taskId: 't', runId: 'r', revision: 1, aggregateRevision: 1, title: 'T', role: 'backend', dependsOn: [], status: 'ready', statusReason: null, placementBlock: null, cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: '2026-11-09T01:00:00.000Z', latestEvidence: null });

describe('a runner\'s model refusal on a blocked task', () => {
  it.each(['unsupported_provider:acme/x', 'unsupported_model:anthropic/x'])('%s is not told to let it retry', (code) => {
    const blocked = blockItem({ ...attentionTask(), status: 'blocked', statusReason: code }, code, ['t']);
    expect(blocked.nextAction).not.toMatch(/retry/i);
    expect(blocked.nextAction).toBe('Replan or cancel this task.');
    const claimTime = blockItem({ ...attentionTask(), status: 'ready', placementBlock: code }, code, ['t']);
    expect(claimTime.nextAction).toMatch(/let it retry/);
  });
});

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
    // `stale_record` needs a stale run, covered below.
    expect(items.map((i) => i.kind)).toEqual(ATTENTION_ORDER.filter((k) => k !== 'stale_record'));
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

  describe('a record that no longer stands', () => {
    const shaped = (recordValid: boolean, lifecycle: 'ready_for_review' | 'merged' = 'ready_for_review') => {
      const s = snapshotOf({ tasks: [task('t', { status: 'verified' })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle, criteria: { verified: recordValid ? 1 : 0, total: 1 }, evidence: { candidate: { sha: 'a'.repeat(40), status: 'assembled', live: true, baseSha: 'b'.repeat(40), treeSha: null, target: 'main', recordedAt: iso(30), recordId: 'ver_1', recordValid, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] }, criteria: [{ criterionId: 'FB-01', description: null, state: 'passed', verified: recordValid, taskIds: ['t'], check: null, candidateSha: null }] } };
      return s;
    };

    it('does not call the run ready for review, and sends the owner to re-verify', () => {
      const items = buildAttention(shaped(false), NOW, NOW);
      expect(items.find((i) => i.id === 'review:run')).toBeUndefined();
      expect(items.find((i) => i.code === 'record_no_longer_valid')).toMatchObject({ kind: 'stale_record', decisionId: 'reverify:run', needsOperator: true, affectedTaskIds: ['t'] });
      expect(ATTENTION_ORDER.indexOf('stale_record')).toBe(ATTENTION_ORDER.indexOf('failed_gate') + 1);
    });

    it('a valid record is ready, and a merged run raises nothing', () => {
      const valid = buildAttention(shaped(true), NOW, NOW);
      expect(valid.find((i) => i.id === 'review:run')).toBeDefined();
      expect(valid.find((i) => i.code === 'record_no_longer_valid')).toBeUndefined();
      expect(buildAttention(shaped(false, 'merged'), NOW, NOW).find((i) => i.code === 'record_no_longer_valid')).toBeUndefined();
    });
  });

  it('says the reason is in Evidence when a failed check carries no summary, and only then', () => {
    const noSummary = { ci: { checkId: 'ci', taskId: 'a', state: 'failed' as const, summary: null, updatedAt: iso(50), evidenceRef: 'e' } };
    expect(buildAttention(snapshotOf({ tasks: [task('a', { status: 'ready' })], checks: noSummary }), NOW, NOW)[0]!.detail).toMatch(/is in Evidence/);
    const noCheck = buildAttention(snapshotOf({ tasks: [task('a', { status: 'failed' })] }), NOW, NOW)[0]!;
    expect(noCheck.detail).toBe('No reason was reported.');
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

  describe('reduced scope and Decisions links', () => {
    const notDelivered = { tasks: [{ taskId: 't', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: ['FB-1'], acceptanceCheckIds: [] };
    const stopped = () => snapshotOf({ tasks: [task('t', { status: 'cancelled', cancelReason: 'budget_exhausted' })] });

    it('a budget stop needs a decision until the reduced scope covers it', () => {
      const open = stopped();
      expect(buildAttention(open, NOW, NOW).find((i) => i.id === 'budget:t')).toMatchObject({ needsOperator: true, decisionId: 'scope:run' });
      const accepted = stopped();
      accepted.runs['run'] = { ...accepted.runs['run']!, reducedScope: { decisionId: 'd', runId: 'run', planRevision: 1, notDelivered, deliveredRequirementIds: [], acceptedAt: iso(5), acceptedBy: 'u', note: null } };
      const item = buildAttention(accepted, NOW, NOW).find((i) => i.id === 'budget:t')!;
      expect(item.needsOperator).toBe(false);
      expect(item.decisionId).toBeNull();
      expect(item.nextAction).not.toMatch(/accept/i);
    });

    it('a reduced scope that does not cover a later stop still needs a decision', () => {
      const s = stopped();
      s.runs['run'] = { ...s.runs['run']!, reducedScope: { decisionId: 'd', runId: 'run', planRevision: 1, notDelivered: { ...notDelivered, tasks: [{ ...notDelivered.tasks[0]!, taskId: 'other' }] }, deliveredRequirementIds: [], acceptedAt: iso(5), acceptedBy: 'u', note: null } };
      expect(buildAttention(s, NOW, NOW).find((i) => i.id === 'budget:t')!.needsOperator).toBe(true);
    });

    it('a run with undelivered work does not say every task is verified', () => {
      const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('t', { status: 'cancelled', cancelReason: 'budget_exhausted' })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle: 'ready_for_review' };
      const review = buildAttention(s, NOW, NOW).find((i) => i.id === 'review:run')!;
      expect(review.detail).not.toMatch(/every task is verified/i);
      expect(review.detail).toMatch(/not delivered/i);
      expect(review.nextAction).toMatch(/reduced scope/i);
    });

    it('a fully verified run still says so', () => {
      const s = snapshotOf({ tasks: [task('a', { status: 'verified' })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle: 'ready_for_review' };
      expect(buildAttention(s, NOW, NOW).find((i) => i.id === 'review:run')!.detail).toMatch(/every task is verified/i);
    });

    it('links an item to the Decisions card that can act on it, and not when there is none', () => {
      const s = snapshotOf({
        tasks: [task('a', { status: 'awaiting_approval' }), task('b', { status: 'blocked', statusReason: 'verification_error' }), task('c', { status: 'blocked', statusReason: 'resource_conflict:db' }), task('d', { status: 'ready', placementBlock: 'budget:exceeds_limit' }), task('e', { status: 'failed', statusReason: 'x' })],
        approvals: [approval('apr', { taskId: 'a', taskRevision: 1 })],
      });
      const items = buildAttention(s, NOW, NOW);
      const id = (x: string) => items.find((i) => i.id === x)!.decisionId;
      expect(id('decision:apr')).toBe('decision:apr');
      expect(id('placement:b')).toBe('reverify:run');
      expect(id('placement:c')).toBe('placement:c');
      expect(id('placement:d')).toBeNull();
      expect(id('gate:e')).toBeNull();
    });

    it('an expired approval on a blocked task is one item, not two', () => {
      const s = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'approval_expired' })], approvals: [approval('apr', { taskId: 't', taskRevision: 1, state: 'expired' })] });
      const items = buildAttention(s, NOW, NOW);
      expect(items.map((i) => i.id)).toEqual(['decision:apr']);
      expect(items[0]!.status).toBe('expired');
    });
  });

  describe('a snapshot shaped like the real route', () => {
    const realShape = (lifecycle: 'running' | 'ready_for_review' = 'running') => {
      const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: null })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle, scopeAssessment: { notDelivered: { tasks: [{ taskId: 'b', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: [], acceptanceCheckIds: [] }, notDeliveredHash: 'h', deliveredRequirementIds: [], stopped: [{ taskId: 'b', revision: 1 }], stoppingTaskIds: [] } };
      return s;
    };

    it('finds a budget stop with no cancel reason on the task', () => {
      expect(buildAttention(realShape(), NOW, NOW).find((i) => i.id === 'budget:b')).toMatchObject({ needsOperator: true, decisionId: 'scope:run' });
    });

    it('does not say every task is verified', () => {
      const review = buildAttention(realShape('ready_for_review'), NOW, NOW).find((i) => i.id === 'review:run')!;
      expect(review.detail).not.toMatch(/every task is verified/i);
      expect(review.detail).toMatch(/not delivered/i);
      expect(review.nextAction).toMatch(/reduced scope/i);
    });

    it('a plain cancel is undelivered too, and needs no reduced scope', () => {
      const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: null })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle: 'ready_for_review' };
      const review = buildAttention(s, NOW, NOW).find((i) => i.id === 'review:run')!;
      expect(review.detail).not.toMatch(/every task is verified/i);
      expect(review.detail).toMatch(/not delivered/i);
      expect(review.nextAction).not.toMatch(/reduced scope/i);
    });

    it('labels worker free text as worker-supplied', () => {
      const s = snapshotOf({ tasks: [task('t', { status: 'awaiting_approval' })], approvals: [approval('apr', { taskId: 't', taskRevision: 1, operation: 'breaking_api_change', reason: 'Clients will break.' })] });
      expect(buildAttention(s, NOW, NOW)[0]!.detail).toBe('Worker-supplied reason: Clients will break.');
    });
  });
});

describe('next action for model blocks', () => {
  const next = (code: string) => buildAttention(placed(code), NOW, NOW).find((i) => i.code === code)?.nextAction;
  const nextBlocked = (code: string) => buildAttention(blockedBy(code), NOW, NOW).find((i) => i.code === code)?.nextAction;

  it('sends only choices a person can make in Team to Team', () => {
    expect(next('unsupported_model:anthropic/x')).toMatch(/Choose a supported model in Team/);
    expect(next('model_not_on_runner:anthropic/x')).toMatch(/Choose a supported model in Team/);
  });

  it('needs a runner, not a choice, when no provider is detected', () => {
    const action = next('no_provider_detected:anthropic/x');
    expect(action).toBe('Connect a runner on a machine with a supported harness installed.');
    expect(action).not.toMatch(/Team/);
  });

  it('a block a runner published is replanned or cancelled', () => {
    for (const code of ['model_mismatch: recorded a, the stream reports b', 'model_unverified: recorded a, the stream never reported a model']) expect(nextBlocked(code), code).toBe('Replan or cancel this task.');
  });

  it('a restricted task is told no device model exists', () => {
    expect(next('restricted_requires_device_model:anthropic/x')).toMatch(/No device model is available yet/);
  });
});
