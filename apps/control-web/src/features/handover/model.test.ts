import { describe, expect, it } from 'vitest';
import type { HandoverRecordView, HandoverTaskView } from '@selarikru/view-protocol';
import { costText, inHand, stepIndex, summarize, timeText } from './model.ts';
import { classifyBlock, explain } from '../overview/attention.ts';

const estimate = { costUsd: { value: 0.5, provenance: 'estimated' as const, basis: 'b' }, timeSeconds: { value: 125, provenance: 'estimated' as const, basis: 'b' } };
const task = (over: Partial<HandoverTaskView> = {}): HandoverTaskView => ({
  taskId: 't1', status: 'running', attempt: { attemptId: 'a1', fence: 1, runnerId: 'r', location: 'local', startedAt: null }, baseSha: 'c'.repeat(40), allowedPaths: ['server'],
  resume: { eligible: true, reasons: [], reasonText: [] }, restart: { eligible: true, target: 'cloud', reasons: [], reasonText: [] }, estimate, excludes: [], current: null, ...over,
});
const record = (state: HandoverRecordView['state'], over: Partial<HandoverRecordView> = {}): HandoverRecordView => ({
  checkpointId: 'c1', taskId: 't1', revision: 1, runId: 'r1', mode: 'resume', state, stateLabel: state, target: 'cloud', priorAttemptId: 'a1', priorFence: 1, nextFence: null,
  successorAttemptId: null, successorFence: null, baseSha: 'c'.repeat(40), patch: null, exclusions: [], refusal: null, estimate, latePublishes: 0, requestedAt: '2026-11-10T00:00:00.000Z', fencedAt: null, updatedAt: '2026-11-10T00:00:00.000Z', releasedAt: null, releasedBy: null, successorRetries: 0, taskBlocked: false, contentDropped: null, closed: null, ...over,
});

describe('handover presentation', () => {
  it('never shows an estimate without its label, and an unknown as Unknown', () => {
    expect(costText(estimate.costUsd)).toBe('$0.50 (estimated, at most)');
    expect(timeText(estimate.timeSeconds)).toBe('2 min 5 s (estimated)');
    expect(costText({ value: null, provenance: 'unavailable', basis: 'x' })).toBe('Unknown');
    expect(timeText({ value: null, provenance: 'unavailable', basis: 'x' })).toBe('Unknown');
  });

  it('orders the steps Stopping, Checkpoint ready for review, Fenced, Starting, Running, with an offer off the path', () => {
    expect(['stopping', 'awaiting_review', 'fenced', 'starting', 'running'].map((s) => stepIndex(s as HandoverRecordView['state']))).toEqual([0, 1, 2, 3, 4]);
    expect(stepIndex('restart_offered')).toBe(-1);
  });

  it('says why a task cannot continue, and that a restart is offered instead', () => {
    expect(summarize(task())).toMatchObject({ canResume: true, why: null });
    const restricted = task({ resume: { eligible: false, reasons: ['restricted_work'], reasonText: ['Restricted or secret work stays on this device.'] }, restart: { eligible: true, target: 'local', reasons: [], reasonText: [] } });
    expect(summarize(restricted)).toMatchObject({ canResume: false, canRestart: true, why: 'Restricted or secret work stays on this device.' });
    expect(summarize(task({ current: record('restart_offered', { refusal: { code: 'required_file_excluded', text: 'why' } }) }))).toMatchObject({ label: 'Restart offered', tone: 'warning', canResume: false });
  });

  it('a successor that has finished leaves the handover out of hand', () => {
    expect(inHand(task({ current: record('running') }))).toBe(true);
    expect(inHand(task({ status: 'verifying', current: record('running') }))).toBe(false);
    expect(inHand(task({ current: record('declined') }))).toBe(false);
  });

  it('a task a runner skipped because of the hold says why, in the row and the attention queue', () => {
    expect(explain('handover_held_for_cloud')).toMatch(/^Held for a cloud runner/);
    expect(classifyBlock('handover_held_for_cloud')).toBe('wait');
    expect(classifyBlock('handover_awaiting_review')).toBe('decision');
    expect(explain('handover_awaiting_review')).toMatch(/ready for your review/);
  });
});
