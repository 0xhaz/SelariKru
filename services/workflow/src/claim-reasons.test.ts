import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyClaimReason } from './claim-reasons.ts';

/** Every reason the claim path can return, read from the code that returns it, so a new one cannot go unclassified. */
const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), 'utf8');
const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]!);

function emitted(): string[] {
  const claim = src('claim.ts');
  const placement = src('placement.ts');
  const handover = src('handover.ts');
  const reserve = src('reserve.ts');
  const policy = src('../../../packages/policy/src/evaluate.ts');
  const budget = src('../../../packages/policy/src/budget.ts');
  const literals = [
    ...all(claim, /return \{ (?:ok: false, )?reason: '([a-z_:]+)'/g),
    ...all(claim, /return `(missing_limit):\$\{/g).map((p) => `${p}:x`),
    // `placement_blocked:` details are the placement's reasons, read from placement.ts below; `budget:` details are listed from budget.ts.
    ...all(claim, /reason: `([a-z_]+:)\$\{/g).filter((p) => p !== 'placement_blocked:' && p !== 'budget:').map((p) => `${p}x`),
    'placement_blocked:policy_revoked:allowed_paths',
    ...all(placement, /block\('([a-z_]+)'/g).map((r) => `placement_blocked:${r}`),
    ...all(placement, /block\(`([a-z_]+:)\$\{/g).map((p) => `placement_blocked:${p}x`),
    ...all(placement, /reason: '([a-z_]+)', transient/g).map((r) => `placement_blocked:${r}`),
    ...all(handover, /kind: 'wait', reason: '([a-z_]+)'/g),
    ...all(handover, /kind: 'wait', reason: `([a-z_]+)\$\{/g).map((p) => `${p}cloud`),
    ...all(reserve, /reason: '(budget:[a-z_]+)'/g),
    ...all(budget, /reason: '([a-z_]+)' \}/g).filter((r) => r !== 'within_limit').map((r) => `budget:${r}`),
    ...all(policy, /decide\('deny', '([a-z_:]+)'/g),
    ...all(policy, /decide\('deny', `([a-z_]+:)\$\{/g).filter((p) => p !== 'budget:').map((p) => `${p}x`),
  ];
  return [...new Set(literals)].sort();
}

describe('claim reasons', () => {
  it('classifies every reason the claim code can emit', () => {
    const reasons = emitted();
    expect(reasons.length).toBeGreaterThan(30);
    const unknown = reasons.filter((r) => !classifyClaimReason(r).known);
    expect(unknown).toEqual([]);
  });

  it('names the transient ones explicitly, and treats an unknown reason as not transient', () => {
    for (const r of ['infra_retry_backoff', 'resource_conflict', 'no_free_slot', 'reservation_not_settled', 'placement_blocked:no_free_slot', 'placement_blocked:concurrency_limit_reached', 'placement_blocked:policy_denied:concurrency_limit_reached']) {
      expect(classifyClaimReason(r), r).toEqual({ known: true, transient: true });
    }
    for (const r of ['budget:exceeds_limit', 'budget:unknown_cost', 'model_blocked:unsupported_model', 'placement_blocked:classification_not_cloud_eligible', 'run_paused', 'repair_limit_exhausted']) {
      expect(classifyClaimReason(r), r).toEqual({ known: true, transient: false });
    }
    expect(classifyClaimReason('budget_something_new')).toEqual({ known: false, transient: false });
  });
});
