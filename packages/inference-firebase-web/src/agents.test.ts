import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, BrainBundleSchema, RouteRecordReportSchema, type AgentKind, type BrainBundle, type RouteRecordReport } from '@selarikru/domain';
import { FirebaseHybridAssistantAdapter, type AgentCallRequest, type CallSpec, type FetchRoute, type FreshRoute, type TelemetryEvent } from './adapter.ts';
import { AGENT_CATALOG, AgentCatalog, type AgentInputs } from './agents.ts';
import type { AssistantSdk, DeviceAvailability, ModelSpec, SdkGenerateResult, SdkModel } from './sdk.ts';

/** The only model in these tests. It records what it was given and answers with what the test set. */
class FakeSdk implements AssistantSdk {
  availabilityValue: DeviceAvailability = 'available';
  specs: ModelSpec[] = [];
  prompts: string[] = [];
  result: SdkGenerateResult = { text: '{}', inferenceSource: 'on_device' };
  async availability() { return this.availabilityValue; }
  async initializeDeviceModel() {}
  createModel(spec: ModelSpec): SdkModel {
    this.specs.push(spec);
    return { generate: async (prompt: string) => { this.prompts.push(prompt); return this.result; } };
  }
}

const GRANT = [{ destination: 'firebase-ai-logic-cloud', purpose: 'inference', classifications: ['public', 'internal'] }];
const policy = (mode = 'ONLY_ON_DEVICE') => ({ policyVersion: 'p1', preferredMode: mode, selectedSources: ['s1'], destinations: GRANT }) as never;

const BASE = 'line one\nline two\nline three\n';
const DIFF = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' line one', '-line two', '+line 2', ' line three', ''].join('\n');

const bundle = (over: Partial<BrainBundle> = {}): BrainBundle => BrainBundleSchema.parse({
  schemaVersion: 1, destination: 'cloud', taskId: 't1', compilationVersion: 3, generator: { id: 'selarikru.brain.structured', version: '1' }, watermark: 4, sourceHead: 4, indexLag: 0,
  recordsPending: false, compiledAt: '2026-11-10T10:00:00.000Z', pinned: [{ sourceId: 'brief:b1', revision: 1 }],
  claims: [{ claimId: 'c1', page: 'overview', key: 'criterion:AC-1', heading: 'Posting', text: 'CLAIM-SERVED posts are public.', status: 'current', standing: 'accepted', citations: [{ sourceId: 'brief:b1', revision: 1, anchor: 'a1' }] }],
  omissions: [{ kind: 'claim', id: 'c9', reason: 'restricted_for_destination' }, { kind: 'source', id: 'note:n2', reason: 'revoked' }],
  ...over,
});

const task = { taskId: 't1', title: 'Add posting', description: 'TASK-TEXT people post feedback.', criteria: [{ id: 'AC-1', text: 'CRITERION-TEXT a post appears.' }, { id: 'AC-2', text: 'Empty posts are refused.' }], allowedPaths: ['src'], classification: 'internal' };
const common = { projectId: 'proj-1', task, bundle: bundle(), sources: [{ id: 's1', classification: 'public' as const }], policy: policy() };
const files = [{ path: 'src/app.ts', content: BASE, classification: 'internal' }];

const INPUTS: { [K in AgentKind]: AgentInputs[K] } = {
  brief: common, criteria: common, plan: common, breakdown: common,
  patch: { ...common, files, request: 'Rename line two.' },
  review: { ...common, diff: DIFF, files },
  triage: { ...common, check: { checkId: 'unit', output: 'FAIL src/app.test.ts\nexpected 201, got 200' } },
  prDescription: { ...common, diff: DIFF },
};

const GOOD: Record<AgentKind, unknown> = {
  brief: { summary: 'Let people post feedback.', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'A post appears.' }] },
  criteria: { acceptanceCriteria: [{ requirementId: 'AC-2', text: 'Empty posts are refused.' }] },
  plan: { tasks: [{ key: 'T1', title: 'API', description: 'Add the route.', role: 'backend', requirementIds: ['AC-1'], paths: ['src/api'], dependsOn: [] }] },
  breakdown: { steps: [{ title: 'Route', detail: 'Store one post.', paths: ['src/app.ts'], criteriaIds: ['AC-1'] }] },
  patch: { summary: 'Rename line two.', diff: DIFF },
  review: { outcome: 'no_issues', summary: 'Looks right.', findings: [{ file: 'src/app.ts', line: 2, severity: 'nit', message: 'Fine.' }] },
  triage: { summary: 'Status code.', category: 'test_failure', likelyCause: 'Returns 200.', nextStep: 'Return 201.', location: { file: 'src/app.ts', line: 2 } },
  prDescription: { title: 'Add posting', body: 'Adds posting.', criteriaCovered: ['AC-1'] },
};

function setup(route: FreshRoute = { runDefault: 'ONLY_ON_DEVICE', override: null, lock: null }, opts: { nanoInputBudgetChars?: number } = {}) {
  const sdk = new FakeSdk();
  const state = { route, reads: 0 };
  const fetchRoute: FetchRoute = async () => { state.reads += 1; return state.route; };
  const events: TelemetryEvent[] = [];
  const reports: { projectId: string; taskId: string; report: RouteRecordReport }[] = [];
  const adapter = new FirebaseHybridAssistantAdapter({ sdk, fetchRoute, onTelemetry: (e) => events.push(e), ...opts });
  const calls: AgentCallRequest[] = [];
  const runAgent = adapter.runAgent.bind(adapter);
  adapter.runAgent = (spec: CallSpec, req: AgentCallRequest) => { calls.push(req); return runAgent(spec, req); };
  const catalog = new AgentCatalog(adapter, { reportRoute: async (projectId, taskId, report) => { reports.push({ projectId, taskId, report }); } });
  return { sdk, state, events, reports, calls, catalog };
}

const entry = <K extends AgentKind>(catalog: AgentCatalog, kind: K) => (catalog[kind] as (i: AgentInputs[K]) => ReturnType<AgentCatalog['run']>).bind(catalog);

describe('the catalog', () => {
  it('has one definition per step kind, each with a role prompt that asks for JSON', () => {
    expect(Object.keys(AGENT_CATALOG).sort()).toEqual([...AGENT_KINDS].sort());
    for (const k of AGENT_KINDS) {
      expect(AGENT_CATALOG[k].kind).toBe(k);
      expect(AGENT_CATALOG[k].rolePrompt).toMatch(/JSON/);
    }
  });

  for (const kind of AGENT_KINDS) {
    it(`${kind}: names its task, reads the route, validates the output and reports the route`, async () => {
      const { sdk, state, reports, calls, catalog } = setup();
      sdk.result = { text: JSON.stringify(GOOD[kind]), inferenceSource: 'on_device' };
      const r = await entry(catalog, kind)(INPUTS[kind]);
      expect(r.proposal.status).toBe('ok');
      expect(r.proposal.validation.status).toBe('passed');
      expect(r.proposal).toMatchObject({ requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', trust: 'untrusted_proposal' });
      expect(r.proposal.timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(r.proposal.route).toMatchObject({ taskId: 't1', stepKind: kind, conformance: 'conforms' });
      // Every entry point sets the route, so the fresh read always applies: once before the call and once inside the queue.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.route).toEqual({ taskId: 't1', stepKind: kind, callOverride: null });
      expect(state.reads).toBe(2);
      expect(r.report).not.toBeNull();
      expect(RouteRecordReportSchema.safeParse(r.report).success).toBe(true);
      expect(reports).toEqual([{ projectId: 'proj-1', taskId: 't1', report: r.report }]);
      expect(r.reported).toBe('sent');
    });

    it(`${kind}: an output that breaks the schema is invalid and carries no data`, async () => {
      const { sdk, catalog } = setup();
      sdk.result = { text: JSON.stringify({ unexpected: true }), inferenceSource: 'on_device' };
      const r = await entry(catalog, kind)(INPUTS[kind]);
      expect(r.proposal).toMatchObject({ status: 'invalid', data: null, validation: { status: 'failed' } });
    });
  }

  it('a failed route report does not change the proposal', async () => {
    const sdk = new FakeSdk();
    sdk.result = { text: JSON.stringify(GOOD.triage), inferenceSource: 'on_device' };
    const adapter = new FirebaseHybridAssistantAdapter({ sdk, fetchRoute: async () => ({ runDefault: 'ONLY_ON_DEVICE', override: null, lock: null }) });
    const catalog = new AgentCatalog(adapter, { reportRoute: async () => { throw new Error('offline'); } });
    const r = await catalog.triage(INPUTS.triage);
    expect(r.proposal.status).toBe('ok');
    expect(r.reported).toBe('failed');
    expect((await new AgentCatalog(adapter).triage(INPUTS.triage)).reported).toBe('not_sent');
  });
});

describe('patch proposals', () => {
  const run = async (diff: string, input = INPUTS.patch) => {
    const { sdk, catalog } = setup();
    sdk.result = { text: JSON.stringify({ summary: 's', diff }), inferenceSource: 'on_device' };
    return (await catalog.patch(input)).proposal;
  };

  it('a diff that does not apply to the given contents is refused', async () => {
    const p = await run(DIFF.replace('-line two', '-line TWO'));
    expect(p).toMatchObject({ status: 'invalid', data: null });
    expect(p.validation.errors.join(' ')).toContain('diff_does_not_apply');
  });

  it('a diff outside the allowed paths, or of a file the agent was not given, is refused', async () => {
    const outside = await run(DIFF.replaceAll('src/app.ts', 'docs/app.ts'));
    expect(outside.validation.errors.join(' ')).toContain('path_outside_allowed');
    const notGiven = await run(DIFF.replaceAll('src/app.ts', 'src/other.ts'));
    expect(notGiven.validation.errors.join(' ')).toContain('diff_file_not_provided');
    const garbage = await run('please change line two');
    expect(garbage.validation.errors.join(' ')).toContain('diff_unparseable');
  });

  it('the agent gets only file contents the task context allows; the rest is listed, never sent', async () => {
    const { sdk, catalog } = setup();
    sdk.result = { text: JSON.stringify(GOOD.patch), inferenceSource: 'on_device' };
    const r = await catalog.patch({
      ...INPUTS.patch,
      files: [
        ...files,
        { path: 'docs/notes.md', content: 'OUTSIDE-CANARY', classification: 'public' },
        { path: 'src/.env', content: 'ENVFILE-CANARY', classification: 'public' },
        { path: 'src/keys.ts', content: 'SECRETLABEL-CANARY', classification: 'secret' },
        { path: 'src/huge.ts', content: `HUGE-CANARY${'x'.repeat(30_000)}`, classification: 'public' },
      ],
    });
    const prompt = sdk.prompts[0]!;
    expect(prompt).toContain('line two');
    for (const c of ['OUTSIDE-CANARY', 'ENVFILE-CANARY', 'SECRETLABEL-CANARY', 'HUGE-CANARY']) expect(prompt).not.toContain(c);
    expect(r.omissions).toEqual(expect.arrayContaining([
      { kind: 'file', id: 'docs/notes.md', reason: 'out_of_scope' },
      { kind: 'file', id: 'src/.env', reason: 'restricted_for_destination' },
      { kind: 'file', id: 'src/keys.ts', reason: 'restricted_for_destination' },
      { kind: 'file', id: 'src/huge.ts', reason: 'too_large' },
    ]));
    expect(prompt).toContain('docs/notes.md: out_of_scope');
    expect(prompt).toContain('src/huge.ts: too_large');
    // Withheld under the data rules: counted, not named.
    expect(prompt).not.toContain('src/keys.ts');
    expect(prompt).toContain('2 files were withheld under the data rules');
  });
});

describe('context bundle and omissions', () => {
  it('builds the prompt from the served claims and lists what the bundle left out', async () => {
    const { sdk, catalog } = setup();
    sdk.result = { text: JSON.stringify(GOOD.criteria), inferenceSource: 'on_device' };
    const r = await catalog.criteria(INPUTS.criteria);
    const prompt = sdk.prompts[0]!;
    expect(prompt).toContain('CLAIM-SERVED posts are public.');
    expect(prompt).toContain('TASK-TEXT');
    expect(prompt).toContain('CRITERION-TEXT');
    expect(prompt).toContain('claim c9: restricted_for_destination');
    expect(prompt).toContain('source note:n2: revoked');
    expect(r.omissions).toEqual(expect.arrayContaining([{ kind: 'claim', id: 'c9', reason: 'restricted_for_destination' }, { kind: 'source', id: 'note:n2', reason: 'revoked' }]));
  });

  it('a bundle served for the device is refused on a cloud-capable route; one for another task, or unreadable, is refused on any route', async () => {
    const { sdk, catalog } = setup({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null });
    const cloud = { ...common, policy: policy('ONLY_IN_CLOUD') };
    expect((await catalog.brief({ ...cloud, bundle: bundle({ destination: 'local' }) })).proposal).toMatchObject({ status: 'blocked', blockedReason: 'context_bundle_not_for_cloud' });
    expect((await catalog.brief({ ...cloud, bundle: bundle({ taskId: 't2' }) })).proposal).toMatchObject({ status: 'blocked', blockedReason: 'context_bundle_task_mismatch' });
    expect((await catalog.brief({ ...cloud, bundle: { broken: true } as never })).proposal).toMatchObject({ status: 'blocked', blockedReason: 'context_bundle_unreadable' });
    expect(sdk.prompts).toHaveLength(0);
  });

  it('a device bundle is fine on a device-only route', async () => {
    const { sdk, catalog } = setup();
    sdk.result = { text: JSON.stringify(GOOD.brief), inferenceSource: 'on_device' };
    expect((await catalog.brief({ ...common, bundle: bundle({ destination: 'local' }) })).proposal.status).toBe('ok');
  });
});

describe('input size', () => {
  it('an oversized input on a device-only route is refused with input_too_large_for_device', async () => {
    const { sdk, catalog } = setup(undefined, { nanoInputBudgetChars: 500 });
    const r = await catalog.review(INPUTS.review);
    expect(r.proposal).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device' });
    expect(sdk.prompts).toHaveLength(0);
    expect(r.report).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device', requestedMode: 'ONLY_ON_DEVICE' });
  });

  it('a check output over its cap is refused, never cut', async () => {
    const { sdk, catalog } = setup({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null });
    const r = await catalog.triage({ ...INPUTS.triage, policy: policy('ONLY_IN_CLOUD'), check: { checkId: 'unit', output: 'x'.repeat(20_000) } });
    expect(r.proposal).toMatchObject({ status: 'blocked', blockedReason: 'check_output_too_large' });
    expect(sdk.prompts).toHaveLength(0);
  });
});

describe('restricted tasks', () => {
  const restricted = { ...task, classification: 'restricted', description: 'RESTRICTED-TASK-CANARY', criteria: [{ id: 'AC-1', text: 'RESTRICTED-CRITERION-CANARY' }] };
  const LOCK = { label: 'restricted', reason: 'This task reads restricted data.' };

  it('a stale cloud route never reaches the cloud: the fresh read locks it to the device', async () => {
    const { sdk, catalog } = setup({ runDefault: 'PREFER_IN_CLOUD', override: 'ONLY_IN_CLOUD', lock: LOCK });
    sdk.result = { text: JSON.stringify(GOOD.triage), inferenceSource: 'on_device' };
    const r = await catalog.triage({ ...INPUTS.triage, policy: policy('ONLY_IN_CLOUD'), callOverride: 'ONLY_IN_CLOUD' });
    expect(r.proposal.requestedMode).toBe('ONLY_ON_DEVICE');
    expect(r.locked).toBe(true);
    expect(sdk.specs.every((s) => s.mode === 'ONLY_ON_DEVICE' && !s.allowCloud)).toBe(true);
  });

  it("a restricted file in the prompt locks the call even when the server's read does not", async () => {
    const { sdk, catalog } = setup({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null });
    sdk.result = { text: JSON.stringify(GOOD.patch), inferenceSource: 'on_device' };
    const r = await catalog.patch({ ...INPUTS.patch, policy: policy('ONLY_IN_CLOUD'), bundle: bundle({ destination: 'local' }), files: [{ path: 'src/app.ts', content: BASE, classification: 'restricted' }] });
    expect(r.proposal.status).toBe('ok');
    expect(r.locked).toBe(true);
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowCloud: false });
  });

  it('no restricted text reaches the server through the route report or telemetry, whatever the outcome', async () => {
    const { sdk, events, reports, catalog } = setup({ runDefault: 'ONLY_ON_DEVICE', override: null, lock: LOCK });
    const input = { ...common, task: restricted, bundle: bundle({ destination: 'local', claims: [{ ...bundle().claims[0]!, text: 'RESTRICTED-CLAIM-CANARY' }] }) };
    sdk.result = { text: JSON.stringify({ summary: 'RESTRICTED-OUTPUT-CANARY', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'RESTRICTED-OUTPUT-CANARY' }] }), inferenceSource: 'on_device' };
    await catalog.brief(input);
    sdk.result = { text: JSON.stringify({ summary: 'RESTRICTED-OUTPUT-CANARY', acceptanceCriteria: [{ requirementId: 'NOPE', text: 'x' }] }), inferenceSource: 'on_device' };
    await catalog.brief(input);
    sdk.result = { text: JSON.stringify(GOOD.brief), inferenceSource: 'in_cloud' };
    await catalog.brief(input);
    expect(sdk.prompts[0]).toContain('RESTRICTED-CLAIM-CANARY');
    expect(reports).toHaveLength(3);
    expect(reports.map((r) => r.report.status)).toEqual(['ok', 'invalid', 'route_violation']);
    const sent = JSON.stringify([reports, events]);
    for (const c of ['RESTRICTED-TASK-CANARY', 'RESTRICTED-CRITERION-CANARY', 'RESTRICTED-CLAIM-CANARY', 'RESTRICTED-OUTPUT-CANARY', 'NOPE', 'Add posting']) expect(sent).not.toContain(c);
    for (const r of reports) expect(RouteRecordReportSchema.safeParse(r.report).success).toBe(true);
  });
});

describe('PR descriptions', () => {
  it('read the diff summary, not the code', async () => {
    const { sdk, catalog } = setup();
    sdk.result = { text: JSON.stringify(GOOD.prDescription), inferenceSource: 'on_device' };
    await catalog.prDescription(INPUTS.prDescription);
    expect(sdk.prompts[0]).toContain('modify src/app.ts (+1 -1)');
    expect(sdk.prompts[0]).not.toContain('line two');
  });
});
