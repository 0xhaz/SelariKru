import { describe, expect, it } from 'vitest';
import {
  applyApproval, applyProposedClassification, checkReservation, checkWithinLimit, deriveClassification,
  evaluate, FIREBASE_CLOUD_ROUTE, loadDefaultPolicy, parsePolicy, resolveInferenceMode, type Policy,
} from './index.ts';

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
  it('model cannot lower classification', () => {
    expect(applyProposedClassification('restricted', 'public')).toEqual({ label: 'restricted', loweringIgnored: true });
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
  it('cloud worker grant does not imply inference grant', () => {
    const p = cloudPolicy({ destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'execution', classifications: ['public', 'internal'] }], preferredMode: 'ONLY_IN_CLOUD' });
    expect(resolveInferenceMode([{ id: 'a', classification: 'public' }], p)).toMatchObject({ blocked: true });
  });
  it('a grant that lists restricted still cannot route to cloud', () => {
    const p = cloudPolicy({ destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['restricted'] }] });
    expect(resolveInferenceMode([{ id: 'a', classification: 'restricted' }], p)).toMatchObject({ mode: 'ONLY_ON_DEVICE' });
  });
});

describe('evaluate', () => {
  const start = { kind: 'start_cloud_worker', totalRunning: 1, executionGranted: true, estimatedCost: 1, remainingBudget: 5 } as const;
  it('eligible cloud start within limits → allow, recorded as policy decision', () => {
    const d = evaluate(start, base);
    expect(d).toMatchObject({ decision: 'allow', record: 'policy_decision', policyVersion: base.policyVersion });
    expect(d.record).not.toBe('approval.granted');
  });
  it('cloud start denied on missing destination, limits, budget', () => {
    expect(evaluate({ ...start, executionGranted: false }, base).decision).toBe('deny');
    expect(evaluate({ ...start, totalRunning: 2 }, base).reason).toBe('concurrency_limit_reached');
    expect(evaluate({ ...start, estimatedCost: null }, base).reason).toBe('budget:unknown_cost');
    expect(evaluate({ ...start, remainingBudget: null }, base).reason).toBe('budget:missing_limit');
    expect(evaluate(start, { policyVersion: 'x' })).toMatchObject({ decision: 'deny', reason: 'missing_limit:maxConcurrentTotal' });
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
    expect(evaluate({ kind: 'repair_within_limits', attempt: 2 }, base).decision).toBe('allow');
    expect(evaluate({ kind: 'repair_within_limits', attempt: 3 }, base).decision).toBe('deny');
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
  it('agents cannot modify policy or credentials', () => {
    expect(evaluate({ kind: 'modify_policy', actor: 'agent' }, base).decision).toBe('deny');
    expect(evaluate({ kind: 'modify_credentials', actor: 'unknown' }, base).decision).toBe('deny');
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
