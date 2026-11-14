import { describe, expect, it } from 'vitest';
import type { RouteRecord } from '@selarikru/domain';
import { aiCallRows, aiCallsSummary } from './model.ts';

const rec = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  recordId: 'rr_1', taskId: 't1', taskRevision: 1, requestId: 'req_1', stepKind: 'criteria', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE',
  policySource: 'run', locked: false, observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok',
  model: { cloudModel: 'gemini-x', sdkVersion: '13.1.0' }, timing: { totalMs: 1840, firstOutputMs: null }, validation: 'passed', blockedReason: null,
  reportedBy: 'browser', trust: 'untrusted', reportedAt: '2026-11-12T10:00:00.000Z', ...over,
});
const titles = (id: string): string | null => ({ t1: 'Search index', t2: 'PATIENT export' } as Record<string, string>)[id] ?? null;

describe('H9 item 2: one view of every AI call, from route records only', () => {
  it('shows the step and task, the requested route (label and mode), where it ran, timing, the schema check and the lock, newest first, each linking to its task', () => {
    const rows = aiCallRows([rec(), rec({ recordId: 'rr_2', reportedAt: '2026-11-12T10:05:00.000Z', stepKind: 'pmPlan', effectiveMode: 'ONLY_IN_CLOUD', requestedMode: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD', policySource: 'call', callOverride: 'ONLY_IN_CLOUD' })], titles);
    expect(rows.map((r) => r.id)).toEqual(['rr_2', 'rr_1']);
    expect(rows[1]).toMatchObject({
      task: 'Search index', taskHref: '#/pipeline?task=t1', step: 'Draft criteria', requested: 'Local first (PREFER_ON_DEVICE)', requestedSource: 'Run default',
      ran: 'On this device', ranTone: 'success', how: 'As routed', timing: '1.8 s', check: 'Passed', lock: 'None', restricted: false,
    });
    expect(rows[0]).toMatchObject({ step: 'PM plan draft', requested: 'Cloud only (ONLY_IN_CLOUD)', requestedSource: 'This call only', ran: 'Cloud', ranTone: 'active' });
  });

  it('says when a call fell back, was escalated, was sent after reconnecting or moved to the device; unknown stays unknown', () => {
    const [fell, esc, sent, moved, unknown] = aiCallRows([
      rec({ recordId: 'a', reportedAt: '2026-11-12T10:05:00.000Z', observedSource: 'IN_CLOUD', fellBack: true }),
      rec({ recordId: 'b', reportedAt: '2026-11-12T10:04:00.000Z', observedSource: 'IN_CLOUD', resumed: 'escalated' }),
      rec({ recordId: 'c', reportedAt: '2026-11-12T10:03:00.000Z', observedSource: 'IN_CLOUD', resumed: 'after_reconnect', effectiveMode: 'ONLY_IN_CLOUD' }),
      rec({ recordId: 'd', reportedAt: '2026-11-12T10:02:00.000Z', resumed: 'device_only' }),
      rec({ recordId: 'e', reportedAt: '2026-11-12T10:01:00.000Z', observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified', validation: 'not_run' }),
    ], titles);
    expect(fell).toMatchObject({ ran: 'Cloud', how: 'Fell back to the cloud' });
    expect(esc).toMatchObject({ how: 'Escalated to the cloud: the local result failed its checks' });
    expect(sent).toMatchObject({ how: 'Sent after reconnecting' });
    expect(moved).toMatchObject({ how: 'Moved to this device only' });
    expect(unknown).toMatchObject({ ran: 'Unknown', ranTone: 'warning', how: 'Unknown', check: 'Not run' });
  });

  it('H13: the plan brief steps are listed with where they ran: formatting on this device, the checks in the cloud', () => {
    const [noWeb, check, brief] = aiCallRows([
      rec({ recordId: 'a', reportedAt: '2026-11-12T10:01:00.000Z', stepKind: 'pmBrief', callOverride: 'ONLY_ON_DEVICE', effectiveMode: 'ONLY_ON_DEVICE', policySource: 'call', observedSource: 'ON_DEVICE' }),
      rec({ recordId: 'b', reportedAt: '2026-11-12T10:02:00.000Z', stepKind: 'pmVerify', callOverride: 'ONLY_IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', policySource: 'call', observedSource: 'IN_CLOUD', resumed: 'after_reconnect' }),
      rec({ recordId: 'c', reportedAt: '2026-11-12T10:03:00.000Z', stepKind: 'pmVerifyNoWeb', callOverride: 'ONLY_IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', policySource: 'call', observedSource: 'IN_CLOUD' }),
    ], titles);
    expect(brief).toMatchObject({ step: 'Format plan brief', ran: 'On this device', requested: 'Local only (ONLY_ON_DEVICE)', requestedSource: 'This call only' });
    expect(check).toMatchObject({ step: 'Check plan brief (web)', ran: 'Cloud', how: 'Sent after reconnecting', model: 'gemini-x' });
    expect(noWeb).toMatchObject({ step: 'Check plan brief (no web)', ran: 'Cloud' });
  });

  it('M1: a call the owner resumed says "Resumed by owner"', () => {
    const [row] = aiCallRows([rec({ recordId: 'a', reportedAt: '2026-11-12T10:03:00.000Z', observedSource: 'IN_CLOUD', resumed: 'owner_resume' as never })], titles);
    expect(row).toMatchObject({ how: 'Resumed by owner' });
  });

  it('a stopped call says why; a route violation says so', () => {
    const [stopped, violation] = aiCallRows([
      rec({ recordId: 'a', reportedAt: '2026-11-12T10:05:00.000Z', status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN', fellBack: null, validation: 'not_run' }),
      rec({ recordId: 'b', reportedAt: '2026-11-12T10:04:00.000Z', status: 'route_violation', conformance: 'violation', observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_ON_DEVICE' }),
    ], titles);
    expect(stopped).toMatchObject({ ran: 'Did not run', how: 'Stopped before running: offline' });
    expect(violation).toMatchObject({ ran: 'Cloud', how: 'Route violation', ranTone: 'danger' });
  });

  it('a restricted call shows only its labels: no model, no timing, no check, no reason, no hashes', () => {
    const [row] = aiCallRows([rec({ taskId: 't2', locked: true, inputLabel: 'restricted', effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', outputSha256: 'a'.repeat(64), contextId: 'ctx_secretish' })], titles);
    expect(row).toMatchObject({ restricted: true, lock: 'Locked: restricted data stays on this device', labels: 'restricted', ran: 'On this device', timing: 'Not shown (restricted)', check: 'Not shown (restricted)', how: 'Not shown (restricted)', model: null });
    expect(JSON.stringify(row)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(row)).not.toContain('ctx_secretish');
  });

  it('counts where calls ran, keeping unknown apart', () => {
    expect(aiCallsSummary(aiCallRows([rec(), rec({ recordId: 'b', observedSource: 'IN_CLOUD' }), rec({ recordId: 'c', observedSource: 'UNKNOWN', fellBack: null }), rec({ recordId: 'd', status: 'blocked', observedSource: 'UNKNOWN', fellBack: null })], titles)))
      .toBe('4 calls: 1 on this device, 1 in the cloud, 1 unknown, 1 stopped before running.');
  });
});
