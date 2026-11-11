import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProposal } from '@selarikru/domain';
import { FirebaseHybridAssistantAdapter, type TelemetryEvent } from './adapter.ts';
import fixtureJson from '../../../fixtures/assistant/restricted-brief.json' with { type: 'json' };
import { RestrictedDraftHold, draftContentSha256, publishDraft, reclassificationRequest, type ReclassificationGrant } from './restricted.ts';
import type { AssistantSdk, SdkModel } from './sdk.ts';

const fixture = fixtureJson as {
  classification: string; canary: string; taskText: string; allowedRequirementIds: string[]; forbiddenMandatoryScope: string[];
};
const OUT = JSON.stringify({ summary: 'Feedback form.', acceptanceCriteria: [{ requirementId: 'FB-01', text: `Title is 3 to 120 code points. ${fixtureJson.canary}` }] });

const policy = (over: Record<string, unknown> = {}) =>
  ({ policyVersion: 'p1', preferredMode: 'ONLY_ON_DEVICE', selectedSources: ['s1'], destinations: [], ...over }) as never;

describe('restricted fixture', () => {
  it('is synthetic, restricted and carries an obviously fake canary', () => {
    expect(fixture.classification).toBe('restricted');
    expect(fixture.canary).toMatch(/CANARY.*FAKE/);
    expect(fixture.taskText).toContain(fixture.canary);
  });
});

describe('restricted draft never reaches network, storage, analytics or checkpoints', () => {
  const calls: string[] = [];
  const spy = (name: string) => vi.fn((...a: unknown[]) => { calls.push(`${name}:${JSON.stringify(a)}`); return undefined; });
  let fetchSpy: ReturnType<typeof vi.fn>, beacon: ReturnType<typeof vi.fn>, setLocal: ReturnType<typeof vi.fn>, setSession: ReturnType<typeof vi.fn>, idbOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls.length = 0;
    fetchSpy = spy('fetch'); beacon = spy('sendBeacon'); setLocal = spy('localStorage'); setSession = spy('sessionStorage'); idbOpen = spy('indexedDB');
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('localStorage', { setItem: setLocal, getItem: () => null });
    vi.stubGlobal('sessionStorage', { setItem: setSession, getItem: () => null });
    vi.stubGlobal('indexedDB', { open: idbOpen });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('drafting through the adapter with a faked SDK, then holding and reviewing, touches none of them', async () => {
    const prompts: string[] = [];
    const sdk: AssistantSdk = {
      availability: async () => 'available',
      initializeDeviceModel: async () => undefined,
      createModel: (): SdkModel => ({ generate: async (p) => { prompts.push(p); return { text: OUT, inferenceSource: 'on_device' }; } }),
    };
    const events: TelemetryEvent[] = [];
    const adapter = new FirebaseHybridAssistantAdapter({ sdk, fetchRoute: async () => { throw new Error('no route read in this test'); }, onTelemetry: (e) => events.push(e) });
    const proposal = await adapter.draftBrief({
      projectId: 'p', taskText: fixture.taskText, allowedRequirementIds: fixture.allowedRequirementIds,
      sources: [{ id: 's1', classification: 'restricted' }], policy: policy(),
    });
    expect(proposal.status).toBe('ok');
    expect(proposal.observedSource).toBe('ON_DEVICE');
    expect(prompts[0]).toContain(fixture.canary); // the device model sees it; nothing else does
    // Controls: the canary really is in the output and in the proposal, so the absence checks below mean something.
    expect(JSON.stringify(proposal.data)).toContain(fixture.canary);

    const hold = new RestrictedDraftHold();
    const draft = hold.hold({ id: 'd1', sourceClassifications: ['restricted'], proposal });
    expect(draft.classification).toBe('restricted');
    const review = validateProposal(hold.get('d1')!.proposal.data, { operation: 'draftBrief', allowedRequirementIds: fixture.allowedRequirementIds, forbiddenMandatoryScope: fixture.forbiddenMandatoryScope });
    expect(review.status).toBe('valid');

    // Serializing the hold or the draft cannot leak content.
    expect(JSON.stringify(hold)).not.toContain(fixture.canary);
    expect(JSON.stringify(draft)).not.toContain('Feedback form');
    expect(JSON.stringify(draft)).not.toContain(fixture.canary);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(String(draft)).not.toContain(fixture.canary);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(setLocal).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(idbOpen).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(events.length).toBe(1);
    expect(JSON.stringify(events)).not.toContain(fixture.canary);
    expect(JSON.stringify(events)).not.toContain('Feedback form');
    expect(JSON.stringify(reclassificationRequest(draft, await draftContentSha256(draft), 'share with owner'))).not.toContain(fixture.canary);

    hold.discard('d1');
    expect(hold.get('d1')).toBeUndefined();
  });

  it('an unrestricted-looking source list cannot lower the draft label, and secret stays secret', () => {
    const hold = new RestrictedDraftHold();
    const p = { data: {} } as never;
    expect(hold.hold({ id: 'a', sourceClassifications: ['public', 'restricted'], proposal: p }).classification).toBe('restricted');
    expect(hold.hold({ id: 'b', sourceClassifications: ['restricted', 'secret'], proposal: p }).classification).toBe('secret');
    expect(() => hold.hold({ id: 'c', sourceClassifications: [], proposal: p })).toThrow();
  });
});

describe('publishing a restricted draft requires a separate permitted policy change', () => {
  const hold = new RestrictedDraftHold();
  const draft = hold.hold({ id: 'd', sourceClassifications: ['restricted'], proposal: { data: { a: 1 } } as never });
  const decision = { decision: 'allow', reason: 'administrator_authorized:modify_policy', policyVersion: 'p1', record: 'policy_decision' } as const;
  const grantFor = async (over: Partial<ReclassificationGrant> = {}): Promise<ReclassificationGrant> => ({
    grantId: 'dec_1', draftId: 'd', contentSha256: await draftContentSha256(draft), sourceClassification: 'restricted',
    targetClassification: 'internal', decision, ...over,
  });

  it('denies while the source stays restricted: no grant, wrong draft, wrong content, wrong or non-lowering target, denied decision', async () => {
    expect((await publishDraft(draft, undefined)).ok).toBe(false);
    for (const over of [
      { draftId: 'other' }, { contentSha256: 'f'.repeat(64) }, { sourceClassification: 'internal' as const },
      { targetClassification: 'restricted' as never }, { decision: { ...decision, decision: 'deny' as const } },
      { decision: { ...decision, decision: 'require_approval' as const } },
    ]) expect((await publishDraft(draft, await grantFor(over))).ok, JSON.stringify(over)).toBe(false);
  });

  it('a content change after the grant invalidates it', async () => {
    const grant = await grantFor();
    const edited = hold.hold({ id: 'd', sourceClassifications: ['restricted'], proposal: { data: { a: 2 } } as never });
    expect((await publishDraft(edited, grant)).ok).toBe(false);
    hold.hold({ id: 'd', sourceClassifications: ['restricted'], proposal: { data: { a: 1 } } as never });
  });

  it('succeeds only with a matching server grant carrying a recorded evaluate decision', async () => {
    const r = await publishDraft(draft, await grantFor());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ classification: 'internal', reclassifiedFrom: 'restricted', grantId: 'dec_1' });
      expect(r.value.decision).toMatchObject({ decision: 'allow', record: 'policy_decision' });
    }
  });

  it('never publishes a secret draft, and the request needs a real reason', async () => {
    const secret = hold.hold({ id: 's', sourceClassifications: ['secret'], proposal: { data: {} } as never });
    const g = { ...(await grantFor()), draftId: 's', contentSha256: await draftContentSha256(secret), sourceClassification: 'secret' as never };
    expect((await publishDraft(secret, g)).ok).toBe(false);
    expect(() => reclassificationRequest(draft, 'a'.repeat(64), '   ')).toThrow();
    expect(() => reclassificationRequest(secret, 'a'.repeat(64), 'why')).toThrow();
  });

  it('the request carries only the draft id, hash, labels and reason', async () => {
    const req = reclassificationRequest(draft, await draftContentSha256(draft), 'owner approved');
    expect(Object.keys(req).sort()).toEqual(['contentSha256', 'draftId', 'reason', 'sourceClassification', 'targetClassification']);
  });
});
