import { describe, expect, it } from 'vitest';
import { NO_ASSUMPTIONS, type OnboardingView } from '@selarikru/domain';
import { furthestStep } from './steps.ts';
import { createDemoOnboardingApi } from './demo-api.ts';

const goal = { name: 'Clinic', idea: 'Idea', audience: 'Clinics', firstOutcome: 'Outcome', classification: 'internal' as const };

describe('furthest step', () => {
  const base: OnboardingView = { projectId: 'p', name: 'p', state: 'draft', condition: null, revision: 1, goal, goalAssist: null, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null, deployment: { sourceCheckout: null, servesRepository: null, checker: true } };
  it('follows the server record', () => {
    expect(furthestStep(null)).toBe('goal');
    expect(furthestStep(base)).toBe('source');
    expect(furthestStep({ ...base, state: 'discovering', source: { kind: 'new' } })).toBe('focus');
    expect(furthestStep({ ...base, state: 'ready' })).toBe('start');
  });
});

describe('the demo onboarding api', () => {
  it('can never pass readiness or start a run', async () => {
    const api = createDemoOnboardingApi();
    const created = await api.create({ idempotencyKey: 'k', goal });
    if (!created.ok) throw new Error('create failed');
    const id = created.value.projectId;
    await api.saveAnswers(id, { idempotencyKey: 'a', expectedRevision: 1, source: { kind: 'new' }, focus: { tracks: ['saas_web'] } });
    await api.createBlueprint(id, { idempotencyKey: 'b', expectedRevision: 2 });
    await api.acceptBlueprint(id, { idempotencyKey: 'c', expectedRevision: 3, version: 1 });
    await api.saveCostPlan(id, { idempotencyKey: 'd', expectedRevision: 4, agentBudgetUsd: 5, effort: [], production: [], agentUsage: [], assumptions: NO_ASSUMPTIONS });
    await api.saveExecution(id, { idempotencyKey: 'e', expectedRevision: 5, execution: 'local', inference: 'PREFER_ON_DEVICE' });
    await api.saveConnection(id, { idempotencyKey: 'f', expectedRevision: 6, repository: 'a/b', defaultBranch: 'main' });
    const r = await api.runReadiness(id, { expectedRevision: 7 });
    if (!r.ok) throw new Error('readiness failed');
    expect(r.value.readiness?.checks.every((c) => c.status === 'unknown')).toBe(true);
    expect(r.value.state).not.toBe('ready');
    const started = await api.activate(id, { idempotencyKey: 'g', expectedRevision: 8, blueprintVersion: 1 });
    expect(started.ok).toBe(false);
  });
});
