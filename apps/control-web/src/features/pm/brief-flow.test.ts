import { describe, expect, it } from 'vitest';
import { createMockDataSource, createSeededClock, demoPlanBriefNotes, fixtureTime, scoped } from '@selarikru/data-source-mock';
import type { AssistantSdk, ModelSpec } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import { createAgents } from '../hybrid/agents.ts';
import { createDemoSdk } from '../hybrid/demo-sdk.ts';
import { approveBrief, briefFromOutput, briefInCount, briefPayload, briefSha256, completeness, editItem, emptyBrief, addItem, planBriefFor, screenCheck, toggleItem } from './brief.ts';

/**
 * H13 end to end on demo data, with the real adapter and agents port: points and questions are formatted on this device, reviewed, approved, checked in the
 * cloud, and the plan is made from the brief. A recording SDK wraps the demo one, so every model the adapter makes (its mode, cloud allowed, grounding) and every
 * prompt is seen.
 */
const id = (local: string) => scoped('feature-delivery', local);
const CANARY = 'CANARY-H13-NOT-IN-THE-CHECK-7f3a';

function recording(base: AssistantSdk, over: { availability?: 'available' | 'unavailable' } = {}) {
  const specs: ModelSpec[] = [];
  const prompts: { mode: string; prompt: string }[] = [];
  const sdk: AssistantSdk = {
    availability: async () => over.availability ?? base.availability(),
    initializeDeviceModel: (p) => base.initializeDeviceModel(p),
    createModel(spec) {
      specs.push(spec);
      const m = base.createModel(spec);
      return { generate: async (prompt: string) => { prompts.push({ mode: spec.mode, prompt }); return m.generate(prompt); } };
    },
  };
  return { sdk, specs, prompts };
}

async function setup(opts: { availability?: 'available' | 'unavailable'; webResearch?: boolean } = {}) {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const projectId = 'demo-feature-delivery';
  const base = await ds.getSnapshot(projectId);
  const runId = base.tasks[id('contract')]!.runId;
  const snapshot: ProjectViewSnapshot = opts.webResearch === false ? base : { ...base, settings: [...base.settings, { scope: 'run', key: runId, field: 'web_research', desired: true } as never] };
  const rec = recording(createDemoSdk(), opts);
  const agents = createAgents({ projectId, source: ds, sdk: rec.sdk, simulated: true, execute: (c) => ds.execute(c), snapshot: () => snapshot })!;
  return { ds, agents, rec, projectId, runId, snapshot };
}

describe('the plan brief on demo data (H13)', () => {
  it('the demo fixture has sample notes, so the flow works straight away', () => {
    const n = demoPlanBriefNotes('demo-feature-delivery');
    expect(n).not.toBeNull();
    expect(briefInCount(n!.points, n!.unsure).points).toBeGreaterThanOrEqual(3);
    expect(briefInCount(n!.points, n!.unsure).unsure).toBeGreaterThanOrEqual(1);
    expect(demoPlanBriefNotes('some-other-project')).toBeNull();
  });

  it('notes → format on this device → edit one, untick one → approve → check in the cloud → make the plan, with its architecture → accept', async () => {
    const { ds, agents, rec, projectId } = await setup();
    const notes = demoPlanBriefNotes(projectId)!;
    const subject = id('contract');
    // Format: device only, even on this cloud-routed task.
    const formatted = await agents.pm({ kind: 'pmBrief', subjectTaskId: subject, question: '', questionClassification: 'internal', history: [], callOverride: null, notes });
    expect(formatted.kind).toBe('result');
    if (formatted.kind !== 'result') return;
    expect(formatted.result.proposal).toMatchObject({ status: 'ok', observedSource: 'ON_DEVICE', requestedMode: 'ONLY_ON_DEVICE' });
    expect(rec.specs.at(-1)).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowCloud: false });
    let d = briefFromOutput(formatted.result.proposal.data, 'internal', briefInCount(notes.points, notes.unsure));
    expect(completeness(d).ok).toBe(true);
    // Review: edit one, untick one, approve.
    const edited = editItem(d, d.items[0]!.id, 'Posts are listed newest first, 20 to a page.');
    expect('draft' in edited).toBe(true);
    if (!('draft' in edited)) return;
    d = approveBrief(toggleItem(edited.draft, d.items[1]!.id));
    const payload = briefPayload(d);
    // Check: cloud only with Google Search; only the ticked brief.
    const checked = await agents.pm({ kind: 'pmVerify', subjectTaskId: subject, question: '', questionClassification: 'internal', history: [], callOverride: null, brief: payload, briefSha256: briefSha256(payload) });
    expect(checked.kind === 'result' && checked.result.proposal).toMatchObject({ status: 'ok', observedSource: 'IN_CLOUD', requestedMode: 'ONLY_IN_CLOUD' });
    expect(rec.specs.at(-1)).toMatchObject({ mode: 'ONLY_IN_CLOUD', grounding: 'googleSearch' });
    const checkPrompt = rec.prompts.at(-1)!.prompt;
    expect(checkPrompt).toContain('Posts are listed newest first, 20 to a page.');
    expect(checkPrompt).not.toContain(d.items[1]!.text);
    if (checked.kind !== 'result') return;
    const result = screenCheck('pmVerify', checked.result.proposal.data);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((x) => x.sources.every((s) => s.url.startsWith('https://')))).toBe(true);
    // Make the plan from this brief: the brief, verdicts and answers are in the prompt, and the plan has an architecture section.
    const plan = await agents.pm({ kind: 'pmPlan', subjectTaskId: subject, question: 'Make the plan from this brief.', questionClassification: 'internal', history: [], callOverride: null, planBrief: planBriefFor(d, result) });
    expect(plan.kind).toBe('result');
    if (plan.kind !== 'result') return;
    expect(rec.prompts.at(-1)!.prompt).toContain('# Approved plan brief, checked in the cloud (from web research)');
    const data = plan.result.proposal.data as { tasks: unknown[]; architecture?: string };
    expect(plan.result.proposal.status).toBe('ok');
    expect(data.architecture).toMatch(/Demo architecture/);
    // Accept plan works as today, bound by the hash that covers the architecture.
    const accepted = await ds.acceptPmPlan!(projectId, plan.runId, { expectedPlanRevision: plan.planRevision ?? 0, subjectTaskId: subject, routeRecordId: plan.result.report!.requestId, plan: data as never, idempotencyKey: 'k-h13' });
    expect(accepted.planRevision).toBe((plan.planRevision ?? 0) + 1);
  });

  it('canary: notes, history and task context never reach the check\'s prompt; only the approved brief does', async () => {
    const { agents, rec } = await setup();
    const d = approveBrief(briefFromOutput({ goal: 'A board.', items: [{ id: 'P1', text: 'Boards sort by votes.', kind: 'fact', checkable: true, source: 'points' }], uncertainties: [], omitted: [] }, 'internal', { points: 1, unsure: 0 }));
    const p = briefPayload(d);
    await agents.pm({
      kind: 'pmVerify', subjectTaskId: id('contract'), question: `${CANARY} question`, questionClassification: 'internal', callOverride: null, brief: p, briefSha256: briefSha256(p),
      history: [{ who: 'owner', text: `${CANARY} history`, classification: 'internal' }], notes: { points: `${CANARY} notes`, unsure: '' },
    });
    const prompt = rec.prompts.at(-1)!.prompt;
    expect(prompt).toContain('Boards sort by votes.');
    expect(prompt).not.toContain(CANARY);
    for (const t of ['Title:', '# Task', '# Project context', '# Conversation']) expect(prompt).not.toContain(t);
  });

  it('with Nano unavailable there is no cloud call; the owner writes the brief by hand and it can be checked', async () => {
    const { agents, rec } = await setup({ availability: 'unavailable' });
    const notes = { points: 'Posts are public.', unsure: 'Moderation?' };
    const out = await agents.pm({ kind: 'pmBrief', subjectTaskId: id('contract'), question: '', questionClassification: 'internal', history: [], callOverride: null, notes });
    expect(out.kind === 'result' && out.result.proposal).toMatchObject({ status: 'blocked', blockedReason: 'device_unavailable' });
    expect(rec.specs).toHaveLength(0);
    // By hand.
    const one = addItem(emptyBrief('internal', briefInCount(notes.points, notes.unsure)), 'Posts are public.', 'requirement');
    expect('draft' in one).toBe(true);
    if (!('draft' in one)) return;
    const d = approveBrief(one.draft);
    const p = briefPayload(d);
    const checked = await agents.pm({ kind: 'pmVerifyNoWeb', subjectTaskId: id('contract'), question: '', questionClassification: 'internal', history: [], callOverride: null, brief: p, briefSha256: briefSha256(p) });
    expect(checked.kind === 'result' && checked.result.proposal.status).toBe('ok');
    expect(rec.specs).toHaveLength(1);
    expect(rec.specs[0]).toMatchObject({ mode: 'ONLY_IN_CLOUD' });
    expect(rec.specs[0]).not.toHaveProperty('grounding');
    expect(checked.kind === 'result' && screenCheck('pmVerifyNoWeb', checked.result.proposal.data).checked).toBe('no_web');
  });

  it('restricted notes, a locked subject or a device-only subject: no check, no cloud call', async () => {
    const { agents, rec, snapshot } = await setup();
    const d = approveBrief(briefFromOutput({ goal: 'g', items: [{ id: 'P1', text: 'x', kind: 'fact', checkable: true, source: 'points' }], uncertainties: [], omitted: [] }, 'internal', { points: 1, unsure: 0 }));
    const p = briefPayload(d);
    const ask = (subjectTaskId: string, questionClassification: 'internal' | 'restricted' = 'internal') => agents.pm({ kind: 'pmVerify', subjectTaskId, question: '', questionClassification, history: [], callOverride: null, brief: p, briefSha256: briefSha256(p) });
    expect(await ask(id('contract'), 'restricted')).toMatchObject({ kind: 'refused', code: 'brief_restricted' });
    const locked = Object.values(snapshot.tasks).find((t) => t.route?.lock)!;
    expect(await ask(locked.taskId)).toMatchObject({ kind: 'refused', code: 'research_locked' });
    const deviceOnly = Object.values(snapshot.tasks).find((t) => t.route && !t.route.lock && t.route.effective === 'ONLY_ON_DEVICE')!;
    expect(await ask(deviceOnly.taskId)).toMatchObject({ kind: 'refused', code: 'research_device_only' });
    expect(rec.specs).toHaveLength(0);
  });

  it('with web research off the check with Google Search is refused with the message; the no-web check still runs', async () => {
    const { agents, rec } = await setup({ webResearch: false });
    const d = approveBrief(briefFromOutput({ goal: 'g', items: [{ id: 'P1', text: 'x', kind: 'fact', checkable: true, source: 'points' }], uncertainties: [], omitted: [] }, 'internal', { points: 1, unsure: 0 }));
    const p = briefPayload(d);
    expect(await agents.pm({ kind: 'pmVerify', subjectTaskId: id('contract'), question: '', questionClassification: 'internal', history: [], callOverride: null, brief: p, briefSha256: briefSha256(p) })).toMatchObject({ kind: 'refused', code: 'research_not_granted' });
    expect(rec.specs).toHaveLength(0);
  });
});
