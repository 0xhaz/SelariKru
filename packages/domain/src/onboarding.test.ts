import { describe, expect, it } from 'vitest';
import {
  BlueprintContentSchema, COST_REFERENCES, CostLineSchema, ONBOARDING_STATES, advanceOnboarding, blueprintFromAnswers, costPlanFor, ledgerTotals, templateSupport,
  type CostLine, type OnboardingAnswers,
} from './onboarding.ts';

const answers = (over: Partial<OnboardingAnswers> = {}): OnboardingAnswers => ({
  goal: { name: 'Clinic queue', idea: 'Patients see their place in the queue', audience: 'Small clinics', firstOutcome: 'A patient can see their position' },
  source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, ...over,
});

describe('onboarding state machine', () => {
  it('uses exactly the architecture states, in order', () => {
    expect(ONBOARDING_STATES).toEqual(['draft', 'discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready', 'activated']);
  });

  it('walks from draft to activated only through the deterministic path', () => {
    let s: (typeof ONBOARDING_STATES)[number] = 'draft';
    const walk = (event: Parameters<typeof advanceOnboarding>[1]) => {
      const r = advanceOnboarding(s, event);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.value;
    };
    for (const e of ['answers_saved', 'blueprint_created', 'blueprint_accepted', 'readiness_blocked', 'readiness_passed', 'activated'] as const) walk(e);
    expect(s).toBe('activated');
  });

  it('cannot jump to activated without passing readiness', () => {
    for (const from of ONBOARDING_STATES.filter((s) => s !== 'ready')) expect(advanceOnboarding(from, 'activated').ok).toBe(false);
    expect(advanceOnboarding('ready', 'activated').ok).toBe(true);
  });

  it('a new blueprint version falls back to blueprint_ready from any setup state', () => {
    for (const from of ['discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready'] as const) {
      expect(advanceOnboarding(from, 'blueprint_created')).toEqual({ ok: true, value: 'blueprint_ready' });
    }
  });

  it('nothing moves an activated project backwards', () => {
    for (const e of ['answers_saved', 'blueprint_created', 'configuration_saved', 'readiness_passed', 'readiness_blocked'] as const) expect(advanceOnboarding('activated', e).ok).toBe(false);
  });
});

describe('templates', () => {
  it('only the certified pilot stack is executable', () => {
    expect(templateSupport(['saas_web'])).toEqual({ executable: true, unsupported: [] });
    expect(templateSupport(['mobile']).executable).toBe(false);
  });

  it('one unsupported track makes the whole project blueprint-only and names it', () => {
    const v = templateSupport(['saas_web', 'mobile']);
    expect(v.executable).toBe(false);
    expect(v.unsupported.map((u) => u.track)).toEqual(['mobile']);
    expect(v.unsupported[0]!.reason).toMatch(/toolchain|build/i);
  });
});

describe('blueprint', () => {
  it('the deterministic draft validates and copies the answers it was given', () => {
    const c = blueprintFromAnswers(answers());
    expect(BlueprintContentSchema.safeParse(c).success).toBe(true);
    expect(c.goals.idea).toBe('Patients see their place in the queue');
    expect(c.tracks).toEqual(['saas_web']);
    expect(c.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('refuses paths that climb out of the repository', () => {
    const c = blueprintFromAnswers(answers());
    expect(BlueprintContentSchema.safeParse({ ...c, allowedPaths: ['../outside'] }).success).toBe(false);
    expect(BlueprintContentSchema.safeParse({ ...c, allowedPaths: ['/etc/passwd'] }).success).toBe(false);
  });
});

describe('cost plan', () => {
  const unknown = (over: Partial<CostLine> = {}): CostLine => ({ id: 'x', label: 'X', cadence: 'monthly', lowUsd: null, baseUsd: null, highUsd: null, provenance: 'unknown', basis: 'No estimate yet', source: null, ...over });

  it('an unknown line cannot carry an amount, and a known line needs one', () => {
    expect(CostLineSchema.safeParse(unknown({ baseUsd: 0 })).success).toBe(false);
    expect(CostLineSchema.safeParse(unknown()).success).toBe(true);
    expect(CostLineSchema.safeParse(unknown({ provenance: 'user_estimate' })).success).toBe(false);
  });

  it('every line says what it is based on', () => {
    expect(CostLineSchema.safeParse(unknown({ basis: '' })).success).toBe(false);
  });

  it('a reference price must name its source', () => {
    expect(CostLineSchema.safeParse(unknown({ provenance: 'reference_price', lowUsd: 1, baseUsd: 1, highUsd: 1 })).success).toBe(false);
    expect(CostLineSchema.safeParse(unknown({ provenance: 'reference_price', lowUsd: 1, baseUsd: 1, highUsd: 1, source: COST_REFERENCES.cloudWorker2c4g })).success).toBe(true);
  });

  it('totals count unknowns separately and never treat them as zero', () => {
    const t = ledgerTotals([unknown(), unknown({ id: 'y', provenance: 'user_estimate', lowUsd: 1, baseUsd: 2, highUsd: 3, basis: 'Their bill' })]);
    expect(t).toEqual({ knownLowUsd: 1, knownBaseUsd: 2, knownHighUsd: 3, unknownLines: 1 });
    expect(ledgerTotals([unknown()])).toEqual({ knownLowUsd: null, knownBaseUsd: null, knownHighUsd: null, unknownLines: 1 });
  });

  it('keeps three separate ledgers and only prices cloud workers when cloud is in scope', () => {
    const local = costPlanFor({ execution: 'local', agentBudgetUsd: 10, provider: [], app: [] });
    expect(Object.keys(local.ledgers).sort()).toEqual(['app', 'platform', 'provider']);
    expect(local.ledgers.provider.lines.some((l) => l.id === 'cloud_worker')).toBe(false);
    const cloud = costPlanFor({ execution: 'cloud', agentBudgetUsd: 10, provider: [], app: [] });
    const line = cloud.ledgers.provider.lines.find((l) => l.id === 'cloud_worker')!;
    expect(line.provenance).toBe('reference_price');
    expect(line.source?.retrievedOn).toBeTruthy();
    expect(local.ledgers.platform.lines.every((l) => l.provenance === 'unknown' || l.basis.length > 0)).toBe(true);
  });
});
