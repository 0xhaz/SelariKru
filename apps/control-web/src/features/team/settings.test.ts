import { describe, expect, it } from 'vitest';
import { NOW, approval, snapshotOf, task, worker } from '../overview/testing.ts';
import { buildDecisions } from '../decisions/model.ts';
import { buildTeam } from './model.ts';
import { STOP_CARD, confirmationStale, workerSettings } from './settings.ts';

const live = { mode: 'live' as const, connection: 'live' as const };

function settingsFor(snapshot: ReturnType<typeof snapshotOf>, workerId: string, connection: 'live' | 'reconnecting' = 'live') {
  const decisions = buildDecisions(snapshot, NOW, { ...live, connection });
  const row = buildTeam(snapshot, NOW, NOW).rows.find((r) => r.workerId === workerId)!;
  return workerSettings(snapshot, decisions, row);
}

describe('worker settings', () => {
  it('stopping a running task goes through the owner cancel command, with a confirmation that names the consequence', () => {
    const s = snapshotOf({ tasks: [task('a', { title: 'Add table', aggregateRevision: 3 })], workers: [worker('w', { taskId: 'a' })] });
    const { stop } = settingsFor(s, 'w');
    expect(stop).toMatchObject({ kind: 'command', id: 'cancel:a', label: 'Cancel task', disabledReason: null, intent: { command: 'task.cancel', expectedRevision: 3, args: { taskId: 'a' } } });
    expect(stop!.confirm).toMatchObject({ title: 'Cancel "Add table"?', keepLabel: 'Keep the task' });
    expect(stop!.confirm!.consequence).toMatch(/not stopped until the runner confirms/);
    expect(stop!.confirm!.consequence).toMatch(/new plan revision/);
  });

  it('stop is off with a reason while the connection is not live', () => {
    const s = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })] });
    expect(settingsFor(s, 'w', 'reconnecting').stop!.disabledReason).toMatch(/connection/i);
  });

  it('a worker with no task has nothing to stop, and says so', () => {
    const s = snapshotOf({ workers: [worker('w', { availability: 'idle', activity: null, leaseHeld: false })] });
    const out = settingsFor(s, 'w');
    expect(out.stop).toBeNull();
    expect(out.stopNone).toMatch(/nothing to cancel/i);
  });

  it('offers the decision cards that apply to this worker\'s task, and no cancel of another task', () => {
    const s = snapshotOf({
      tasks: [task('a', { status: 'awaiting_approval', aggregateRevision: 4 }), task('b')],
      workers: [worker('w', { taskId: 'a', activity: 'waiting_human', blockedByApprovalId: 'ap' }), worker('v', { taskId: 'b' })],
      approvals: [approval('ap', { taskId: 'a', taskRevision: 1, operation: 'start_cloud_worker' })],
    });
    const mine = settingsFor(s, 'w');
    expect(mine.cards.map((c) => c.card.id)).toEqual(['decision:ap']);
    expect(mine.cards[0]!.actions.map((a) => a.label)).toEqual(['Grant cloud start', 'Deny and block task']);
    expect(settingsFor(s, 'v').cards).toEqual([]);
  });

  it('a blocked task\'s card keeps its own actions, and its cancel is left to Stop', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'blocked', statusReason: 'verification_error' })], workers: [worker('w', { taskId: 'a', activity: null })] });
    const out = settingsFor(s, 'w');
    expect(out.cards.map((c) => c.card.kind)).toEqual(['reverify']);
    const labels = out.cards[0]!.actions.map((a) => a.label);
    expect(labels).toContain('Re-verify the run');
    expect(labels).not.toContain('Cancel task');
  });
});

describe('an open confirmation', () => {
  const running = (taskId: string, revision: number) => snapshotOf({ tasks: [task(taskId, { aggregateRevision: revision })], workers: [worker('w', { taskId })] });
  const pendingStop = () => {
    const stop = settingsFor(running('a', 3), 'w').stop!;
    return { cardId: STOP_CARD, action: stop, fingerprint: null };
  };

  it('stands while the same task is at the same revision and the session is live', () => {
    expect(confirmationStale(pendingStop(), settingsFor(running('a', 3), 'w'), true, new Set())).toBe(false);
    expect(confirmationStale(pendingStop(), settingsFor(running('a', 3), 'w'), false, new Set())).toBe(true);
  });

  it('is dropped when the task moves to a newer revision under it', () => {
    expect(confirmationStale(pendingStop(), settingsFor(running('a', 4), 'w'), true, new Set())).toBe(true);
  });

  it('is dropped when the worker moves to another task under it', () => {
    expect(confirmationStale(pendingStop(), settingsFor(running('b', 3), 'w'), true, new Set())).toBe(true);
  });

  it('on a card, is dropped when the card is held as changed', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'awaiting_approval', aggregateRevision: 4 })], workers: [worker('w', { taskId: 'a', activity: 'waiting_human', blockedByApprovalId: 'ap' })], approvals: [approval('ap', { taskId: 'a', taskRevision: 1, operation: 'start_cloud_worker' })] });
    const settings = settingsFor(s, 'w');
    const { card, actions } = settings.cards[0]!;
    const deny = actions.find((x) => x.id === 'deny')! as Parameters<typeof confirmationStale>[0]['action'];
    const p = { cardId: card.id, action: deny, fingerprint: card.fingerprint };
    expect(confirmationStale(p, settings, true, new Set())).toBe(false);
    expect(confirmationStale(p, settings, true, new Set([card.id]))).toBe(true);
  });
});
