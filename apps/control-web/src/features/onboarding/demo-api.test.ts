import { describe, expect, it } from 'vitest';
import { createDemoOnboardingApi } from './demo-api.ts';

const envelope = (data: unknown, status = 'ok', operation = 'draftBrief') => ({ envelope: { operation, status, data } });
const GOOD = { summary: 'A board for feedback.', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'A post appears on the board.' }] };

describe('the demo onboarding API', () => {
  it('under ?demo the assistant is off: a review is refused', async () => {
    expect(await createDemoOnboardingApi().reviewAssist(envelope(GOOD))).toMatchObject({ ok: false, code: 'demo_data' });
  });

  it('H9, hosted demo: the guide\'s real model answer is checked here with the server\'s own rule (no control API), and a bad one is refused', async () => {
    const api = createDemoOnboardingApi({ reviewLocally: true });
    expect(await api.reviewAssist(envelope(GOOD))).toEqual({ ok: true, value: { status: 'valid', summary: 'A board for feedback.', acceptanceCriteria: [{ id: 'AC-1', text: 'A post appears on the board.' }], issues: [] } });
    expect(await api.reviewAssist(envelope(GOOD, 'blocked'))).toMatchObject({ ok: false, code: 'proposal_not_acceptable' });
    expect(await api.reviewAssist(envelope({ summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-99', text: 'Not a known id.' }] }))).toMatchObject({ ok: false, code: 'proposal_rejected' });
    expect(await api.reviewAssist({ ...envelope(GOOD), restricted: true })).toMatchObject({ ok: false, code: 'restricted_stays_on_device' });
    expect(await api.reviewAssist(envelope({ ...GOOD, summary: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789' }))).toMatchObject({ ok: false, code: 'proposal_rejected' });
  });
});
