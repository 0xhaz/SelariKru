import { describe, expect, it } from 'vitest';
import { ClientReportSchema, ERROR_CODES, HeartbeatRequestSchema, PlanRevisionRequestSchema, ResultRequestSchema, SettingRequestSchema } from './index.ts';

const CANARY = 'sk_live_CANARY0123456789abcdefXYZ';
const spec = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, tenantId: 'tenant_a', projectId: 'proj_a', runId: 'run_a', taskId: 't1', boardId: 'b1', revision: 1, role: 'backend',
  title: 'T', baseSha: 'abc', requirementIds: [], dependencies: [], contractRefs: [], allowedPaths: [], resourceClaims: [], acceptanceCheckIds: [],
  classification: 'internal', policyVersion: 'v1', execution: 'eligible_any', inferencePolicyId: 'p1', limits: { maxAttempts: 3, timeoutSeconds: 60, maxCostUsd: 1 }, ...over,
});
const plan = (task: unknown) => PlanRevisionRequestSchema.safeParse({ expectedRevision: 0, tasks: [task] });

describe('plan task fields', () => {
  it('accepts ordinary ids, paths and a title', () => {
    expect(plan(spec({ allowedPaths: ['src/app/**', 'docs/a-b_c.md'], requirementIds: ['FB-01'] })).success).toBe(true);
  });
  it.each(['taskId', 'role', 'boardId', 'policyVersion', 'baseSha'])('rejects a secret-shaped %s', (field) => {
    expect(plan(spec({ [field]: `x-${CANARY}` })).success).toBe(false);
  });
  it('rejects secret-shaped list entries and unsafe characters', () => {
    expect(plan(spec({ requirementIds: [CANARY] })).success).toBe(false);
    expect(plan(spec({ allowedPaths: [CANARY] })).success).toBe(false);
    expect(plan(spec({ acceptanceCheckIds: ['bad id with spaces'] })).success).toBe(false);
    expect(plan(spec({ taskId: 'a'.repeat(200) })).success).toBe(false);
  });
  it('rejects prefixed secret forms in identifiers and accepts look-alike words', () => {
    expect(plan(spec({ taskId: `task_${CANARY}` })).success).toBe(false);
    expect(plan(spec({ role: 'x_ghp_abcdefghijklmnopqrstuvwxyz0123' })).success).toBe(false);
    expect(plan(spec({ allowedPaths: ['src/sk-button-component-variants.tsx'], requirementIds: ['token:refresh', 'pk-migration-for-feedback-table'], acceptanceCheckIds: ['credentials:store'] })).success).toBe(true);
  });
  it('lets the title through, because the API redacts it', () => {
    expect(plan(spec({ title: `use ${CANARY}` })).success).toBe(true);
  });
});

describe('runner result fields', () => {
  const lease = { attemptId: 'a', fence: 1, leaseToken: 't' };
  it('requires headSha to be a hex commit id', () => {
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'completed', headSha: 'a'.repeat(40) } }).success).toBe(true);
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'completed', headSha: CANARY } }).success).toBe(false);
    const manifest = 'c'.repeat(64);
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'completed', changeManifestSha256: manifest } }).success).toBe(true);
    for (const bad of [CANARY, 'abc', 'C'.repeat(64), `../${'c'.repeat(61)}`])
      expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'completed', changeManifestSha256: bad } }).success).toBe(false);
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'failed', reason: 'x', changeManifestSha256: manifest } }).success).toBe(false);
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'completed', headSha: 'abc123' } }).success).toBe(false);
  });

  it('a heartbeat may say setup is complete, and nothing else about it', () => {
    expect(HeartbeatRequestSchema.safeParse({ lease, setupComplete: true }).success).toBe(true);
    expect(HeartbeatRequestSchema.safeParse({ lease, setupComplete: false }).success).toBe(false);
    expect(HeartbeatRequestSchema.safeParse({ lease, setupComplete: 'yes' }).success).toBe(false);
  });

  it('accepts an infrastructure failure with a reason, and only with a reason', () => {
    const r = (result: object) => ResultRequestSchema.safeParse({ lease, result }).success;
    expect(r({ outcome: 'infrastructure_failed', reason: 'provisioning_failed: x', reportedUsage: { setupSeconds: 3 } })).toBe(true);
    expect(r({ outcome: 'infrastructure_failed' })).toBe(false);
    expect(r({ outcome: 'infrastructure_failed', reason: '' })).toBe(false);
    expect(r({ outcome: 'infrastructure_failed', reason: 'x', headSha: 'a'.repeat(40) })).toBe(false);
  });

  it('accepts bounded usage numbers and rejects anything else', () => {
    const ok = { outcome: 'failed', reason: 'x', reportedUsage: { inputTokens: 5, outputTokens: null, setupSeconds: 2.5, costBasis: 'list' } };
    expect(ResultRequestSchema.safeParse({ lease, result: ok }).success).toBe(true);
    for (const bad of [{ inputTokens: -1 }, { inputTokens: 1.5 }, { setupSeconds: Number.POSITIVE_INFINITY }, { note: 'text never enters the ledger' }, { costBasis: 'whatever' }]) {
      expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'failed', reason: 'x', reportedUsage: bad } }).success).toBe(false);
    }
  });

  it.each(['sk-ant-api03-abcdefghijklmnop.example.com', 'glpat-abcdefghijklmnopqrstuv.example.com', 'xoxb-1234567890-abc.example.com'])('refuses a destination shaped like a secret: %s', (host) => {
    expect(ResultRequestSchema.safeParse({ lease, result: { outcome: 'approval_requested', reason: 'x', operation: 'new_domain', destination: { kind: 'network_host', host } } }).success).toBe(false);
  });

  it('an approval request names one of the closed operations, or none', () => {
    const ask = (operation?: string) => ResultRequestSchema.safeParse({ lease, result: { outcome: 'approval_requested', reason: 'x', ...(operation !== undefined ? { operation } : {}) } }).success;
    expect(ask('destructive_data_migration')).toBe(true);
    expect(ask()).toBe(true);
    for (const bad of ['deploy', 'grant_me_everything', 'budget_increase']) expect(ask(bad)).toBe(false);
  });

  it('an approval destination is structured or absent, never a free string', () => {
    const ask = (destination: unknown) => ResultRequestSchema.safeParse({ lease, result: { outcome: 'approval_requested', reason: 'x', operation: 'new_domain', destination } }).success;
    expect(ask({ kind: 'network_host', host: 'api.example.com' })).toBe(true);
    for (const bad of ['https://api.example.com', { kind: 'network_host', host: 'API.example.com' }, { kind: 'network_host', host: '1.2.3.4' }, { kind: 'network_host', host: 'a..b' }, { kind: 'other', host: 'a.example.com' }, { kind: 'network_host', host: 'a.example.com', note: 'x' }]) expect(ask(bad)).toBe(false);
  });
});

describe('route policy requests', () => {
  const route = {
    kind: 'route', requestId: 'req-1', stepKind: 'patch', callOverride: 'ONLY_IN_CLOUD', requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok',
    model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 10, firstOutputMs: null }, validation: 'passed', blockedReason: null,
  };
  it('a client report is the assistant inference report or a route record, each closed', () => {
    expect(ClientReportSchema.safeParse({ kind: 'inference', mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' }).success).toBe(true);
    expect(ClientReportSchema.safeParse(route).success).toBe(true);
    expect(ClientReportSchema.safeParse({ ...route, text: 'the prompt' }).success).toBe(false);
    expect(ClientReportSchema.safeParse({ ...route, kind: 'other' }).success).toBe(false);
  });
  it('the run default and the task override go through the settings request', () => {
    expect(SettingRequestSchema.safeParse({ key: 'run_1', change: { scope: 'run', field: 'route_policy', value: 'PREFER_ON_DEVICE' }, expectedRevision: 0, idempotencyKey: 'k1' }).success).toBe(true);
    expect(SettingRequestSchema.safeParse({ key: 't1', change: { scope: 'task', field: 'route_override', value: null }, expectedRevision: 1, idempotencyKey: 'k2' }).success).toBe(true);
  });
  it('the lock refusal has its own code', () => {
    expect(ERROR_CODES).toContain('route_locked_restricted');
  });
});
