import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProposal } from '@selarikru/domain';
import { FirebaseHybridAssistantAdapter, type TelemetryEvent } from './adapter.ts';
import fixtureJson from '../../../fixtures/assistant/restricted-brief.json' with { type: 'json' };
import { RestrictedDraftHold, publishDraft } from './restricted.ts';
import type { AssistantSdk, SdkModel } from './sdk.ts';

const fixture = fixtureJson as {
  classification: string; canary: string; taskText: string; allowedRequirementIds: string[]; forbiddenMandatoryScope: string[];
};
const OUT = JSON.stringify({ summary: 'Feedback form.', acceptanceCriteria: [{ requirementId: 'FB-01', text: 'Title is 3 to 120 code points.' }] });

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
    const adapter = new FirebaseHybridAssistantAdapter({ sdk, onTelemetry: (e) => events.push(e) });
    const proposal = await adapter.draftBrief({
      projectId: 'p', taskText: fixture.taskText, allowedRequirementIds: fixture.allowedRequirementIds,
      sources: [{ id: 's1', classification: 'restricted' }], policy: policy(),
    });
    expect(proposal.status).toBe('ok');
    expect(proposal.observedSource).toBe('ON_DEVICE');
    expect(prompts[0]).toContain(fixture.canary); // the device model sees it; nothing else does

    const hold = new RestrictedDraftHold();
    const draft = hold.hold({ id: 'd1', sourceClassifications: ['restricted'], proposal });
    expect(draft.classification).toBe('restricted');
    const review = validateProposal(hold.get('d1')!.proposal.data, { operation: 'draftBrief', allowedRequirementIds: fixture.allowedRequirementIds, forbiddenMandatoryScope: fixture.forbiddenMandatoryScope });
    expect(review.status).toBe('valid');

    // Serializing the hold or the draft cannot leak content.
    expect(JSON.stringify(hold)).not.toContain(fixture.canary);
    expect(JSON.stringify(draft)).not.toContain('Feedback form');
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
  const draft = hold.hold({ id: 'd', sourceClassifications: ['restricted'], proposal: { data: {} } as never });
  const admin = { actor: 'administrator' as const, targetClassification: 'internal' as const, reason: 'owner approved sharing' };

  it('denies while the source stays restricted, whatever the policy says', () => {
    const allow = policy({ operations: { modify_policy: 'allow' } });
    expect(publishDraft(draft, allow).ok).toBe(false);
    expect(publishDraft(draft, undefined, admin).ok).toBe(false);
    expect(publishDraft(draft, policy(), admin).ok).toBe(false); // modify_policy not configured
    expect(publishDraft(draft, policy({ operations: { modify_policy: 'deny' } }), admin).ok).toBe(false);
    expect(publishDraft(draft, allow, { ...admin, actor: 'agent' }).ok).toBe(false);
    expect(publishDraft(draft, allow, { ...admin, targetClassification: 'restricted' as never }).ok).toBe(false);
  });

  it('succeeds only on an explicit reclassification under evaluate, with a recorded decision', () => {
    const allow = policy({ operations: { modify_policy: 'allow' } });
    const r = publishDraft(draft, allow, admin);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.classification).toBe('internal');
      expect(r.value.reclassifiedFrom).toBe('restricted');
      expect(r.value.decision).toMatchObject({ decision: 'allow', record: 'policy_decision', policyVersion: 'p1' });
    }
  });

  it('never publishes a secret draft', () => {
    const secret = hold.hold({ id: 's', sourceClassifications: ['secret'], proposal: { data: {} } as never });
    expect(publishDraft(secret, policy({ operations: { modify_policy: 'allow' } }), admin).ok).toBe(false);
  });
});
