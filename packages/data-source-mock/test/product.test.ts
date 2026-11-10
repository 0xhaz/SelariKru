import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_MEASURE } from '@selarikru/domain';
import { ProductViewSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';

const setup = () => {
  const clock = createSeededClock(fixtureTime(0));
  const ds = createMockDataSource({ clock });
  return { ds, clock, projectId: buildFixture('merge-flow').projectId };
};
const PLAN = {
  schemaVersion: 1 as const, requirementIds: ['FB-03'], milestone: null, metric: 'Minutes to first triage', baseline: UNKNOWN_MEASURE, target: UNKNOWN_MEASURE, learningQuestion: 'Do leads triage sooner?',
  windowDays: null, dataSource: null, cohort: null, guardrails: [], reviewOwner: 'demo owner', reviewDate: null, decisionOptions: ['iterate' as const, 'retain' as const], reportLinks: [], confidence: 'unknown' as const,
};
const row = (v: { trace: { requirementId: string }[] }, id: string) => v.trace.find((r) => r.requirementId === id) as ReturnType<typeof ProductViewSchema.parse>['trace'][number];

describe('the demo product records', () => {
  it('traces a requirement through the demo evidence, keeps unknowns unknown, and follows the release rules the server follows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ds, clock, projectId } = setup();
    let v = ProductViewSchema.parse(await ds.getProduct!(projectId));
    // The demo has one worker proposal and no confirmed brief.
    expect(row(v, 'FB-03').links.find((l) => l.kind === 'problem_brief')!.state).toBe('proposed');
    expect(row(v, 'FB-03').links.find((l) => l.kind === 'verification')!.state).toBe('present');
    expect(v.brief.seed).not.toBeNull();

    v = (await ds.productAction!(projectId, { kind: 'save_brief', expectedRevision: 0, confirm: true, content: v.brief.seed! })).product;
    await expect(ds.productAction!(projectId, { kind: 'save_brief', expectedRevision: 0, confirm: true, content: v.brief.seed! })).rejects.toThrow(/changed/);
    await expect(ds.productAction!(projectId, { kind: 'save_plan', recordId: null, expectedRevision: 0, content: { ...PLAN, requirementIds: ['FB-99'] } })).rejects.toThrow(/FB-99/);
    v = (await ds.productAction!(projectId, { kind: 'save_plan', recordId: null, expectedRevision: 0, content: PLAN })).product;
    expect(v.plans[0]!.kind === 'outcome_plan' && v.plans[0]!.content.baseline.value).toBeNull();
    expect(row(v, 'FB-03').outcome.label).toBe('Not released');

    const release = { schemaVersion: 1 as const, runId: v.trace[0]!.runIds[0]!, environment: 'production', configuration: null, releasedOn: '2026-11-17', note: null };
    await expect(ds.productAction!(projectId, { kind: 'add_release', content: release })).rejects.toThrow(/merged/);
    clock.advance(40_000);
    v = ProductViewSchema.parse(await ds.getProduct!(projectId));
    expect(row(v, 'FB-03').links.find((l) => l.kind === 'merge')!.state).toBe('present');
    expect(row(v, 'FB-03').outcome.label).toBe('Not released');
    v = (await ds.productAction!(projectId, { kind: 'add_release', content: release })).product;
    expect(row(v, 'FB-03').outcome.label).toBe('Awaiting observations');

    const before = JSON.stringify((await ds.getSnapshot(projectId)).tasks);
    v = (await ds.productAction!(projectId, { kind: 'add_review', content: {
      schemaVersion: 1, planRecordId: v.plans[0]!.recordId, releaseRecordId: v.releases[0]!.recordId, observedEnvironment: null, observedConfiguration: null, windowFrom: null, windowTo: null, evidence: [],
      result: UNKNOWN_MEASURE, summary: 'Too early', unknowns: [], decision: 'iterate', followUp: { title: 'Show triage age', requirementIds: ['FB-03'], reason: 'Leads asked' },
    } })).product;
    expect(v.followUps).toEqual([expect.objectContaining({ title: 'Show triage age', state: 'proposed' })]);
    expect(row(v, 'FB-03').outcome.label).toBe('Insufficient data');
    expect(JSON.stringify((await ds.getSnapshot(projectId)).tasks)).toBe(before);
    expect(v.milestones[0]).toMatchObject({ release: { state: 'released' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});


describe('fix round 1: demo worker proposals and review checks', () => {
  it('a worker proposal sits beside the brief, confirming does not take its text unless chosen, and a review must match its release', async () => {
    const { ds, clock, projectId } = setup();
    let v = ProductViewSchema.parse(await ds.getProduct!(projectId));
    expect(v.brief.proposals).toHaveLength(1);
    expect(v.brief.revision).toBe(0);
    const proposal = v.brief.proposals[0]!;
    expect(v.brief.seed!.targetUser).not.toBe(proposal.content.targetUser);
    let r = await ds.productAction!(projectId, { kind: 'save_brief', expectedRevision: 0, confirm: true, content: v.brief.seed! });
    expect(r.redacted).toBe(false);
    expect(r.product.brief.confirmed!.kind === 'problem_brief' && r.product.brief.confirmed!.content.targetUser).toBe(v.brief.seed!.targetUser);
    expect(r.product.brief.proposals).toHaveLength(1);
    r = await ds.productAction!(projectId, { kind: 'save_brief', expectedRevision: 1, confirm: true, content: proposal.content, fromProposalId: proposal.proposalId });
    expect(r.product.brief.proposals).toHaveLength(0);
    expect(r.product.citable.length).toBeGreaterThan(0);

    r = await ds.productAction!(projectId, { kind: 'save_plan', recordId: null, expectedRevision: 0, content: { ...PLAN, requirementIds: ['FB-04'] } });
    clock.advance(40_000);
    r = await ds.productAction!(projectId, { kind: 'add_release', content: { schemaVersion: 1, runId: r.product.trace[0]!.runIds[0]!, environment: 'production', configuration: null, releasedOn: '2026-11-17', note: null } });
    const review = { schemaVersion: 1 as const, planRecordId: r.product.plans[0]!.recordId, releaseRecordId: r.product.releases[0]!.recordId, observedEnvironment: 'production', observedConfiguration: null, windowFrom: '2026-11-17', windowTo: '2026-11-30', evidence: [], result: UNKNOWN_MEASURE, summary: 's', unknowns: [], decision: 'iterate' as const, followUp: { title: 't', requirementIds: ['FB-99'], reason: 'r' } };
    await expect(ds.productAction!(projectId, { kind: 'add_review', content: review })).rejects.toThrow(/FB-99/);
    v = (await ds.productAction!(projectId, { kind: 'add_review', content: { ...review, followUp: null } })).product;
    expect(v.reviews).toHaveLength(1);
  });
});
