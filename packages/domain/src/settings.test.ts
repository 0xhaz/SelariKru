import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, checkEventAuthority, isPolicyRevokedReason, isReduction, policyRevokedReason, RunnerConfigAckSchema, SettingChangeSchema, SETTING_ENFORCER } from './index.ts';

describe('settings', () => {
  it('a reduction is anything that takes a grant away', () => {
    expect(isReduction('allowed_paths', ['src', 'tests'], ['src'])).toBe(true);
    expect(isReduction('allowed_paths', ['src'], ['src', 'tests'])).toBe(false);
    expect(isReduction('allowed_paths', null, ['src'])).toBe(true);
    expect(isReduction('cloud_eligible', true, false)).toBe(true);
    expect(isReduction('cloud_eligible', false, true)).toBe(false);
    expect(isReduction('enabled', null, false)).toBe(true);
    expect(isReduction('slots', 2, 1)).toBe(true);
    expect(isReduction('slots', 1, 2)).toBe(false);
    expect(isReduction('budget_limit_usd', 10, 5)).toBe(true);
    expect(isReduction('paused', false, true)).toBe(false);
    expect(isReduction('route_policy', 'ONLY_IN_CLOUD', 'ONLY_ON_DEVICE')).toBe(false);
    expect(isReduction('route_override', null, 'ONLY_IN_CLOUD')).toBe(false);
  });

  it('the server enforces policy, the runner acknowledges what it holds', () => {
    expect(SETTING_ENFORCER).toEqual({ paused: 'runner', budget_limit_usd: 'server', allowed_paths: 'server', cloud_eligible: 'server', enabled: 'runner', slots: 'runner', route_policy: 'server', route_override: 'server' });
  });

  it('accepts only closed values for each field', () => {
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'paused', value: true }).success).toBe(true);
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'paused', value: 'yes' }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'runner', field: 'paused', value: true }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'runner', field: 'slots', value: 0 }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'budget_limit_usd', value: -1 }).success).toBe(false);
    expect(SettingChangeSchema.safeParse({ scope: 'run', field: 'made_up', value: 1 }).success).toBe(false);
    expect(RunnerConfigAckSchema.safeParse({ revision: 3, slots: 2, note: 'x' }).success).toBe(false);
  });

  it('names a revoke so a stopped attempt reads as blocked by policy', () => {
    expect(policyRevokedReason('allowed_paths')).toBe('policy_revoked:allowed_paths');
    expect(isPolicyRevokedReason('policy_revoked:cloud_eligible')).toBe(true);
    expect(isPolicyRevokedReason('cancel_requested')).toBe(false);
  });

  it('only a person changes a setting, and only the system records it applied', () => {
    const base = { schemaVersion: 1, eventId: 'e', projectId: 'p', runId: 'r', taskId: 'r', attemptId: null, sequence: 1, aggregateRevision: 0, occurredAt: '2026-11-08T06:00:00Z', receivedAt: '2026-11-08T06:00:00Z', causationId: null, traceId: 't', payload: {} };
    const as = (type: string, kind: string) => checkEventAuthority(EventEnvelopeSchema.parse({ ...base, type, actor: { kind, id: 'x' } })).ok;
    expect(as('settings.changed', 'human')).toBe(true);
    for (const k of ['worker', 'scheduler', 'system']) expect(as('settings.changed', k)).toBe(false);
    expect(as('settings.applied', 'system')).toBe(true);
    expect(as('settings.applied', 'human')).toBe(false);
    expect(as('settings.applied', 'worker')).toBe(false);
    expect(as('run.cancel_requested', 'human')).toBe(true);
    expect(as('run.cancel_requested', 'scheduler')).toBe(false);
    expect(as('run.cancelled', 'system')).toBe(true);
    expect(as('run.cancelled', 'worker')).toBe(false);
  });
});
