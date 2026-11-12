import { describe, expect, it } from 'vitest';
import { createSessionCalls, sessionCallRows } from './session.ts';

const event = (over: Record<string, unknown> = {}) => ({
  kind: 'assistant_request' as const, requestId: 'req_a', operation: 'draftBrief' as const, requestedMode: 'PREFER_ON_DEVICE' as const, observedSource: 'ON_DEVICE' as const,
  status: 'ok' as const, totalMs: 900, payloadSha256: 'a'.repeat(64), blockedReason: null, validationStatus: 'passed' as const, routed: false, restricted: false, ...over,
});

describe('H9 fix round 1 (I1): the AI calls that are not task steps (the Assistant, onboarding), kept in this tab only', () => {
  it('keeps the calls that name no task, newest first, and drops task steps (their route records list them)', () => {
    const log = createSessionCalls(() => new Date('2026-11-12T10:00:00.000Z'));
    log.getState().add(event());
    log.getState().add(event({ requestId: 'req_b', routed: true }));
    log.getState().add(event({ requestId: 'req_c', operation: 'suggestCriteria', observedSource: 'IN_CLOUD', requestedMode: 'ONLY_IN_CLOUD' }));
    const rows = sessionCallRows(log.getState().calls);
    expect(rows.map((r) => r.id)).toEqual(['session:req_c', 'session:req_a']);
    expect(rows[1]).toMatchObject({ task: 'Not a task step', taskHref: null, step: 'Draft brief', requested: 'Local first (PREFER_ON_DEVICE)', ran: 'On this device', how: 'As routed', timing: '900 ms', check: 'Passed' });
    expect(rows[0]).toMatchObject({ step: 'Suggest criteria', ran: 'Cloud', requested: 'Cloud only (ONLY_IN_CLOUD)' });
  });

  it('a restricted call is redacted the same way, and an unknown source stays unknown', () => {
    const log = createSessionCalls();
    log.getState().add(event({ restricted: true, observedSource: 'UNKNOWN' }));
    const [row] = sessionCallRows(log.getState().calls);
    expect(row).toMatchObject({ restricted: true, ran: 'Unknown', how: 'Not shown (restricted)', timing: 'Not shown (restricted)', check: 'Not shown (restricted)', labels: 'restricted' });
    expect(JSON.stringify(row)).not.toContain('a'.repeat(64));
  });
});
