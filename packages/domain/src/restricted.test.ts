import { describe, expect, it } from 'vitest';
import { RESTRICTED_FALLBACK, RESTRICTED_REASONS, restrictedApproval, restrictedDiffReason, restrictedReason, WORKER_APPROVAL_OPERATIONS } from './index.ts';

const CANARY = 'secret/RESTRICTED-CANARY.md';

describe('what a restricted attempt may put in the record', () => {
  it('keeps a reason that is on the closed list for its outcome', () => {
    for (const [outcome, list] of Object.entries(RESTRICTED_REASONS) as [keyof typeof RESTRICTED_REASONS, readonly string[]][]) {
      for (const reason of list) expect(restrictedReason(outcome, reason)).toBe(reason);
    }
  });

  it.each(Object.keys(RESTRICTED_REASONS) as (keyof typeof RESTRICTED_REASONS)[])('replaces anything else for %s with that outcome\'s fixed category', (outcome) => {
    for (const sent of [`could not compute the diff: ENOENT ${CANARY}`, `change set could not be stored: ${CANARY} changed after it was checked`, `${RESTRICTED_REASONS[outcome][0]}: ${CANARY}`, '']) {
      const kept = restrictedReason(outcome, sent);
      expect(kept).toBe(RESTRICTED_FALLBACK[outcome]);
      expect(kept).not.toContain('CANARY');
    }
  });

  it('a reason listed for one outcome is not kept for another', () => {
    expect(restrictedReason('blocked', 'task_bundle_failed')).toBe(RESTRICTED_FALLBACK.blocked);
    expect(restrictedReason('infrastructure_failed', 'model_mismatch')).toBe(RESTRICTED_FALLBACK.infrastructure_failed);
  });

  it('a diff gate reason keeps only its count, rebuilt from the number', () => {
    expect(restrictedReason('failed', `diff outside allowedPaths: 2 path(s): ${CANARY} (outside)`)).toBe(restrictedDiffReason(2));
    expect(restrictedReason('infrastructure_failed', 'diff outside allowedPaths: 2 path(s)')).toBe(RESTRICTED_FALLBACK.infrastructure_failed);
  });

  it('every listed reason is a fixed string with no room for a path', () => {
    for (const list of Object.values(RESTRICTED_REASONS)) for (const r of list) expect(r).not.toMatch(/[/\\]/);
  });

  it('an approval request keeps a known operation and a checked host, and never the words', () => {
    expect(restrictedApproval('destructive_data_migration', undefined)).toEqual({ operation: 'destructive_data_migration', reason: expect.stringMatching(/destructive_data_migration.*restricted/) });
    const unknown = restrictedApproval(CANARY, undefined);
    expect(unknown.operation).toBeUndefined();
    expect(unknown.reason).not.toContain('CANARY');
    expect(restrictedApproval('new_domain', { kind: 'network_host', host: 'docs.example.com' }).reason).toContain('docs.example.com');
    expect(restrictedApproval('new_domain', { kind: 'network_host', host: CANARY } as never).reason).not.toContain('CANARY');
    for (const op of WORKER_APPROVAL_OPERATIONS) expect(restrictedApproval(op, undefined).operation).toBe(op);
  });
});
