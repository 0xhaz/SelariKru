import { describe, expect, it } from 'vitest';
import { iso, snapshotOf, task } from '../features/overview/testing.ts';
import { roofState } from './roof.ts';

/** H7 round 4: the rooftop is the AI inference deck. Its two boxes are read from route records and calls in flight only. */
const rec = (over: Record<string, unknown>) => ({
  recordId: `r-${String(over['taskId'] ?? 'a')}`, taskId: 'a', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
  observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'm', sdkVersion: '12.5.0' }, timing: { totalMs: 900, firstOutputMs: null },
  validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(3), ...over,
});
const route = (lastObserved: unknown, lock: unknown = null) => ({ effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock, suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false }, lastObserved }) as never;

describe('the rooftop inference deck', () => {
  it('counts each box from each task\'s last record in the run, the same as the top-bar counter, and names the latest call that ran there', () => {
    const s = snapshotOf({ tasks: [
      task('a', { title: 'Add table', route: route(rec({ reportedAt: iso(9) })) }),
      task('b', { title: 'Feedback API', route: route(rec({ taskId: 'b', observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', reportedAt: iso(2) })) }),
      task('c', { title: 'Search', route: route(rec({ taskId: 'c', reportedAt: iso(1) })) }),
    ] });
    const roof = roofState(s, 'run', []);
    expect(roof.device).toMatchObject({ count: 2, expected: [], observed: { task: 'Search', recordId: 'r-c' }, violation: null, locked: false });
    expect(roof.cloud).toMatchObject({ count: 1, expected: [], observed: { task: 'Feedback API', recordId: 'r-b' } });
    expect(roof.fellBack).toBeNull();
    expect(roof.summary).toBe('Roof: 2 tasks on this device, 1 in the cloud, 0 fell back.');
  });

  it('a call in flight marks its box as expected, with the task\'s short name; a restricted task\'s call puts a padlock on the device box', () => {
    const s = snapshotOf({ tasks: [
      task('a', { title: 'End-to-end checks', route: route(null, { label: 'restricted', reason: 'x' }) }),
      task('b', { title: 'Feedback API', route: route(null) }),
    ] });
    const roof = roofState(s, 'run', [{ taskId: 'a', place: 'device' }, { taskId: 'b', place: 'cloud' }]);
    expect(roof.device.expected).toEqual(['END-TO-END']);
    expect(roof.device.locked).toBe(true);
    expect(roof.cloud.expected).toEqual(['FEEDBACK A']);
    expect(roof.cloud.locked).toBe(false);
    expect(roof.summary).toMatch(/In flight: 1 expected on this device \(restricted, locked to this device\), 1 expected in the cloud\./);
  });

  it('a conforming fallback draws the arrow and counts once; a violation is a discard on the box that answered, never a fallback', () => {
    const fell = snapshotOf({ tasks: [task('a', { title: 'List UI', route: route(rec({ observedSource: 'IN_CLOUD', fellBack: true })) })] });
    const f = roofState(fell, 'run', []);
    expect(f.fellBack).toEqual({ task: 'List UI', recordId: 'r-a' });
    expect(f.cloud.observed).toMatchObject({ task: 'List UI' });
    expect([f.device.count, f.cloud.count, f.fellBackCount]).toEqual([0, 0, 1]);
    const bad = snapshotOf({ tasks: [task('a', { title: 'Restricted', route: route(rec({ observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_ON_DEVICE', fellBack: true, conformance: 'violation', status: 'route_violation' })) })] });
    const v = roofState(bad, 'run', []);
    expect(v.fellBack).toBeNull();
    expect(v.cloud.violation).toEqual({ task: 'Restricted', recordId: 'r-a' });
    expect(v.cloud.observed).toBeNull();
    expect(v.device.violation).toBeNull();
    expect(v.summary).toMatch(/1 route violation, discarded/);
  });

  it('only the counter\'s run counts, and nothing at all without a run', () => {
    const s = snapshotOf({ tasks: [task('a', { runId: 'other', route: route(rec({})) })] });
    expect(roofState(s, 'run', []).device.count).toBe(0);
    expect(roofState(s, null, []).device.count).toBe(0);
  });
});
