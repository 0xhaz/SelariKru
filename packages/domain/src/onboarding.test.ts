import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRITERION_DESCRIPTIONS } from './evidence.ts';
import {
  BlueprintContentSchema, COST_REFERENCES, CostLineSchema, ONBOARDING_STATES, advanceOnboarding, blueprintFromAnswers, costPlanFor, ledgerTotals, pilotCriteriaProblem, routeHonoursRecorded, TEMPLATE_CATALOG, templateSupport,
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

  it('names the executable track as the pilot stack and claims nothing wider', () => {
    expect(TEMPLATE_CATALOG.saas_web.label).toBe('Pilot stack (Feedback Board)');
    expect(TEMPLATE_CATALOG.saas_web.reason).not.toMatch(/certified to/i);
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

  describe('the pilot stack', () => {
    const starter = new URL('../../../examples/feedback-board-starter/', import.meta.url);
    /** Generated or runtime directories, the frozen contract, and the frozen test fixtures: everything a worker may not change. */
    const READ_ONLY = new Set(['node_modules', 'dist', 'data', 'contract', 'fixtures']);

    it('lets workers change every writable directory of the starter shell, and never the contract', () => {
      const writable = readdirSync(starter, { withFileTypes: true }).filter((e) => e.isDirectory() && !READ_ONLY.has(e.name)).map((e) => e.name).sort();
      expect(writable).toEqual(expect.arrayContaining(['migrations', 'server', 'src', 'tests']));
      const { allowedPaths } = blueprintFromAnswers(answers());
      expect([...allowedPaths].sort()).toEqual(writable);
      expect(allowedPaths).not.toContain('contract');
      expect(allowedPaths).not.toContain('fixtures');
    });

    it('is judged on the criteria of the frozen suite, FB-01 to FB-08', () => {
      const manifest = JSON.parse(readFileSync(new URL('../../../services/verifier/suites/feedback-board/manifest.json', import.meta.url), 'utf8')) as { criteria: { id: string }[] };
      const c = blueprintFromAnswers(answers());
      expect(c.acceptanceCriteria.map((a) => a.id)).toEqual(manifest.criteria.map((a) => a.id));
      c.acceptanceCriteria.forEach((a) => expect(a.text).toContain(CRITERION_DESCRIPTIONS[a.id]!));
      expect(c.acceptanceCriteria.find((a) => a.id === 'FB-02')!.text).toBe('Reject empty/too-short/too-long titles, oversized descriptions, wrong field types and invalid statuses. Required evidence: API returns 400 without creating/updating a row; UI provides a readable validation error.');
      expect(BlueprintContentSchema.safeParse(c).success).toBe(true);
      expect(pilotCriteriaProblem(c)).toBeNull();
    });

    it('cannot have its criteria replaced, reworded or removed', () => {
      const c = blueprintFromAnswers(answers());
      expect(pilotCriteriaProblem({ ...c, acceptanceCriteria: [{ id: 'AC-1', text: 'A patient sees their position' }] })).toMatch(/FB-01/);
      expect(pilotCriteriaProblem({ ...c, acceptanceCriteria: c.acceptanceCriteria.slice(1) })).toMatch(/FB-01/);
      expect(pilotCriteriaProblem({ ...c, acceptanceCriteria: c.acceptanceCriteria.map((a, i) => (i === 0 ? { ...a, text: 'Something else' } : a)) })).toMatch(/FB-01/);
    });

    it('a plan-only track keeps its own outcome as its criterion, and no suite claims to judge it', () => {
      const c = blueprintFromAnswers(answers({ focus: { tracks: ['mobile'] } }));
      expect(c.acceptanceCriteria).toEqual([{ id: 'AC-1', text: 'A patient can see their position' }]);
      expect(c.allowedPaths).toEqual(['src', 'tests']);
      expect(pilotCriteriaProblem(c)).toBeNull();
    });

    it('gives each role its own paths: writable, and with no overlap', () => {
      const { rolePaths, allowedPaths } = blueprintFromAnswers(answers());
      expect(rolePaths).toEqual({ backend: ['server', 'migrations', 'tests/backend'], frontend: ['src', 'tests/frontend'] });
      const all = [...rolePaths!.backend, ...rolePaths!.frontend];
      expect(new Set(all).size).toBe(all.length);
      for (const p of all) expect(allowedPaths.some((a) => p === a || p.startsWith(`${a}/`))).toBe(true);
      expect(pilotCriteriaProblem({ ...blueprintFromAnswers(answers()), rolePaths: { backend: ['src'], frontend: ['src'] } })).toMatch(/fixed/);
      expect(pilotCriteriaProblem({ ...blueprintFromAnswers(answers()), rolePaths: undefined })).toMatch(/fixed/);
    });

    it('states each criterion in the starter contract in the same words, and the contract points at nothing private', () => {
      const contract = ['runtime.md', 'api.ts', 'openapi.yaml'].map((f) => readFileSync(new URL(f, new URL('contract/', starter)), 'utf8'));
      for (const a of blueprintFromAnswers(answers()).acceptanceCriteria) expect(contract[0]).toContain(`- ${a.id}: ${a.text}`);
      for (const text of contract) expect(text).not.toMatch(/docs\//);
    });

    it('tells a new project to start from the starter shell, not an empty repository', () => {
      const [assumption] = blueprintFromAnswers(answers()).assumptions;
      expect(assumption).toMatch(/examples\/feedback-board-starter/);
      expect(assumption).not.toMatch(/empty/i);
    });
  });

  it('refuses paths that climb out of the repository', () => {
    const c = blueprintFromAnswers(answers());
    expect(BlueprintContentSchema.safeParse({ ...c, allowedPaths: ['../outside'] }).success).toBe(false);
    expect(BlueprintContentSchema.safeParse({ ...c, allowedPaths: ['/etc/passwd'] }).success).toBe(false);
  });

  it('a product with model features gets an open decision about evaluation', () => {
    const c = blueprintFromAnswers(answers({ focus: { tracks: ['saas_web'], modelFeatures: 'yes' } }));
    expect(c.pendingDecisions.join(' ')).toMatch(/evaluation plan/);
    expect(blueprintFromAnswers(answers({ focus: { tracks: ['saas_web'], modelFeatures: 'no' } })).pendingDecisions).toEqual([]);
  });
});

describe('cost plan', () => {
  const unknown = (over: Partial<CostLine> = {}): CostLine => ({ id: 'x', label: 'X', cadence: 'monthly', unit: 'usd', payer: 'your_accounts', lowUsd: null, baseUsd: null, highUsd: null, provenance: 'unknown', basis: 'No estimate yet', source: null, ...over });

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
    expect(t).toEqual({ knownLow: 1, knownBase: 2, knownHigh: 3, unit: 'usd', cadence: 'monthly', unknownLines: 1 });
    expect(ledgerTotals([unknown()])).toEqual({ knownLow: null, knownBase: null, knownHigh: null, unit: 'usd', cadence: 'monthly', unknownLines: 1 });
  });

  const plan = (execution: 'local' | 'cloud' | 'hybrid') => costPlanFor({ execution, agentBudgetUsd: 10, effort: [], production: [], agentUsage: [] });

  it('keeps the three ledgers of feasibility.md, with who pays as a label on each line', () => {
    const p = plan('local');
    expect(Object.keys(p.ledgers).sort()).toEqual(['agent_usage', 'build_effort', 'production']);
    for (const l of Object.values(p.ledgers).flatMap((x) => x.lines)) expect(l.payer).toBeTruthy();
  });

  it('build effort is unknown by default, in hours, and says the agent budget is not an estimate', () => {
    const [line] = plan('local').ledgers.build_effort.lines;
    expect(line).toMatchObject({ unit: 'hours', cadence: 'one_time', provenance: 'unknown', baseUsd: null });
    expect(line!.basis).toMatch(/agent budget is not an estimate/);
    expect(plan('local').ledgers.build_effort.totals).toMatchObject({ unit: 'hours', knownBase: null, unknownLines: 1 });
  });

  it('prices cloud workers only when cloud is in scope, and keeps local hardware for hybrid', () => {
    const ids = (e: 'local' | 'cloud' | 'hybrid') => plan(e).ledgers.agent_usage.lines.map((l) => l.id);
    expect(ids('local')).toContain('local_hardware');
    expect(ids('local')).not.toContain('cloud_worker');
    expect(ids('cloud')).toContain('cloud_worker');
    expect(ids('cloud')).not.toContain('local_hardware');
    expect(ids('hybrid')).toEqual(expect.arrayContaining(['cloud_worker', 'local_hardware']));
    const line = plan('cloud').ledgers.agent_usage.lines.find((l) => l.id === 'cloud_worker')!;
    expect(line.provenance).toBe('reference_price');
    expect(line.source?.retrievedOn).toBeTruthy();
  });

  it('a per-hour rate is never added into a monthly total', () => {
    expect(plan('cloud').ledgers.agent_usage.totals.knownBase).toBeNull();
  });
});

describe('assistant route', () => {
  it('honours the recorded mode', () => {
    expect(routeHonoursRecorded('ONLY_ON_DEVICE', 'ONLY_ON_DEVICE', 'ON_DEVICE')).toBe(true);
    expect(routeHonoursRecorded('ONLY_ON_DEVICE', 'ONLY_ON_DEVICE', 'UNKNOWN')).toBe(false);
    expect(routeHonoursRecorded('ONLY_ON_DEVICE', 'PREFER_IN_CLOUD', 'ON_DEVICE')).toBe(false);
    expect(routeHonoursRecorded('PREFER_ON_DEVICE', 'PREFER_ON_DEVICE', 'IN_CLOUD')).toBe(true);
  });
});
