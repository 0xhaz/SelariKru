import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NANO_INPUT_BUDGET_CHARS, ROUTE_POLICY_LABELS, ROUTE_STEP_KINDS, RouteRecordReportSchema, SettingChangeSchema, effectiveRoutePolicy, isCloudCapable, routeLockFor, routeOutcome,
  strongerLabel, suggestRoute,
} from './index.ts';

describe('route policy: effective precedence', () => {
  it('the call override wins, then the task override, then the run default', () => {
    expect(effectiveRoutePolicy({ call: 'ONLY_IN_CLOUD', task: 'PREFER_ON_DEVICE', run: 'ONLY_ON_DEVICE', lock: null })).toMatchObject({ mode: 'ONLY_IN_CLOUD', source: 'call', forced: false });
    expect(effectiveRoutePolicy({ call: null, task: 'PREFER_ON_DEVICE', run: 'ONLY_IN_CLOUD', lock: null })).toMatchObject({ mode: 'PREFER_ON_DEVICE', source: 'task' });
    expect(effectiveRoutePolicy({ task: null, run: 'PREFER_IN_CLOUD', lock: null })).toMatchObject({ mode: 'PREFER_IN_CLOUD', source: 'run' });
  });

  it('nothing set is unset, never a default the owner did not choose', () => {
    expect(effectiveRoutePolicy({ task: null, run: null, lock: null })).toEqual({ mode: null, source: 'unset', requested: null, requestedSource: 'unset', forced: false });
  });

  it('a lock forces ONLY_ON_DEVICE over any cloud-capable choice, even a call override, and says what was asked', () => {
    const lock = routeLockFor(['internal', 'restricted'])!;
    expect(effectiveRoutePolicy({ call: 'ONLY_IN_CLOUD', task: null, run: 'ONLY_ON_DEVICE', lock })).toEqual({ mode: 'ONLY_ON_DEVICE', source: 'lock', requested: 'ONLY_IN_CLOUD', requestedSource: 'call', forced: true });
    expect(effectiveRoutePolicy({ task: 'PREFER_ON_DEVICE', run: null, lock })).toMatchObject({ mode: 'ONLY_ON_DEVICE', source: 'lock', forced: true });
    // Unset under a lock is still device only: the lock needs no choice.
    expect(effectiveRoutePolicy({ task: null, run: null, lock })).toMatchObject({ mode: 'ONLY_ON_DEVICE', source: 'lock' });
    // A device-only choice keeps its own source: nothing was forced.
    expect(effectiveRoutePolicy({ task: 'ONLY_ON_DEVICE', run: 'ONLY_IN_CLOUD', lock })).toMatchObject({ mode: 'ONLY_ON_DEVICE', source: 'task', forced: false });
  });

  it('only ONLY_ON_DEVICE is not cloud capable: PREFER_ON_DEVICE may fall back to the cloud', () => {
    expect(isCloudCapable('ONLY_ON_DEVICE')).toBe(false);
    for (const m of ['PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const) expect(isCloudCapable(m)).toBe(true);
    expect(ROUTE_POLICY_LABELS).toEqual({ ONLY_ON_DEVICE: 'Local only', PREFER_ON_DEVICE: 'Local first', ONLY_IN_CLOUD: 'Cloud only', PREFER_IN_CLOUD: 'Cloud first' });
  });
});

describe('route policy: the data lock follows the strongest label', () => {
  it('locks on restricted or secret anywhere among the sources, the same fold as the Brain', () => {
    expect(routeLockFor(['public', 'internal'])).toBeNull();
    expect(routeLockFor([])).toBeNull();
    expect(routeLockFor(['public', 'restricted', 'internal'])).toMatchObject({ label: 'restricted', code: 'route_locked_restricted' });
    expect(routeLockFor(['restricted', 'secret'])).toMatchObject({ label: 'secret' });
    for (const labels of [['public', 'restricted'], ['internal', 'secret'], ['public', 'internal']]) {
      const brain = labels.reduce<string>((acc, l) => strongerLabel(acc, l), 'public');
      expect(routeLockFor(labels)?.label ?? 'none').toBe(brain === 'restricted' || brain === 'secret' ? brain : 'none');
    }
  });

  it('fails closed: a label it cannot read locks as secret', () => {
    expect(routeLockFor(['public', 'confidential'])).toMatchObject({ label: 'secret' });
    expect(routeLockFor([undefined])).toMatchObject({ label: 'secret' });
  });

  it('says why, and that only a reclassification lifts it', () => {
    expect(routeLockFor(['restricted'])!.reason).toMatch(/restricted.*device.*reclassification/i);
  });
});

describe('suggestRoute: each row of the plan table', () => {
  const ctx = { nanoBudgetChars: DEFAULT_NANO_INPUT_BUDGET_CHARS };
  it('restricted data: Local only, locked', () => {
    expect(suggestRoute({ label: 'restricted', stepKind: 'plan', inputChars: 90_000 }, { ...ctx, offline: false })).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'restricted', locked: true });
    expect(suggestRoute({ label: 'secret', stepKind: 'triage', inputChars: 10 }, ctx)).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'restricted', locked: true });
  });

  it('short and bounded: Local first', () => {
    for (const stepKind of ['brief', 'criteria', 'patch', 'triage', 'prDescription'] as const) {
      const s = suggestRoute({ label: 'internal', stepKind, inputChars: 800 }, ctx);
      expect(s).toMatchObject({ mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', locked: false });
      expect(s.reason).toContain('800');
    }
  });

  it('long context or a broad step: Cloud first', () => {
    expect(suggestRoute({ label: 'internal', stepKind: 'triage', inputChars: DEFAULT_NANO_INPUT_BUDGET_CHARS + 1 }, ctx)).toMatchObject({ mode: 'PREFER_IN_CLOUD', rule: 'long_input' });
    for (const stepKind of ['plan', 'breakdown', 'review'] as const) expect(suggestRoute({ label: 'public', stepKind, inputChars: 100 }, ctx)).toMatchObject({ mode: 'PREFER_IN_CLOUD', rule: 'broad_step' });
  });

  it('offline, or no cloud budget left: Local only, not locked', () => {
    expect(suggestRoute({ label: 'internal', stepKind: 'plan', inputChars: 90_000 }, { ...ctx, offline: true })).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'offline', locked: false });
    expect(suggestRoute({ label: 'internal', stepKind: 'review', inputChars: null }, { ...ctx, cloudBudgetAvailable: false })).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'no_cloud_budget', locked: false });
  });

  it('an unknown size is said in words, and a missing budget never reads as room to spare', () => {
    expect(suggestRoute({ label: 'internal', stepKind: 'triage', inputChars: null }, ctx).reason).toMatch(/not estimated/);
    expect(suggestRoute({ label: 'internal', stepKind: 'triage', inputChars: 10 }, { nanoBudgetChars: Number.NaN })).toMatchObject({ mode: 'PREFER_IN_CLOUD', rule: 'long_input' });
  });

  it('every step kind gets a suggestion with a reason', () => {
    for (const stepKind of ROUTE_STEP_KINDS) expect(suggestRoute({ label: 'internal', stepKind, inputChars: 100 }, ctx).reason.length).toBeGreaterThan(10);
  });
});

describe('route outcome: where a response actually ran', () => {
  it('a preference that ran on the other side fell back; an only that did is a violation', () => {
    expect(routeOutcome('PREFER_ON_DEVICE', 'IN_CLOUD')).toEqual({ fellBack: true, conformance: 'conforms', requestModeMismatch: false });
    expect(routeOutcome('PREFER_IN_CLOUD', 'ON_DEVICE')).toEqual({ fellBack: true, conformance: 'conforms', requestModeMismatch: false });
    expect(routeOutcome('PREFER_ON_DEVICE', 'ON_DEVICE')).toEqual({ fellBack: false, conformance: 'conforms', requestModeMismatch: false });
    expect(routeOutcome('ONLY_ON_DEVICE', 'IN_CLOUD')).toEqual({ fellBack: true, conformance: 'violation', requestModeMismatch: false });
    expect(routeOutcome('ONLY_IN_CLOUD', 'IN_CLOUD')).toEqual({ fellBack: false, conformance: 'conforms', requestModeMismatch: false });
  });
  it('the requested mode counts: a cloud-capable request on a device-only or locked route is a violation, whatever the source said', () => {
    expect(routeOutcome('ONLY_ON_DEVICE', 'ON_DEVICE', 'ONLY_IN_CLOUD')).toMatchObject({ conformance: 'violation', requestModeMismatch: true });
    expect(routeOutcome('ONLY_ON_DEVICE', 'UNKNOWN', 'PREFER_ON_DEVICE')).toMatchObject({ conformance: 'violation', requestModeMismatch: true });
    expect(routeOutcome('PREFER_ON_DEVICE', 'ON_DEVICE', 'PREFER_IN_CLOUD', true)).toMatchObject({ conformance: 'violation' });
  });
  it('a request that differs is flagged; a stricter one is not a violation, a wider one is', () => {
    expect(routeOutcome('PREFER_ON_DEVICE', 'ON_DEVICE', 'ONLY_ON_DEVICE')).toEqual({ fellBack: false, conformance: 'conforms', requestModeMismatch: true });
    expect(routeOutcome('PREFER_IN_CLOUD', 'IN_CLOUD', 'ONLY_IN_CLOUD')).toMatchObject({ conformance: 'conforms', requestModeMismatch: true });
    expect(routeOutcome('ONLY_IN_CLOUD', 'IN_CLOUD', 'PREFER_IN_CLOUD')).toMatchObject({ conformance: 'violation', requestModeMismatch: true });
    expect(routeOutcome('PREFER_ON_DEVICE', 'ON_DEVICE', 'PREFER_ON_DEVICE')).toMatchObject({ conformance: 'conforms', requestModeMismatch: false });
    expect(routeOutcome('PREFER_ON_DEVICE', 'ON_DEVICE', null)).toMatchObject({ requestModeMismatch: false });
  });
  it('an unknown source is unknown: never counted as either side', () => {
    expect(routeOutcome('ONLY_ON_DEVICE', 'UNKNOWN')).toEqual({ fellBack: null, conformance: 'unverified', requestModeMismatch: false });
    expect(routeOutcome(null, 'ON_DEVICE')).toEqual({ fellBack: null, conformance: 'unverified', requestModeMismatch: false });
  });
});

describe('route record report: metadata only', () => {
  const report = {
    kind: 'route', requestId: 'req-1', stepKind: 'triage', callOverride: null, requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok',
    model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 120.5, firstOutputMs: null }, validation: 'passed', blockedReason: null,
  };
  it('accepts the closed shape', () => {
    expect(RouteRecordReportSchema.safeParse(report).success).toBe(true);
    expect(RouteRecordReportSchema.safeParse({ ...report, blockedReason: 'missing_destination:firebase_cloud_inference' }).success).toBe(true);
  });
  it('has nowhere to put prompt or response text', () => {
    expect(RouteRecordReportSchema.safeParse({ ...report, prompt: 'the restricted text' }).success).toBe(false);
    expect(RouteRecordReportSchema.safeParse({ ...report, data: { summary: 'x' } }).success).toBe(false);
    expect(RouteRecordReportSchema.safeParse({ ...report, blockedReason: 'the model said: secret plan' }).success).toBe(false);
    expect(RouteRecordReportSchema.safeParse({ ...report, model: { cloudModel: 'a model with words', sdkVersion: '12.5.0' } }).success).toBe(false);
    expect(RouteRecordReportSchema.safeParse({ ...report, requestId: 'has spaces in it' }).success).toBe(false);
  });
  it('H12: a resumed call says how it was resumed, and which checkpoint it continues; nothing else', () => {
    expect(RouteRecordReportSchema.safeParse({ ...report, resumed: 'after_reconnect', checkpointId: 'ckp_0123456789' }).success).toBe(true);
    expect(RouteRecordReportSchema.safeParse({ ...report, resumed: 'escalated', checkpointId: 'ckp_0123456789' }).success).toBe(true);
    expect(RouteRecordReportSchema.safeParse({ ...report, resumed: 'fallback' }).success).toBe(false);
    expect(RouteRecordReportSchema.safeParse({ ...report, resumed: 'after_reconnect', checkpointId: 'ckp with words' }).success).toBe(false);
  });
});

describe('route policy as settings', () => {
  it('the run default is a run setting, the override a task setting that may be cleared', () => {
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'route_policy', value: 'PREFER_ON_DEVICE' }).success).toBe(true);
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'route_policy', value: null }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' }).success).toBe(true);
    expect(SettingChangeSchema.safeParse({ scope: 'task', field: 'route_override', value: null }).success).toBe(true);
    expect(SettingChangeSchema.safeParse({ scope: 'task', field: 'route_override', value: 'CLOUD' }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'route_override', value: 'ONLY_IN_CLOUD' }).success).toBe(false);
  });
});
