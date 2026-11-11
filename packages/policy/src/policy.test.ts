import { describe, expect, it } from 'vitest';
import {
  applyApproval, applyProposedClassification, checkReservation, checkWithinLimit, deriveClassification,
  evaluate, FIREBASE_CLOUD_ROUTE, isDestinationGranted, parsePolicy, resolveInferenceMode, strongest, type Policy,
} from './index.ts';
import { loadDefaultPolicy } from './load.ts';
import * as barrel from './index.ts';

const base = loadDefaultPolicy();
const cloudPolicy = (over: Partial<Policy> = {}): Policy => ({
  ...base,
  preferredMode: 'PREFER_ON_DEVICE',
  selectedSources: ['a', 'b'],
  destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['public', 'internal'] }],
  ...over,
});

describe('classification', () => {
  it('derived content inherits strongest classification', () => {
    expect(deriveClassification(['public', 'restricted', 'internal'])).toBe('restricted');
    expect(deriveClassification(['public', 'secret'])).toBe('secret');
    expect(deriveClassification([])).toBeUndefined();
  });
  it('unknown labels never lower or launder a classification', () => {
    expect(applyProposedClassification('restricted', 'none' as never).label).toBe('restricted');
    expect(applyProposedClassification('restricted', undefined as never).label).toBe('restricted');
    expect(deriveClassification(['restricted', undefined, 'public'] as never)).toBeUndefined();
    expect(deriveClassification(['restricted', 'bogus', 'public'] as never)).toBeUndefined();
    expect(strongest('restricted', 'bogus' as never)).toBe('secret');
  });
  it('model cannot lower classification', () => {
    expect(applyProposedClassification('restricted', 'public')).toMatchObject({ label: 'restricted', loweringIgnored: true });
    expect(applyProposedClassification('internal', 'restricted').label).toBe('restricted');
  });
});

describe('resolveInferenceMode', () => {
  it('restricted source only ever yields ONLY_ON_DEVICE', () => {
    for (const preferredMode of ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const) {
      const r = resolveInferenceMode(
        [{ id: 'a', classification: 'public' }, { id: 'b', classification: 'restricted' }],
        cloudPolicy({ preferredMode }),
      );
      expect(r).toMatchObject({ blocked: false, mode: 'ONLY_ON_DEVICE', allowFallback: false });
    }
  });
  it('secret, empty and unclassified sources block', () => {
    const p = cloudPolicy();
    expect(resolveInferenceMode([{ id: 'a', classification: 'secret' }], p)).toMatchObject({ blocked: true });
    expect(resolveInferenceMode([], p)).toMatchObject({ blocked: true, reason: 'no_sources' });
    expect(resolveInferenceMode([{ id: 'a' }], p)).toMatchObject({ blocked: true, reason: 'unclassified_source' });
    expect(resolveInferenceMode([{ id: 'a', classification: 'public' }], undefined)).toMatchObject({ blocked: true });
  });
  it('missing destination → blocked or no fallback, not cloud', () => {
    const p = cloudPolicy({ destinations: [] });
    const src = [{ id: 'a', classification: 'public' as const }];
    expect(resolveInferenceMode(src, { ...p, preferredMode: 'ONLY_IN_CLOUD' })).toMatchObject({ blocked: true });
    expect(resolveInferenceMode(src, { ...p, preferredMode: 'PREFER_IN_CLOUD' })).toMatchObject({ blocked: true });
    expect(resolveInferenceMode(src, p)).toMatchObject({ blocked: false, mode: 'PREFER_ON_DEVICE', allowFallback: false });
  });
  it('PREFER_ON_DEVICE fallback only when cloud approved for all sources', () => {
    const p = cloudPolicy();
    const ok = [{ id: 'a', classification: 'public' as const }, { id: 'b', classification: 'internal' as const }];
    expect(resolveInferenceMode(ok, p)).toMatchObject({ allowFallback: true });
    expect(resolveInferenceMode([...ok, { id: 'zz', classification: 'public' }], p)).toMatchObject({ allowFallback: false });
  });
  it('cloud modes work when approved', () => {
    const src = [{ id: 'a', classification: 'internal' as const }];
    expect(resolveInferenceMode(src, cloudPolicy({ preferredMode: 'ONLY_IN_CLOUD' }))).toMatchObject({ mode: 'ONLY_IN_CLOUD', allowFallback: false });
    expect(resolveInferenceMode(src, cloudPolicy({ preferredMode: 'PREFER_IN_CLOUD' }))).toMatchObject({ mode: 'PREFER_IN_CLOUD', policyVersion: base.policyVersion });
  });
  it('invalid mode blocks', () => {
    expect(resolveInferenceMode([{ id: 'a', classification: 'public' }], cloudPolicy({ preferredMode: 'WAT' as never }))).toMatchObject({ blocked: true, reason: 'invalid_mode' });
  });
  it('cloud worker grant does not imply inference grant', () => {
    const p = cloudPolicy({ destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'execution', classifications: ['public', 'internal'] }], preferredMode: 'ONLY_IN_CLOUD' });
    expect(resolveInferenceMode([{ id: 'a', classification: 'public' }], p)).toMatchObject({ blocked: true });
  });
  it('a grant that lists restricted still cannot route to cloud', () => {
    const p = cloudPolicy({ destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['restricted'] }] });
    expect(resolveInferenceMode([{ id: 'a', classification: 'restricted' }], p)).toMatchObject({ mode: 'ONLY_ON_DEVICE' });
  });
  it("a task's effective route policy replaces the policy's preferred mode, and never relaxes the data rule", () => {
    const src = [{ id: 'a', classification: 'internal' as const }];
    const p = cloudPolicy({ preferredMode: 'ONLY_ON_DEVICE' });
    expect(resolveInferenceMode(src, p, 'ONLY_IN_CLOUD')).toMatchObject({ blocked: false, mode: 'ONLY_IN_CLOUD' });
    expect(resolveInferenceMode(src, cloudPolicy({ preferredMode: 'ONLY_IN_CLOUD' }), 'ONLY_ON_DEVICE')).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowFallback: false });
    // Restricted stays on the device whatever the route policy asks.
    expect(resolveInferenceMode([{ id: 'a', classification: 'restricted' }], p, 'ONLY_IN_CLOUD')).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowFallback: false });
    // A cloud mode still needs the cloud grant.
    expect(resolveInferenceMode(src, { ...base, selectedSources: ['a'] }, 'PREFER_IN_CLOUD')).toMatchObject({ blocked: true, reason: 'missing_destination:firebase_cloud_inference' });
    // An explicit null means the route policy is unset: blocked, never the policy's default.
    expect(resolveInferenceMode(src, p, null)).toMatchObject({ blocked: true, reason: 'route_policy_unset' });
  });
});

describe('evaluate', () => {
  const grantPolicy: Policy = {
    ...base,
    selectedSources: ['a'],
    destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'execution', classifications: ['public', 'internal'] }],
  };
  const start = {
    kind: 'start_cloud_worker', destination: 'cloud-sandbox-eu', sources: [{ id: 'a', classification: 'internal' }],
    totalRunning: 1, estimatedCost: 1, remainingBudget: 5,
  } as const;
  it('eligible cloud start within limits → allow, recorded as policy decision', () => {
    const d = evaluate(start, grantPolicy);
    expect(d).toMatchObject({ decision: 'allow', record: 'policy_decision', policyVersion: base.policyVersion });
    expect(d.record).not.toBe('approval.granted');
  });
  it('destinations: [] denies cloud start', () => {
    expect(evaluate(start, { ...base, selectedSources: ['a'] })).toMatchObject({ decision: 'deny', reason: 'missing_destination:execution' });
  });
  it('cloud start denied for bad sources, destinations, limits, budget', () => {
    const deny = (op: object, why: string, p: Policy = grantPolicy) => expect(evaluate({ ...start, ...op } as never, p)).toMatchObject({ decision: 'deny', reason: why });
    deny({ sources: [] }, 'no_sources');
    deny({ sources: [{ id: 'a' }] }, 'unclassified_source');
    deny({ sources: [{ id: 'a', classification: 'restricted' }] }, 'source_not_cloud_eligible');
    deny({ sources: [{ id: 'a', classification: 'secret' }] }, 'source_not_cloud_eligible');
    deny({ sources: [{ id: 'zz', classification: 'public' }] }, 'source_not_selected');
    deny({ sources: [{ id: 'a', classification: 'public' }], destination: 'other' }, 'missing_destination:execution');
    deny({ destination: undefined }, 'missing_destination:execution');
    deny({ totalRunning: 2 }, 'concurrency_limit_reached');
    deny({ estimatedCost: null }, 'budget:unknown_cost');
    deny({ remainingBudget: null }, 'budget:missing_limit');
    deny({}, 'missing_limit:maxConcurrentTotal', { ...grantPolicy, limits: {} });
    deny({}, 'configured_deny:start_cloud_worker', { ...grantPolicy, operations: { start_cloud_worker: 'deny' } });
  });
  it('a grant for another purpose does not cover execution', () => {
    const p = { ...grantPolicy, destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'inference' as const, classifications: ['internal' as const] }] };
    expect(evaluate(start, p).reason).toBe('missing_destination:execution');
  });
  it('isDestinationGranted is per purpose and never grants secret', () => {
    expect(isDestinationGranted('execution', 'cloud-sandbox-eu', 'internal', grantPolicy)).toBe(true);
    for (const purpose of ['inference', 'storage', 'telemetry', 'integration'] as const) {
      expect(isDestinationGranted(purpose, 'cloud-sandbox-eu', 'internal', grantPolicy)).toBe(false);
    }
    expect(isDestinationGranted('execution', 'cloud-sandbox-eu', 'restricted', grantPolicy)).toBe(false);
    expect(isDestinationGranted('execution', 'cloud-sandbox-eu', 'secret', grantPolicy)).toBe(false);
    expect(isDestinationGranted('execution', 'x', 'public', undefined)).toBe(false);
    expect(() => parsePolicy({ ...base, destinations: [{ destination: 'd', purpose: 'storage', classifications: ['secret'] }] })).toThrow();
  });
  it('start_cloud_worker and repair_within_limits honour configured require_approval', () => {
    const p: Policy = { ...grantPolicy, operations: { start_cloud_worker: 'require_approval', repair_within_limits: 'require_approval' } };
    expect(evaluate(start, p)).toMatchObject({ decision: 'require_approval', reason: 'configured_require_approval:start_cloud_worker', record: 'policy_decision' });
    expect(evaluate({ kind: 'repair_within_limits', attempt: 1, estimatedCost: 1, remainingBudget: 5 }, p))
      .toMatchObject({ decision: 'require_approval', reason: 'configured_require_approval:repair_within_limits' });
    // A deny still wins over require_approval.
    expect(evaluate({ ...start, totalRunning: 2 }, p)).toMatchObject({ decision: 'deny', reason: 'concurrency_limit_reached' });
    expect(evaluate({ kind: 'repair_within_limits', attempt: 3, estimatedCost: 1, remainingBudget: 5 }, p)).toMatchObject({ decision: 'deny', reason: 'repair_limit_exhausted' });
  });
  it('isDestinationGranted refuses a restricted label for execution even when a grant lists it', () => {
    const p = { ...grantPolicy, destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'execution' as const, classifications: ['public', 'internal', 'restricted'] as never }] };
    expect(isDestinationGranted('execution', 'cloud-sandbox-eu', 'restricted', p)).toBe(false);
    expect(isDestinationGranted('execution', 'cloud-sandbox-eu', 'internal', p)).toBe(true);
  });
  it('totalRunning must be a non-negative integer', () => {
    for (const totalRunning of [NaN, undefined, -5, 1.5, '0']) {
      expect(evaluate({ ...start, totalRunning } as never, grantPolicy).reason).toBe('invalid_running_count');
    }
  });
  it('new domain → require_approval', () => {
    expect(evaluate({ kind: 'new_domain' }, base)).toMatchObject({ decision: 'require_approval' });
    expect(evaluate({ kind: 'budget_increase' }, base).decision).toBe('require_approval');
    expect(evaluate({ kind: 'breaking_api_change' }, base).decision).toBe('require_approval');
  });
  it('routine operations allow; repair limited', () => {
    for (const kind of ['read_approved_docs', 'run_scoped_tests', 'edit_scoped_dev_branch', 'create_draft_pr'] as const) {
      expect(evaluate({ kind }, base).decision).toBe('allow');
    }
    const r = { kind: 'repair_within_limits', estimatedCost: 1, remainingBudget: 5 } as const;
    expect(evaluate({ ...r, attempt: 2 }, base).decision).toBe('allow');
    expect(evaluate({ ...r, attempt: 3 }, base).decision).toBe('deny');
    expect(evaluate({ ...r, attempt: 1, estimatedCost: null }, base).reason).toBe('budget:unknown_cost');
    expect(evaluate({ ...r, attempt: 1, remainingBudget: 0 }, base).reason).toBe('budget:exceeds_limit');
    expect(evaluate({ ...r, attempt: 1 }, { ...base, operations: { repair_within_limits: 'deny' } }).reason).toBe('configured_deny:repair_within_limits');
  });
  it('production action deny has no approval path', () => {
    for (const kind of ['production_data', 'production_infrastructure', 'deploy', 'merge_protected_branch'] as const) {
      const d = evaluate({ kind }, base);
      expect(d.decision).toBe('deny');
      expect(applyApproval(d, true).decision).toBe('deny');
    }
    expect(() => parsePolicy({ ...base, operations: { ...base.operations, deploy: 'allow' } })).toThrow();
    expect(evaluate({ kind: 'deploy' }, { ...base, operations: {} }).decision).toBe('deny');
  });
  it('only an administrator with configured allow can modify policy, credentials, org permissions', () => {
    for (const kind of ['modify_policy', 'modify_credentials', 'modify_org_permissions'] as const) {
      expect(evaluate({ kind, actor: 'agent' }, base).reason).toBe(`not_administrator:${kind}`);
      expect(evaluate({ kind, actor: 'unknown' }, { ...base, operations: { [kind]: 'allow' } }).decision).toBe('deny');
      expect(evaluate({ kind, actor: 'administrator' }, base).decision).toBe('deny');
      expect(evaluate({ kind, actor: 'administrator' }, { ...base, operations: {} }).reason).toBe(`missing_operation_config:${kind}`);
      expect(evaluate({ kind, actor: 'administrator' }, { ...base, operations: { [kind]: 'allow' } }).decision).toBe('allow');
    }
  });
  it('human-decision kinds cannot be configured to allow', () => {
    for (const kind of ['budget_increase', 'breaking_api_change', 'scope_change', 'new_domain', 'destructive_data_migration']) {
      expect(() => parsePolicy({ ...base, operations: { ...base.operations, [kind]: 'allow' } })).toThrow();
      expect(evaluate({ kind } as never, { ...base, operations: { [kind]: 'allow' } } as never).decision).not.toBe('allow');
    }
    expect(evaluate({ kind: 'destructive_data_migration' }, base).decision).toBe('require_approval');
  });
  it('section 11 routine operations exist', () => {
    expect(evaluate({ kind: 'append_artifacts' }, base).decision).toBe('allow');
    expect(evaluate({ kind: 'assign_replan_tasks' }, base).decision).toBe('allow');
  });
  it('unknown operation kinds deny, even via the prototype chain', () => {
    for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'bogus', 42]) {
      expect(evaluate({ kind } as never, base)).toMatchObject({ decision: 'deny', reason: 'unknown_operation' });
    }
  });
  it('invalid configured treatment denies', () => {
    expect(evaluate({ kind: 'create_draft_pr' }, { ...base, operations: { create_draft_pr: 'yes' } } as never).decision).toBe('deny');
  });
  it('barrel has no node:fs loader', () => {
    expect('loadDefaultPolicy' in barrel).toBe(false);
  });
  it('approval resolves require_approval only', () => {
    const d = evaluate({ kind: 'new_domain' }, base);
    expect(applyApproval(d, true).decision).toBe('allow');
    expect(applyApproval(d, false).decision).toBe('require_approval');
  });
  it('missing config denies and names what is missing', () => {
    expect(evaluate({ kind: 'new_domain' }, undefined)).toMatchObject({ decision: 'deny', reason: 'missing_policy' });
    expect(evaluate({ kind: 'new_domain' }, { policyVersion: 'x' })).toMatchObject({ decision: 'deny', reason: 'missing_operation_config:new_domain' });
  });
  it('default policy ships a version and validates', () => {
    expect(base.policyVersion).toBeTruthy();
    expect(() => parsePolicy({ operations: {} })).toThrow();
  });
});

describe('budget', () => {
  it('absent limit denies; unknown cost blocks', () => {
    expect(checkWithinLimit(1, undefined).ok).toBe(false);
    expect(checkWithinLimit(null, 5).reason).toBe('unknown_cost');
    expect(checkWithinLimit(NaN, 5).ok).toBe(false);
    expect(checkWithinLimit(5, 5).ok).toBe(true);
    expect(checkWithinLimit(6, 5).reason).toBe('exceeds_limit');
    expect(checkReservation(undefined, 5).ok).toBe(false);
  });
});

describe('terminal control', () => {
  it('is denied by the shipped policy and by a policy that does not name it', () => {
    expect(evaluate({ kind: 'terminal_control' }, base).decision).toBe('deny');
    expect(evaluate({ kind: 'terminal_control' }, { policyVersion: 'x', operations: {} }).decision).toBe('deny');
    expect(evaluate({ kind: 'terminal_control' }, undefined).decision).toBe('deny');
  });
  it('is allowed only where a project grants it', () => {
    const granted = { ...base, operations: { ...base.operations, terminal_control: 'allow' as const } };
    expect(evaluate({ kind: 'terminal_control' }, granted).decision).toBe('allow');
    expect(parsePolicy(granted).operations?.['terminal_control']).toBe('allow');
  });
});
