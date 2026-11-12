import { describe, expect, it, vi } from 'vitest';
import { FirebaseHybridAssistantAdapter, errorCodeOf, routeReportOf, type AssistRequest, type FetchRoute, type FreshRoute, type TelemetryEvent } from './adapter.ts';
import { RouteRecordReportSchema } from '@selarikru/domain';
import { AIError, AIErrorCode } from 'firebase/ai';
import type { AssistantSdk, DeviceAvailability, ModelSpec, SdkGenerateResult, SdkModel } from './sdk.ts';

/**
 * H9 fix round 3: SDK errors built exactly as @firebase/ai 3.0.0 builds them (dist/esm/index.esm.js, makeRequest): a non-OK HTTP response is an AIError
 * `fetch-error` carrying customErrorData.status; a fetch that never got a response is wrapped as an AIError `error` whose message ends with the fetch failure's.
 */
const URL_ = 'https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent';
const httpError = (status: number, statusText: string) => new AIError(AIErrorCode.FETCH_ERROR, `Error fetching from ${URL_}: [${status} ${statusText}] Resource exhausted`, { status, statusText });
const networkError = (fetchMessage = 'Failed to fetch') => new AIError(AIErrorCode.ERROR, `Error fetching from ${URL_}: ${new TypeError(fetchMessage).message}`);

const GOOD = JSON.stringify({ summary: 'Add a board.', acceptanceCriteria: [{ requirementId: 'FB-01', text: 'Shows posts.' }] });

class FakeSdk implements AssistantSdk {
  availabilityValue: DeviceAvailability = 'available';
  specs: ModelSpec[] = [];
  prompts: string[] = [];
  generateCalls = 0;
  initCalls = 0;
  result: SdkGenerateResult = { text: GOOD, inferenceSource: 'on_device' };
  /** When set, every generate waits on it after it has started: lets a test hold the queue. */
  gate: Promise<void> | null = null;
  entered = 0;
  async availability() {
    return this.availabilityValue;
  }
  async initializeDeviceModel(onProgress: (f: number) => void) {
    this.initCalls++;
    onProgress(0.5);
    onProgress(1);
    this.availabilityValue = 'available';
  }
  createModel(spec: ModelSpec): SdkModel {
    this.specs.push(spec);
    return {
      generate: async (prompt: string) => {
        this.entered++;
        if (this.gate) await this.gate;
        this.generateCalls++;
        this.prompts.push(prompt);
        return this.result;
      },
    };
  }
}

const GRANT = [{ destination: 'firebase-ai-logic-cloud', purpose: 'inference', classifications: ['public'] }];
const cloud = (mode: string) => policy({ preferredMode: mode, destinations: GRANT });
const policy = (over: Record<string, unknown> = {}) =>
  ({
    policyVersion: 'p1',
    preferredMode: 'ONLY_ON_DEVICE',
    selectedSources: ['s1'],
    destinations: [],
    ...over,
  }) as never;

/** What the server says now. Tests set it per call; a test that routes nothing never reaches it. */
const fresh = { route: null as FreshRoute | null, fail: false, calls: 0 };
const fetchRoute: FetchRoute = async () => {
  fresh.calls += 1;
  if (fresh.fail || fresh.route === null) throw new Error('network');
  return fresh.route;
};

function make(sdk = new FakeSdk(), events: TelemetryEvent[] = [], extra: { nanoInputBudgetChars?: number; isOnline?: () => boolean; onNetworkFailure?: () => void; onNetworkSuccess?: () => void; cloudCalls?: { allowed(): boolean; reserve(): boolean; refund(): void } } = {}) {
  let t = 0;
  fresh.route = null;
  fresh.fail = false;
  fresh.calls = 0;
  const adapter = new FirebaseHybridAssistantAdapter({
    sdk,
    fetchRoute,
    now: () => (t += 10),
    newRequestId: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
    onTelemetry: (e) => events.push(e),
    ...extra,
  });
  return { adapter, sdk, events };
}

const req = (over: Partial<AssistRequest> = {}): AssistRequest => ({
  projectId: 'proj-1',
  taskText: 'SECRET-PROMPT-BODY: board for feedback',
  allowedRequirementIds: ['FB-01', 'FB-02'],
  sources: [{ id: 's1', classification: 'public' }],
  policy: policy(),
  ...over,
});

describe('observed source', () => {
  it('comes only from the response, keeping the raw value', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD') }));
    expect(p.requestedMode).toBe('ONLY_IN_CLOUD');
    expect(p.observedSource).toBe('IN_CLOUD');
    expect(p.rawInferenceSource).toBe('in_cloud');
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    const q = await adapter.draftBrief(req());
    expect(q.observedSource).toBe('ON_DEVICE');
    expect(q.rawInferenceSource).toBe('on_device');
  });

  it('absent or unrecognized source becomes UNKNOWN', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD };
    const a = await adapter.draftBrief(req());
    expect(a.observedSource).toBe('UNKNOWN');
    expect(a.rawInferenceSource).toBeNull();
    sdk.result = { text: GOOD, inferenceSource: 'martian' };
    const b = await adapter.draftBrief(req());
    expect(b.observedSource).toBe('UNKNOWN');
    expect(b.rawInferenceSource).toBe('martian');
  });

  it('a cloud response under a no-fallback device policy is a route violation with no data', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const p = await adapter.draftBrief(req());
    expect(p.status).toBe('route_violation');
    expect(p.data).toBeNull();
    expect(p.observedSource).toBe('IN_CLOUD');
  });
});

describe('model instances', () => {
  it('are distinct per policy mode and per schema, and reused for identical keys', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    await adapter.draftBrief(req());
    await adapter.draftBrief(req());
    expect(sdk.specs).toHaveLength(1);
    await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD') }));
    expect(sdk.specs.map((s) => s.mode)).toEqual(['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD']);
    await adapter.suggestCriteria(req());
    expect(sdk.specs).toHaveLength(3);
    expect(sdk.specs[2]?.schema).not.toEqual(sdk.specs[0]?.schema);
    await adapter.draftBrief(req({ allowedRequirementIds: ['FB-03'] }));
    expect(sdk.specs).toHaveLength(4);
  });

  it('narrow the requirementId enum to the allowed IDs without mutating the shared schema', async () => {
    const { adapter, sdk } = make();
    await adapter.draftBrief(req());
    const items = (sdk.specs[0]!.schema as any).properties.acceptanceCriteria.items.properties.requirementId;
    expect(items.enum).toEqual(['FB-01', 'FB-02']);
    await adapter.draftBrief(req({ allowedRequirementIds: ['FB-09'] }));
    const second = (sdk.specs[1]!.schema as any).properties.acceptanceCriteria.items.properties.requirementId;
    expect(second.enum).toEqual(['FB-09']);
    expect(items.enum).toEqual(['FB-01', 'FB-02']);
  });
});

describe('device-only blocking', () => {
  for (const state of ['unavailable', 'downloadable', 'downloading'] as const) {
    it(`device-only while ${state} -> Blocked with zero SDK calls`, async () => {
      const { adapter, sdk } = make();
      sdk.availabilityValue = state;
      const p = await adapter.draftBrief(req());
      expect(p.status).toBe('blocked');
      expect(p.data).toBeNull();
      expect(p.blockedReason).toBe(`device_${state}`);
      expect(sdk.generateCalls).toBe(0);
      expect(sdk.specs).toHaveLength(0);
    });
  }

  it('device-only while evicted (was available, now downloadable) -> Blocked with zero calls', async () => {
    const { adapter, sdk } = make();
    await adapter.draftBrief(req());
    expect(sdk.generateCalls).toBe(1);
    sdk.availabilityValue = 'downloadable';
    const p = await adapter.draftBrief(req());
    expect(p.status).toBe('blocked');
    expect(p.blockedReason).toBe('device_evicted');
    expect(sdk.generateCalls).toBe(1);
  });

  it('PREFER_ON_DEVICE without approved fallback is blocked when the device is not ready', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'unavailable';
    const p = await adapter.draftBrief(req({ policy: policy({ preferredMode: 'PREFER_ON_DEVICE' }) }));
    expect(p.status).toBe('blocked');
    expect(sdk.generateCalls).toBe(0);
  });

  it('a policy Blocked result makes no SDK call', async () => {
    const { adapter, sdk } = make();
    const p = await adapter.draftBrief(req({ policy: undefined }));
    expect(p.status).toBe('blocked');
    expect(p.blockedReason).toBe('missing_policy');
    expect(p.requestedMode).toBeNull();
    expect(sdk.generateCalls).toBe(0);
    expect(sdk.specs).toHaveLength(0);
    expect(sdk.prompts).toHaveLength(0);
  });

  it('restricted sources are forced to device-only and blocked when the device is not ready', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'downloadable';
    const p = await adapter.draftBrief(
      req({ sources: [{ id: 's1', classification: 'restricted' }], policy: cloud('ONLY_IN_CLOUD') }),
    );
    expect(p.status).toBe('blocked');
    expect(sdk.generateCalls).toBe(0);
  });
});

describe('device-only enforced at the SDK boundary', () => {
  it('PREFER_ON_DEVICE without approved fallback builds an ONLY_ON_DEVICE model with cloud disallowed', async () => {
    const { adapter, sdk } = make();
    const p = await adapter.draftBrief(req({ policy: policy({ preferredMode: 'PREFER_ON_DEVICE' }) }));
    expect(p.requestedMode).toBe('PREFER_ON_DEVICE');
    expect(sdk.specs).toHaveLength(1);
    expect(sdk.specs[0]?.mode).toBe('ONLY_ON_DEVICE');
    expect(sdk.specs[0]?.allowCloud).toBe(false);
  });

  it('ONLY_ON_DEVICE disallows cloud; approved PREFER_ON_DEVICE and cloud modes allow it; instances differ', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    await adapter.draftBrief(req());
    await adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE') }));
    await adapter.draftBrief(req({ policy: policy({ preferredMode: 'PREFER_ON_DEVICE' }) }));
    expect(sdk.specs.map((s) => [s.mode, s.allowCloud])).toEqual([
      ['ONLY_ON_DEVICE', false],
      ['PREFER_ON_DEVICE', true],
    ]);
    // the no-fallback PREFER_ON_DEVICE request reuses the device-only instance
  });

  for (const src of [undefined, 'martian'] as const) {
    it(`device-only with source ${src ?? 'absent'} withholds data as unverified`, async () => {
      const { adapter, sdk } = make();
      sdk.result = { text: GOOD, inferenceSource: src };
      const p = await adapter.draftBrief(req());
      expect(p.status).toBe('unverified_source');
      expect(p.data).toBeNull();
      expect(p.observedSource).toBe('UNKNOWN');
    });
  }
});

describe('PREFER_ON_DEVICE fallback', () => {
  const approved = () =>
    policy({
      preferredMode: 'PREFER_ON_DEVICE',
      destinations: [
        { destination: 'firebase-ai-logic-cloud', purpose: 'inference', classifications: ['public'] },
      ],
    });

  it('falls back only when policy allows it and records the observed source', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'unavailable';
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const p = await adapter.draftBrief(req({ policy: approved() }));
    if (p.status === 'blocked') throw new Error(`policy fixture did not allow fallback: ${p.blockedReason}`);
    expect(p.status).toBe('ok');
    expect(p.requestedMode).toBe('PREFER_ON_DEVICE');
    expect(p.observedSource).toBe('IN_CLOUD');
    expect(sdk.generateCalls).toBe(1);
  });

  it('stays on device when available and records ON_DEVICE', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    const p = await adapter.draftBrief(req({ policy: approved() }));
    expect(p.observedSource).toBe('ON_DEVICE');
  });
});

describe('prompt, hash, validation, usage, timing', () => {
  it('composes task text then allowed IDs and hashes the exact UTF-8 payload', async () => {
    const { adapter, sdk } = make();
    const p = await adapter.draftBrief(req({ taskText: 'Ünï board' }));
    expect(sdk.prompts[0]).toBe(
      'Ünï board\n\nAllowed requirement IDs: FB-01, FB-02. Use only these IDs. Several criteria may share one ID.',
    );
    const payload = sdk.specs[0]!.systemInstruction + '\n\n' + sdk.prompts[0];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(p.payloadSha256).toBe(hex);
  });

  it('validates against the request schema with Ajv and exposes data for later semantic checks', async () => {
    const { adapter, sdk } = make();
    const ok = await adapter.draftBrief(req());
    expect(ok.validation).toEqual({ status: 'passed', errors: [] });
    expect(ok.allowedRequirementIds).toEqual(['FB-01', 'FB-02']);
    expect(ok.data).toEqual(JSON.parse(GOOD));
    sdk.result = {
      text: JSON.stringify({ summary: 'x', acceptanceCriteria: [{ requirementId: 'FB-99', text: 't' }] }),
      inferenceSource: 'on_device',
    };
    const bad = await adapter.draftBrief(req());
    expect(bad.validation.status).toBe('failed');
    expect(bad.validation.errors.length).toBeGreaterThan(0);
    expect(bad.status).toBe('invalid');
    sdk.result = { text: 'not json', inferenceSource: 'on_device' };
    const junk = await adapter.draftBrief(req());
    expect(junk.validation.status).toBe('failed');
    expect(junk.data).toBeNull();
  });

  it('reports usage only where the SDK supplies it, otherwise unavailable (never zero)', async () => {
    const { adapter, sdk } = make();
    const none = await adapter.draftBrief(req());
    expect(none.usage).toEqual({ status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null });
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud', usage: { inputTokens: 12, outputTokens: 30 } };
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD') }));
    expect(p.usage).toEqual({ status: 'observed', inputTokens: 12, outputTokens: 30, totalTokens: null });
  });

  it('times with the monotonic clock and leaves first-output null without streaming', async () => {
    const { adapter } = make();
    const p = await adapter.draftBrief(req());
    expect(p.timing.totalMs).toBeGreaterThan(0);
    expect(p.timing.firstOutputMs).toBeNull();
  });

  it('draftTaskPlan validates its own schema and model metadata is pinned', async () => {
    const { adapter, sdk } = make();
    sdk.result = {
      text: JSON.stringify({ tasks: [{ title: 'Do', description: 'It', requirementIds: ['FB-02'], role: 'frontend' }] }),
      inferenceSource: 'on_device',
    };
    const p = await adapter.draftTaskPlan(req());
    expect(p.status).toBe('ok');
    expect(p.model).toEqual({ cloudModel: 'gemini-3.5-flash-lite', sdkVersion: '13.1.0' });
    expect(p.trust).toBe('untrusted_proposal');
  });

  it.each([[undefined], ['admin']])('a drafted task whose role is %s fails the schema', async (role) => {
    const { adapter, sdk } = make();
    sdk.result = { text: JSON.stringify({ tasks: [{ title: 'Do', description: 'It', requirementIds: ['FB-02'], ...(role ? { role } : {}) }] }), inferenceSource: 'on_device' };
    expect((await adapter.draftTaskPlan(req())).status).toBe('invalid');
  });

  it('serialises generation (one device generation at a time)', async () => {
    const { adapter, sdk } = make();
    let active = 0;
    let max = 0;
    const orig = sdk.createModel.bind(sdk);
    sdk.createModel = (spec) => {
      const m = orig(spec);
      return {
        generate: async (p) => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 5));
          const r = await m.generate(p);
          active--;
          return r;
        },
      };
    };
    await Promise.all([adapter.draftBrief(req()), adapter.draftBrief(req())]);
    expect(max).toBe(1);
  });
});

describe('readiness and download', () => {
  it('reports device readiness and cloud config separately from generation', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'downloadable';
    const r = await adapter.getReadiness();
    expect(r.device).toBe('downloadable');
    expect(r.cloudModel).toBe('gemini-3.5-flash-lite');
    expect(sdk.generateCalls).toBe(0);
  });

  it('downloadModel forwards progress, and marks downloading meanwhile', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'downloadable';
    const seen: number[] = [];
    const states: string[] = [];
    const orig = sdk.initializeDeviceModel.bind(sdk);
    sdk.initializeDeviceModel = async (cb) => {
      states.push((await adapter.getReadiness()).device);
      await orig(cb);
    };
    await adapter.downloadModel((f) => seen.push(f));
    expect(seen).toEqual([0.5, 1]);
    expect(states).toEqual(['downloading']);
    expect((await adapter.getReadiness()).device).toBe('available');
  });

  it('an SDK error keeps its stable code and never its message', async () => {
    const failing = class extends FakeSdk {
      override createModel(spec: ModelSpec): SdkModel {
        this.specs.push(spec);
        return { generate: async () => { throw Object.assign(new Error('prompt text may be quoted here'), { name: 'FirebaseError', code: 'AI/api-not-enabled' }); } };
      }
    };
    const { adapter } = make(new failing());
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD') }));
    expect(p).toMatchObject({ status: 'error', errorName: 'FirebaseError', errorCode: 'AI/api-not-enabled' });
    expect(JSON.stringify(p)).not.toContain('prompt text');
  });

  it('errorCodeOf accepts only a plain code string', () => {
    expect(errorCodeOf({ code: 'auth/network-request-failed' })).toBe('auth/network-request-failed');
    expect(errorCodeOf({ code: 'has spaces and prompt text' })).toBeNull();
    expect(errorCodeOf({ code: 42 })).toBeNull();
    expect(errorCodeOf(new Error('x'))).toBeNull();
  });

  it('a failed download surfaces the error and leaves readiness re-read from the SDK', async () => {
    const { adapter, sdk } = make();
    sdk.availabilityValue = 'downloadable';
    sdk.initializeDeviceModel = async () => {
      throw new Error('no gesture');
    };
    await expect(adapter.downloadModel(() => {})).rejects.toThrow('no gesture');
    expect((await adapter.getReadiness()).device).toBe('downloadable');
  });
});

describe('telemetry', () => {
  it('never carries the prompt or output, and the event type cannot', async () => {
    const events: TelemetryEvent[] = [];
    const { adapter, sdk } = make(new FakeSdk(), events);
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    await adapter.draftBrief(req());
    sdk.availabilityValue = 'unavailable';
    await adapter.draftBrief(req());
    expect(events).toHaveLength(2);
    const allowed = new Set([
      'kind', 'requestId', 'operation', 'requestedMode', 'observedSource', 'status', 'totalMs', 'payloadSha256', 'blockedReason', 'validationStatus', 'routed', 'restricted',
    ]);
    // H9 fix round 1 (I1): whether the call named a task (its route record lists it) and whether it read restricted data, for the tab's AI calls view.
    expect(events[0]).toMatchObject({ routed: false, restricted: false });
    for (const e of events) {
      for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true);
      const s = JSON.stringify(e);
      expect(s).not.toContain('SECRET-PROMPT-BODY');
      expect(s).not.toContain('Shows posts');
    }
    // @ts-expect-error telemetry events structurally cannot carry a prompt
    const _a: TelemetryEvent = { ...events[0]!, prompt: 'x' };
    // @ts-expect-error nor model output
    const _b: TelemetryEvent = { ...events[0]!, output: 'x' };
    void _a;
    void _b;
  });
});

describe('H9 fix round 1 (I1): telemetry says whether a call was a task step and whether it read restricted data', () => {
  it('a restricted source marks it restricted; a route marks it a task step', async () => {
    const events: TelemetryEvent[] = [];
    const { adapter } = make(new FakeSdk(), events);
    await adapter.draftBrief(req({ sources: [{ id: 's1', classification: 'restricted' }] }));
    expect(events.at(-1)).toMatchObject({ routed: false, restricted: true });
    fresh.route = { runDefault: 'ONLY_ON_DEVICE', override: null, lock: null };
    await adapter.draftBrief(req({ route: { taskId: 't1', stepKind: 'brief' } }));
    expect(events.at(-1)).toMatchObject({ routed: true });
  });
});

describe('project change', () => {
  it('clears model instances and task-local state', async () => {
    const { adapter, sdk } = make();
    await adapter.draftBrief(req());
    expect(adapter.getState().modelInstances).toBe(1);
    expect(adapter.getState().lastProposal).not.toBeNull();
    adapter.setProject('proj-2');
    expect(adapter.getState()).toEqual({ projectId: 'proj-2', modelInstances: 0, lastProposal: null });
    await adapter.draftBrief(req({ projectId: 'proj-2' }));
    expect(sdk.specs).toHaveLength(2);
  });

  it('a request carrying a different projectId triggers the same clearing', async () => {
    const { adapter, sdk } = make();
    await adapter.draftBrief(req());
    await adapter.draftBrief(req({ projectId: 'proj-9' }));
    expect(sdk.specs).toHaveLength(2);
    expect(adapter.getState().projectId).toBe('proj-9');
  });
});

describe('route policy per task', () => {
  const server = (over: Partial<FreshRoute> = {}): FreshRoute => ({ runDefault: 'PREFER_ON_DEVICE', override: null, lock: null, ...over });
  const route = (over: Partial<NonNullable<AssistRequest['route']>> = {}): NonNullable<AssistRequest['route']> => ({ taskId: 't1', stepKind: 'triage', ...over });
  const LOCK = { label: 'restricted' as const, reason: 'This task reads restricted data.' };

  it('reads the route fresh before every call and uses its effective policy: call override, else task override, else run default', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE', override: 'PREFER_IN_CLOUD' });
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_ON_DEVICE'), route: route() }));
    expect(p.requestedMode).toBe('PREFER_IN_CLOUD');
    expect(p.route).toMatchObject({ taskId: 't1', effectiveMode: 'PREFER_IN_CLOUD', policySource: 'task', locked: false, fellBack: false, conformance: 'conforms' });
    const q = await adapter.draftBrief(req({ policy: cloud('ONLY_ON_DEVICE'), route: route({ callOverride: 'ONLY_IN_CLOUD' }) }));
    expect(q.requestedMode).toBe('ONLY_IN_CLOUD');
    expect(q.route).toMatchObject({ policySource: 'call', callOverride: 'ONLY_IN_CLOUD' });
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' });
    const r = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route: route() }));
    expect(r.requestedMode).toBe('ONLY_ON_DEVICE');
    expect(r.route).toMatchObject({ policySource: 'run' });
    // Read before the call and again inside the queue, right before generate.
    expect(fresh.calls).toBe(6);
  });

  it('a stale view that says unlocked and cloud first never reaches IN_CLOUD when the fresh read says locked', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    // The caller's snapshot was cloud first and unlocked; the server has since locked the task.
    fresh.route = server({ runDefault: 'PREFER_IN_CLOUD', override: 'ONLY_IN_CLOUD', lock: LOCK });
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route: route({ callOverride: 'PREFER_IN_CLOUD' }) }));
    expect(p.requestedMode).toBe('ONLY_ON_DEVICE');
    expect(p).toMatchObject({ status: 'route_violation', data: null });
    expect(p.route).toMatchObject({ effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', locked: true, conformance: 'violation' });
    expect(sdk.specs.every((x) => x.mode === 'ONLY_ON_DEVICE' && x.allowCloud === false)).toBe(true);
  });

  it('a failed or unreadable route read blocks the call with no SDK call, never a cached route', async () => {
    const { adapter, sdk } = make();
    fresh.route = server();
    expect((await adapter.draftBrief(req({ route: route() }))).status).toBe('ok');
    fresh.fail = true;
    const p = await adapter.draftBrief(req({ route: route() }));
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'route_fetch_failed', requestedMode: null });
    fresh.fail = false;
    fresh.route = { runDefault: 'CLOUD', override: null, lock: null } as never;
    expect(await adapter.draftBrief(req({ route: route() }))).toMatchObject({ status: 'blocked', blockedReason: 'route_unreadable' });
    expect(sdk.generateCalls).toBe(1);
  });

  it('an unset route policy blocks with no SDK call', async () => {
    const { adapter, sdk } = make();
    fresh.route = server({ runDefault: null });
    expect(await adapter.draftBrief(req({ route: route() }))).toMatchObject({ status: 'blocked', blockedReason: 'route_policy_unset' });
    expect(sdk.generateCalls).toBe(0);
  });

  it("restricted sources lock the call even if the server's read does not", async () => {
    const { adapter } = make();
    fresh.route = server({ runDefault: 'ONLY_IN_CLOUD' });
    const p = await adapter.draftBrief(req({ sources: [{ id: 's1', classification: 'restricted' }], policy: cloud('ONLY_IN_CLOUD'), route: route({ callOverride: 'ONLY_IN_CLOUD' }) }));
    expect(p.requestedMode).toBe('ONLY_ON_DEVICE');
    expect(p.route).toMatchObject({ policySource: 'lock', locked: true });
  });

  it('records a fallback and an unknown source as such', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE'), route: route() }))).route).toMatchObject({ effectiveMode: 'PREFER_ON_DEVICE', fellBack: true, conformance: 'conforms' });
    sdk.result = { text: GOOD };
    fresh.route = server({ runDefault: 'PREFER_IN_CLOUD' });
    const q = await adapter.draftBrief(req({ policy: cloud('PREFER_IN_CLOUD'), route: route() }));
    expect(q.observedSource).toBe('UNKNOWN');
    expect(q.route).toMatchObject({ fellBack: null, conformance: 'unverified' });
  });

  it('the report for the server is metadata only and parses as the closed shape', async () => {
    const { adapter } = make();
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' });
    const p = await adapter.draftBrief(req({ route: route() }));
    const report = routeReportOf(p);
    expect(RouteRecordReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ kind: 'route', requestId: 'req-1', stepKind: 'triage', requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok', validation: 'passed' });
    expect(JSON.stringify(report)).not.toContain('SECRET-PROMPT-BODY');
    expect(JSON.stringify(report)).not.toContain('Add a board');
    // A call with no task route makes no route read and has nothing to report.
    const calls = fresh.calls;
    expect(routeReportOf(await adapter.draftBrief(req()))).toBeNull();
    expect(fresh.calls).toBe(calls);
  });
});

describe('route re-read inside the queue', () => {
  const server = (over: Partial<FreshRoute> = {}): FreshRoute => ({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null, ...over });
  const route = { taskId: 't1', stepKind: 'patch' as const };
  const LOCK = { label: 'restricted' as const, reason: 'This task reads restricted data.' };

  /** Holds the queue with a first call, starts a second that passes its own route read, then changes the route while the second waits. */
  async function heldQueue(change: () => void) {
    const { adapter, sdk } = make();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    fresh.route = server();
    let release!: () => void;
    sdk.gate = new Promise<void>((r) => { release = r; });
    const first = adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }));
    await vi.waitFor(() => expect(sdk.entered).toBe(1));
    const readsBefore = fresh.calls;
    const second = adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }));
    // The second call's own read happened with the unlocked route; it now waits behind the first.
    await vi.waitFor(() => expect(fresh.calls).toBe(readsBefore + 1));
    change();
    release();
    return { first: await first, second: await second, sdk };
  }

  it('a label raised while a call waits in the queue blocks it before generate: it never reaches the cloud', async () => {
    const { first, second, sdk } = await heldQueue(() => { fresh.route = server({ lock: LOCK }); });
    expect(first.status).toBe('ok');
    expect(second).toMatchObject({ status: 'blocked', blockedReason: 'route_changed_in_queue', data: null, observedSource: 'UNKNOWN' });
    expect(second.route).toMatchObject({ locked: true, effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock' });
    expect(sdk.entered).toBe(1);
    expect(sdk.generateCalls).toBe(1);
  });

  it('a route read that fails inside the queue blocks the call', async () => {
    const { second, sdk } = await heldQueue(() => { fresh.fail = true; });
    expect(second).toMatchObject({ status: 'blocked', blockedReason: 'route_fetch_failed' });
    expect(sdk.entered).toBe(1);
  });

  it('a route changed in any direction while queued blocks the call rather than run on what it was built for', async () => {
    const { second, sdk } = await heldQueue(() => { fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' }); });
    expect(second).toMatchObject({ status: 'blocked', blockedReason: 'route_changed_in_queue' });
    expect(sdk.entered).toBe(1);
  });

  it('an unchanged route passes the in-queue read and runs', async () => {
    const { second, sdk } = await heldQueue(() => {});
    expect(second.status).toBe('ok');
    expect(sdk.generateCalls).toBe(2);
  });
});

describe('input size against the device budget', () => {
  const server = (over: Partial<FreshRoute> = {}): FreshRoute => ({ runDefault: 'ONLY_ON_DEVICE', override: null, lock: null, ...over });
  const route = { taskId: 't1', stepKind: 'review' as const };
  const long = 'x'.repeat(200);

  it('device only: an input over the budget is refused with input_too_large_for_device and never cut', async () => {
    const { adapter, sdk } = make(new FakeSdk(), [], { nanoInputBudgetChars: 150 });
    fresh.route = server();
    const p = await adapter.draftBrief(req({ taskText: long, route }));
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device', requestedMode: 'ONLY_ON_DEVICE' });
    expect(p.input).toMatchObject({ budgetChars: 150, overDeviceBudget: true });
    expect(p.input!.chars).toBeGreaterThan(200);
    expect(sdk.specs).toHaveLength(0);
    expect(sdk.generateCalls).toBe(0);
  });

  it('a locked task over the budget is refused even when the person asked for the cloud', async () => {
    const { adapter, sdk } = make(new FakeSdk(), [], { nanoInputBudgetChars: 150 });
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE', lock: { label: 'restricted', reason: 'r' } });
    const p = await adapter.draftBrief(req({ taskText: long, policy: cloud('PREFER_ON_DEVICE'), route: { ...route, callOverride: 'ONLY_IN_CLOUD' } }));
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device' });
    expect(sdk.generateCalls).toBe(0);
  });

  it('local first without an approved fallback is refused; with one, the oversized call goes to the cloud and is recorded as a fallback', async () => {
    const { adapter, sdk } = make(new FakeSdk(), [], { nanoInputBudgetChars: 150 });
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect(await adapter.draftBrief(req({ taskText: long, policy: policy({ preferredMode: 'PREFER_ON_DEVICE' }), route }))).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device' });
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const p = await adapter.draftBrief(req({ taskText: long, policy: cloud('PREFER_ON_DEVICE'), route }));
    expect(p).toMatchObject({ status: 'ok', requestedMode: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD' });
    expect(p.route).toMatchObject({ effectiveMode: 'PREFER_ON_DEVICE', fellBack: true, conformance: 'conforms', requestModeMismatch: true });
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'ONLY_IN_CLOUD', allowCloud: true });
  });

  it('a missing or invalid budget leaves no room on the device: missing is never unlimited', async () => {
    const { adapter } = make(new FakeSdk(), [], { nanoInputBudgetChars: Number.NaN });
    fresh.route = server();
    expect(await adapter.draftBrief(req({ route }))).toMatchObject({ status: 'blocked', blockedReason: 'input_too_large_for_device' });
  });

  it('an input within the default budget runs on the device', async () => {
    const { adapter } = make();
    fresh.route = server();
    const p = await adapter.draftBrief(req({ route }));
    expect(p.status).toBe('ok');
    expect(p.input).toMatchObject({ budgetChars: 6000, overDeviceBudget: false });
  });
});

describe('secret-shaped input', () => {
  it('is never sent to a model, on any route', async () => {
    const events: TelemetryEvent[] = [];
    const { adapter, sdk } = make(new FakeSdk(), events);
    const p = await adapter.draftBrief(req({ taskText: 'use ghp_abcdefghijklmnopqrstuvwxyz0123 to push', policy: cloud('ONLY_IN_CLOUD') }));
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'secret_in_input' });
    expect(sdk.generateCalls).toBe(0);
    expect(JSON.stringify(events)).not.toContain('ghp_');
  });
});

describe('runAgent', () => {
  const spec = {
    op: 'triageFailure' as const, systemInstruction: 'Explain the failure. Return JSON.', schema: { type: 'object' }, schemaKey: 'triage|', citesCriteria: false,
    prompt: () => ({ prompt: 'the check output' }),
  };

  it('refuses a call that names no task, before any read or model', async () => {
    const { adapter, sdk } = make();
    const p = await adapter.runAgent(spec, { projectId: 'proj-1', allowedRequirementIds: [], sources: [{ id: 's1', classification: 'public' }], policy: policy() } as never);
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'route_required' });
    expect(fresh.calls).toBe(0);
    expect(sdk.specs).toHaveLength(0);
  });

  it('labels of what the prompt reads lock the call to the device, and a secret label blocks it', async () => {
    const { adapter, sdk } = make();
    fresh.route = { runDefault: 'ONLY_IN_CLOUD', override: null, lock: null };
    sdk.result = { text: '{}', inferenceSource: 'on_device' };
    const base = { projectId: 'proj-1', allowedRequirementIds: [], sources: [{ id: 's1', classification: 'public' as const }], policy: cloud('ONLY_IN_CLOUD'), route: { taskId: 't1', stepKind: 'triage' as const } };
    const p = await adapter.runAgent(spec, { ...base, labels: ['internal', 'restricted'] });
    expect(p.requestedMode).toBe('ONLY_ON_DEVICE');
    expect(p.route).toMatchObject({ locked: true, policySource: 'lock' });
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowCloud: false });
    const generated = sdk.generateCalls;
    expect(await adapter.runAgent(spec, { ...base, labels: ['secret'] })).toMatchObject({ status: 'blocked', blockedReason: 'secret_excluded_from_model_context' });
    expect(await adapter.runAgent(spec, { ...base, labels: ['top-secret?'] })).toMatchObject({ status: 'blocked', blockedReason: 'secret_excluded_from_model_context' });
    expect(sdk.generateCalls).toBe(generated);
  });

  it("a prompt builder's refusal blocks with its code; a failed check makes the response invalid", async () => {
    const { adapter, sdk } = make();
    fresh.route = { runDefault: 'ONLY_ON_DEVICE', override: null, lock: null };
    const base = { projectId: 'proj-1', allowedRequirementIds: [], sources: [{ id: 's1', classification: 'public' as const }], policy: policy(), route: { taskId: 't1', stepKind: 'triage' as const } };
    expect(await adapter.runAgent({ ...spec, prompt: () => ({ refused: 'check_output_too_large' }) }, base)).toMatchObject({ status: 'blocked', blockedReason: 'check_output_too_large' });
    expect(sdk.generateCalls).toBe(0);
    sdk.result = { text: '{"a":1}', inferenceSource: 'on_device' };
    const p = await adapter.runAgent({ ...spec, check: () => ['/a path_invalid'] }, base);
    expect(p).toMatchObject({ status: 'invalid', data: null, validation: { status: 'failed', errors: ['/a path_invalid'] } });
  });
});

describe('labels against the cloud grant', () => {
  const spec = { op: 'triageFailure' as const, systemInstruction: 'Explain. Return JSON.', schema: { type: 'object' }, schemaKey: 'triage|', citesCriteria: false, prompt: () => ({ prompt: 'p' }) };
  const base = (mode: string) => ({ projectId: 'proj-1', allowedRequirementIds: [], sources: [{ id: 's1', classification: 'public' as const }], policy: cloud(mode), route: { taskId: 't1', stepKind: 'triage' as const } });

  it('a label the grant does not cover refuses a cloud-only route and keeps a device-capable one on the device', async () => {
    const { adapter, sdk } = make();
    sdk.result = { text: '{}', inferenceSource: 'on_device' };
    fresh.route = { runDefault: 'ONLY_IN_CLOUD', override: null, lock: null };
    expect(await adapter.runAgent(spec, { ...base('ONLY_IN_CLOUD'), labels: ['internal'] })).toMatchObject({ status: 'blocked', blockedReason: 'cloud_not_granted_for_label' });
    expect(sdk.specs).toHaveLength(0);
    fresh.route = { runDefault: 'PREFER_IN_CLOUD', override: null, lock: null };
    const p = await adapter.runAgent(spec, { ...base('PREFER_IN_CLOUD'), labels: ['internal'] });
    expect(p).toMatchObject({ status: 'ok', requestedMode: 'ONLY_ON_DEVICE' });
    expect(p.route).toMatchObject({ effectiveMode: 'PREFER_IN_CLOUD', fellBack: true, conformance: 'conforms' });
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowCloud: false });
    // A covered label changes nothing.
    sdk.result = { text: '{}', inferenceSource: 'in_cloud' };
    expect(await adapter.runAgent(spec, { ...base('PREFER_IN_CLOUD'), labels: ['public'] })).toMatchObject({ status: 'ok', requestedMode: 'PREFER_IN_CLOUD' });
  });
});

describe('H12: offline', () => {
  const server = (over: Partial<FreshRoute> = {}): FreshRoute => ({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null, ...over });
  const route = { taskId: 't1', stepKind: 'review' as const };

  it('a call that needs the cloud while offline is not sent: blocked as offline, so it can wait for the connection; no model is made', async () => {
    const { adapter, sdk } = make(new FakeSdk(), [], { isOnline: () => false });
    fresh.route = server();
    const p = await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }));
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'offline', requestedMode: 'ONLY_IN_CLOUD' });
    expect(sdk.specs).toHaveLength(0);
    // Local first over the device budget would go to the cloud: offline, it waits too.
    const big = make(new FakeSdk(), [], { isOnline: () => false, nanoInputBudgetChars: 150 });
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect(await big.adapter.draftBrief(req({ taskText: 'x'.repeat(200), policy: cloud('PREFER_ON_DEVICE'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'offline' });
  });

  it('offline, a device call still runs: Local only, and Local first while the device model is ready', async () => {
    const { adapter } = make(new FakeSdk(), [], { isOnline: () => false });
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ route }))).status).toBe('ok');
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE'), route }))).status).toBe('ok');
    // Local first with the device model not ready would fall back to the cloud: offline it waits instead.
    const sdk = new FakeSdk();
    sdk.availabilityValue = 'downloadable';
    const off = make(sdk, [], { isOnline: () => false });
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect(await off.adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'offline' });
  });

  it('fix 1 (I2): a TypeError (a bug, not the network) surfaces as an error, never as offline', async () => {
    const sdk = new FakeSdk();
    sdk.gate = Promise.reject(new TypeError('cannot read properties of undefined'));
    sdk.gate.catch(() => undefined);
    let failures = 0;
    const { adapter } = make(sdk, [], { isOnline: () => true, onNetworkFailure: () => { failures += 1; } });
    fresh.route = server();
    expect(await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).toMatchObject({ status: 'error', errorName: 'TypeError', blockedReason: null });
    expect(failures).toBe(0);
  });

  it('fix 1 (I2): a cloud answer tells the browser the network is back', async () => {
    const sdk = new FakeSdk();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    let ok = 0;
    const { adapter } = make(sdk, [], { isOnline: () => true, onNetworkSuccess: () => { ok += 1; } });
    fresh.route = server();
    expect((await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).status).toBe('ok');
    expect(ok).toBe(1);
  });

  it('a cloud call whose request fails on the network (the SDK\'s AIError `error` wrapping the fetch failure) is offline too, and says so', async () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      const sdk = new FakeSdk();
      sdk.gate = Promise.reject(networkError(message));
      sdk.gate.catch(() => undefined);
      let failures = 0;
      const { adapter } = make(sdk, [], { isOnline: () => true, onNetworkFailure: () => { failures += 1; } });
      fresh.route = server();
      expect(await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'offline', errorCode: 'error' });
      expect(failures).toBe(1);
    }
  });

  it('H9 fix round 3: an HTTP error came back from the cloud, so it is never offline: 429 pauses as the cloud quota or rate limit, 500 and 400 are errors', async () => {
    const run = async (e: unknown) => {
      const sdk = new FakeSdk();
      sdk.gate = Promise.reject(e);
      sdk.gate.catch(() => undefined);
      let failures = 0;
      const { adapter } = make(sdk, [], { isOnline: () => true, onNetworkFailure: () => { failures += 1; } });
      fresh.route = server();
      return { p: await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route })), failures };
    };
    const limited = await run(httpError(429, 'Too Many Requests'));
    expect(limited.p).toMatchObject({ status: 'blocked', blockedReason: 'cloud_rate_limited', errorCode: 'fetch-error' });
    expect(limited.failures).toBe(0);
    for (const [status, text] of [[500, 'Internal Server Error'], [400, 'Bad Request']] as const) {
      const r = await run(httpError(status, text));
      expect(r.p).toMatchObject({ status: 'error', blockedReason: null, errorCode: 'fetch-error' });
      expect(r.failures).toBe(0);
    }
  });
});

describe('H9: the hosted demo\'s cloud call cap', () => {
  const server = (over: Partial<FreshRoute> = {}): FreshRoute => ({ runDefault: 'ONLY_IN_CLOUD', override: null, lock: null, ...over });
  const route = { taskId: 't1', stepKind: 'review' as const };
  const cap = (limit: number, start = 0) => {
    let used = start;
    return { allowed: () => used < limit, reserve: () => { if (used >= limit) return false; used += 1; return true; }, refund: () => { used = Math.max(0, used - 1); }, used: () => used };
  };

  it('each call that may go to the cloud reserves one before it is sent; an answer on this device gives it back', async () => {
    const sdk = new FakeSdk();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const quota = cap(5);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server();
    expect((await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).status).toBe('ok');
    expect(quota.used()).toBe(1);
    // Local first may fall back to the cloud: reserved, then given back when the device answered.
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE'), route }))).status).toBe('ok');
    expect(quota.used()).toBe(1);
    // Local only never reserves.
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ route }))).status).toBe('ok');
    expect(quota.used()).toBe(1);
  });

  it('H9 fix round 1 (I2): a cloud call that fails still costs its unit', async () => {
    const sdk = new FakeSdk();
    sdk.gate = Promise.reject(Object.assign(new Error('quota exceeded'), { name: 'FirebaseError', code: 'AI/api-error' }));
    sdk.gate.catch(() => undefined);
    const quota = cap(5);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server();
    expect((await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).status).toBe('error');
    expect(quota.used()).toBe(1);
  });

  it('H9 fix round 2: a cloud call that fails on the network was never sent: its unit is given back, and it waits as offline', async () => {
    const sdk = new FakeSdk();
    sdk.gate = Promise.reject(networkError());
    sdk.gate.catch(() => undefined);
    const quota = cap(5);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server();
    expect(await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'offline' });
    expect(quota.used()).toBe(0);
  });

  it('H9 fix round 3: an HTTP error reached the cloud: a 429 and a 500 each cost their unit', async () => {
    for (const e of [httpError(429, 'Too Many Requests'), httpError(500, 'Internal Server Error')]) {
      const sdk = new FakeSdk();
      sdk.gate = Promise.reject(e);
      sdk.gate.catch(() => undefined);
      const quota = cap(5);
      const { adapter } = make(sdk, [], { cloudCalls: quota });
      fresh.route = server();
      expect((await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).blockedReason).not.toBe('offline');
      expect(quota.used()).toBe(1);
    }
  });

  it('M1: under Cloud first the SDK tries the cloud before the device (a 429 falls back), so an answer on the device still costs its unit', async () => {
    const sdk = new FakeSdk();
    sdk.result = { text: GOOD, inferenceSource: 'on_device' };
    const quota = cap(5);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server({ runDefault: 'PREFER_IN_CLOUD' });
    expect((await adapter.draftBrief(req({ policy: cloud('PREFER_IN_CLOUD'), route }))).status).toBe('ok');
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'PREFER_IN_CLOUD' });
    expect(quota.used()).toBe(1);
  });

  it('H9 fix round 1 (I2): two calls at once with one unit left: exactly one is sent, the other pauses as cloud_quota', async () => {
    const sdk = new FakeSdk();
    sdk.result = { text: GOOD, inferenceSource: 'in_cloud' };
    const quota = cap(40, 39);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server();
    const both = await Promise.all([adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route })), adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))]);
    expect(both.map((p) => p.status).sort()).toEqual(['blocked', 'ok']);
    expect(both.find((p) => p.status === 'blocked')).toMatchObject({ blockedReason: 'cloud_quota' });
    expect(sdk.prompts).toHaveLength(1);
    expect(quota.used()).toBe(40);
  });

  it('once the cap is reached, a call that needs the cloud is not sent; Local first runs on this device only, never falling back', async () => {
    const sdk = new FakeSdk();
    const quota = cap(0);
    const { adapter } = make(sdk, [], { cloudCalls: quota });
    fresh.route = server();
    expect(await adapter.draftBrief(req({ policy: cloud('ONLY_IN_CLOUD'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'cloud_quota', requestedMode: 'ONLY_IN_CLOUD' });
    fresh.route = server({ runDefault: 'PREFER_IN_CLOUD' });
    expect(await adapter.draftBrief(req({ policy: cloud('PREFER_IN_CLOUD'), route }))).toMatchObject({ status: 'blocked', blockedReason: 'cloud_quota' });
    expect(sdk.specs).toHaveLength(0);
    fresh.route = server({ runDefault: 'PREFER_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ policy: cloud('PREFER_ON_DEVICE'), route }))).status).toBe('ok');
    expect(sdk.specs.at(-1)).toMatchObject({ mode: 'ONLY_ON_DEVICE', allowCloud: false });
    fresh.route = server({ runDefault: 'ONLY_ON_DEVICE' });
    expect((await adapter.draftBrief(req({ route }))).status).toBe('ok');
    expect(quota.used()).toBe(0);
  });
});
