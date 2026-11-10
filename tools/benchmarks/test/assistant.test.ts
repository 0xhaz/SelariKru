import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BENCH_GLOBAL, createBenchBridge, installBenchBridge, type AssistantSdk, type DeviceAvailability, type ModelSpec, type SdkGenerateResult } from '@selarikru/inference-firebase-web/bench';
import { freezeOrder, NO_STARTS, type Manifest, type StartRecords } from '../src/manifest.ts';
import { preflight } from '../src/preflight.ts';
import { buildReport, exportResults, type RawRecord } from '../src/report.ts';
import { composeRequest, loadBriefFixtures } from '../src/assistant/payload.ts';
import { benchPageAdapter, connectBenchPage, type BrowserLike, type PageLike, type RouteAdapter } from '../src/assistant/route.ts';
import { runAssistantCohort } from '../src/assistant/runner.ts';
import { LiveRefusedError, OrderError } from '../src/trials.ts';
import { watchNetwork } from './network.ts';
import { HASHES, REPO_ROOT, resolvedManifest, started } from './fixtures.ts';

/** Test doubles only: a fake Firebase SDK behind the real bench bridge, and a fake Playwright page. No model, no network. */

interface Clock { t: number }

interface FakeSdkOptions {
  availability?: DeviceAvailability;
  downloadMs?: number;
  /** What one generation answers, by call number (from 1) and spec. Default: a valid proposal from the requested route. */
  answer?: (n: number, spec: ModelSpec, prompt: string) => SdkGenerateResult | 'throw' | 'hang';
  generationMs?: (n: number, spec: ModelSpec) => number;
  /** Real milliseconds a generation takes, by call number. Default: none. */
  realDelayMs?: (n: number) => number;
  /** Real milliseconds the device model download takes. */
  realDownloadMs?: number;
}

const ALLOWED = (prompt: string): string[] => /Allowed requirement IDs: ([^.]+)\./.exec(prompt)![1]!.split(', ');
const validText = (prompt: string): string => JSON.stringify({ summary: 'A short synthetic summary.', acceptanceCriteria: [{ requirementId: ALLOWED(prompt)[0], text: 'A testable criterion.' }] });

function fakeSdk(clock: Clock, o: FakeSdkOptions = {}) {
  let availability: DeviceAvailability = o.availability ?? 'available';
  const calls = { createModel: [] as ModelSpec[], generate: [] as string[], inFlight: 0, maxInFlight: 0, overlapped: [] as number[] };
  const sdk: AssistantSdk = {
    async availability() { return availability; },
    async initializeDeviceModel() {
      clock.t += o.downloadMs ?? 0;
      if (o.realDownloadMs) await new Promise((r) => setTimeout(r, o.realDownloadMs));
      availability = 'available';
    },
    createModel(spec) {
      calls.createModel.push(spec);
      return {
        async generate(prompt) {
          calls.generate.push(prompt);
          const n = calls.generate.length;
          clock.t += o.generationMs?.(n, spec) ?? (spec.mode === 'ONLY_ON_DEVICE' ? 900 : 400) + n;
          const a = o.answer?.(n, spec, prompt);
          if (a === 'throw') throw Object.assign(new Error('provider said: quota for project-123 exceeded'), { code: 'AI/quota-exceeded' });
          if (a === 'hang') return new Promise(() => {});
          calls.inFlight += 1;
          calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
          if (calls.inFlight > 1) calls.overlapped.push(n);
          const delay = o.realDelayMs?.(n) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          calls.inFlight -= 1;
          return a ?? { text: validText(prompt), inferenceSource: spec.mode === 'ONLY_ON_DEVICE' ? 'on_device' : 'in_cloud', ...(spec.mode === 'ONLY_IN_CLOUD' ? { usage: { inputTokens: 210, outputTokens: 80 } } : {}) };
        },
      };
    },
  };
  return { sdk, calls };
}

/** A fake page: arguments and results cross as structured clones, as they do over CDP, and the page's globals hold only the bridge. */
function fakePage(): PageLike {
  return {
    url: () => 'https://selarikru.web.app/bench.html',
    async evaluate(fn, arg) {
      return structuredClone(await fn(structuredClone(arg)));
    },
  };
}

function bench(o: FakeSdkOptions = {}) {
  const clock: Clock = { t: 0 };
  const { sdk, calls } = fakeSdk(clock, o);
  installBenchBridge(createBenchBridge({ sdk, now: () => clock.t, userAgent: 'Chrome/140 (fake)', origin: 'https://selarikru.web.app' }));
  return { adapter: benchPageAdapter(fakePage()), calls, clock };
}

afterEach(() => { delete (globalThis as Record<string, unknown>)[BENCH_GLOBAL]; });

const fixturesFor = (m: Manifest) => loadBriefFixtures(m, REPO_ROOT);
const AT = '2026-11-20T10:00:00.000Z';

function liveCohort(over: (m: Manifest) => void = () => {}): { manifest: Manifest; starts: StartRecords; live: { preflight: ReturnType<typeof preflight>; starts: StartRecords } } {
  // M5: the bench page's environment must match the pinned assistant fields; the fake bridge reports the adapter's own SDK and cloud model.
  const c = started(resolvedManifest((m) => { m.assistant.sdkVersion = '13.1.0'; m.assistant.cloudModel = 'gemini-3.5-flash-lite'; over(m); }));
  const pf = preflight({ manifest: c.manifest, env: {}, verifier: { recorded: HASHES, recomputed: HASHES }, starts: c.starts });
  return { ...c, live: { preflight: pf, starts: c.starts } };
}

const measured = (rs: readonly RawRecord[]) => rs.filter((r) => !r.assistant!.warmup);
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2; };

describe('T8.2 assistant runner', () => {
  it('runs the frozen cohort: 60 measured requests and 2 excluded warm-ups per route, in the frozen order, with no network', async () => {
    const net = watchNetwork();
    try {
      const c = liveCohort();
      const { adapter } = bench();
      const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live });
      expect(records).toHaveLength(64);
      expect(measured(records)).toHaveLength(60);
      expect(records.filter((r) => r.assistant!.warmup).map((r) => r.mode).sort()).toEqual(['ONLY_IN_CLOUD', 'ONLY_IN_CLOUD', 'ONLY_ON_DEVICE', 'ONLY_ON_DEVICE']);
      expect(records.map((r) => r.slotId)).toEqual(c.manifest.randomization.order.filter((s) => s.startsWith('assistant/')));
      // Warm-ups come first, then the routes interleave.
      expect(records.slice(0, 4).every((r) => r.assistant!.warmup)).toBe(true);
      expect(new Set(measured(records).slice(0, 10).map((r) => r.mode)).size).toBe(2);
      expect(net.calls()).toEqual([]);
    } finally {
      net.restore();
    }
  });

  it('route mismatch or unknown source counts as a routing failure', async () => {
    const c = liveCohort();
    // Call 5 is answered from the other route; call 6 names a source the SDK does not define; call 7 names none.
    const { adapter } = bench({
      answer: (n, spec, prompt) => {
        const other = spec.mode === 'ONLY_ON_DEVICE' ? 'in_cloud' : 'on_device';
        if (n === 5) return { text: validText(prompt), inferenceSource: other };
        if (n === 6) return { text: validText(prompt), inferenceSource: 'hybrid' };
        if (n === 7) return { text: validText(prompt) };
        return undefined as never;
      },
    });
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live });
    const routing = records.filter((r) => r.failures.some((f) => f.category === 'routing_failure'));
    expect(routing.map((r) => records.indexOf(r))).toEqual([4, 5, 6]);
    for (const r of routing) expect(r.status).toBe('failed');
    expect(routing[0]!.assistant!.observedInferenceSource).toBe(routing[0]!.mode === 'ONLY_ON_DEVICE' ? 'IN_CLOUD' : 'ON_DEVICE');
    expect(routing[1]!.assistant!.observedInferenceSource).toBeNull();
    expect(routing[2]!.assistant!.observedInferenceSource).toBeNull();
    // The report counts none of them as routed correctly or passed.
    const report = buildReport(exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT }), c.manifest);
    const misrouted = routing.filter((r) => !r.assistant!.warmup).length;
    const correct = report.assistant.routes.reduce((s, r) => s + r.routing.correct, 0);
    expect(correct).toBe(60 - misrouted);
    expect(report.assistant.routes.reduce((s, r) => s + r.completion.passed, 0)).toBe(60 - misrouted);
  });

  it('first-output null when streaming is unavailable', async () => {
    const c = liveCohort();
    const { adapter } = bench();
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live });
    for (const r of records) {
      expect(r.timings.firstOutputMs).toBeNull();
      expect(r.timings.generationCompleteMs).toBeGreaterThan(0);
    }
    const report = buildReport(exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT }), c.manifest);
    for (const route of report.assistant.routes) expect(route.firstOutput.median).toBeNull();
  });

  it('setup and download kept out of warm medians', async () => {
    const c = liveCohort();
    // A device model that must first download for 240 s; every generation takes 1 s on device and 0.5 s in the cloud.
    const { adapter } = bench({ availability: 'downloadable', downloadMs: 240_000, generationMs: (_n, spec) => (spec.mode === 'ONLY_ON_DEVICE' ? 1000 : 500) });
    const { records, setupLedger } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live });
    expect(setupLedger.map((e) => [e.route, e.modelDownloadMs, e.outcome])).toEqual(expect.arrayContaining([['ONLY_ON_DEVICE', 240_000, 'ready'], ['ONLY_IN_CLOUD', null, 'ready']]));
    expect(setupLedger).toHaveLength(2);
    for (const r of records) {
      expect(r.timings.modelDownloadMs).toBeNull();
      expect(r.timings.initialSetupMs).toBeNull();
    }
    const report = buildReport(exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT }), c.manifest);
    const device = report.assistant.routes.find((r) => r.mode === 'ONLY_ON_DEVICE')!;
    expect(device.warmups).toBe(2);
    expect(device.generationComplete.median).toBe(1000);
    expect(device.generationComplete.max).toBe(1000);
    expect(device.generationComplete.n).toBe(30);
  });

  it('every attempt retained', async () => {
    const c = liveCohort();
    // Errors, a call that outlasts the request limit (and then settles), malformed output, a requirement ID the fixture does not allow: all kept.
    const { adapter, calls } = bench({
      realDelayMs: (n) => (n === 11 ? 300 : 0),
      answer: (n, _spec, prompt) => {
        if (n === 10) return 'throw';
        if (n === 12) return { text: 'not json', inferenceSource: _spec.mode === 'ONLY_ON_DEVICE' ? 'on_device' : 'in_cloud' };
        if (n === 13) return { text: JSON.stringify({ summary: 's', acceptanceCriteria: [{ requirementId: ALLOWED(prompt).includes('FB-08') ? 'FB-01' : 'FB-08', text: 't' }] }), inferenceSource: _spec.mode === 'ONLY_ON_DEVICE' ? 'on_device' : 'in_cloud' };
        return undefined as never;
      },
    });
    const { records, outputs } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live, requestTimeoutMs: 200 });
    expect(records).toHaveLength(64);
    expect(records[9]).toMatchObject({ status: 'failed', failures: [{ category: 'generation_error', detail: 'AI/quota-exceeded' }] });
    expect(JSON.stringify(records)).not.toContain('project-123');
    expect(records[10]).toMatchObject({ status: 'timed_out', failures: [{ category: 'request_timeout' }] });
    expect(records[11]).toMatchObject({ status: 'completed', assistant: expect.objectContaining({ schemaValid: false }), failures: [{ category: 'output_not_json' }] });
    expect(records[12]).toMatchObject({ status: 'completed', assistant: expect.objectContaining({ schemaValid: false }), failures: [{ category: 'requirement_id_outside_fixture' }] });
    // Every request that answered in time keeps its output for the blinded review (the error's is null); the timed-out one has none.
    expect(outputs).toHaveLength(63);
    expect(calls.maxInFlight).toBe(1);
    const file = exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT });
    expect(file.records).toHaveLength(64);
    const report = buildReport(file, c.manifest);
    const total = report.assistant.routes.reduce((s, r) => s + r.attempts.recorded, 0);
    expect(total).toBe(60);
    expect(report.assistant.routes.reduce((s, r) => s + r.attempts.timedOut + r.attempts.failed + r.attempts.completedFailing, 0)).toBe(records.slice(9, 13).filter((r) => !r.assistant!.warmup).length);
  });

  it('payload hash is deterministic: the logical digest of the system instruction and the prompt, the same on both routes', async () => {
    const m = resolvedManifest();
    const fixtures = fixturesFor(m);
    const a = await composeRequest(fixtures, 'brief-03');
    const b = await composeRequest(fixtures, 'brief-03');
    expect(a).toEqual(b);
    expect(a.payloadSha256).toBe(createHash('sha256').update(`${fixtures.systemInstruction}\n\n${a.prompt}`, 'utf8').digest('hex'));
    const fixture = fixtures.fixtures.find((f) => f.id === 'brief-03')!;
    expect(a.prompt.startsWith(fixture.prompt)).toBe(true);
    expect(a.prompt).toContain(`Allowed requirement IDs: ${fixture.allowedRequirementIds.join(', ')}.`);
    expect((await composeRequest(fixtures, 'brief-04')).payloadSha256).not.toBe(a.payloadSha256);
    // The request schema's requirement IDs are narrowed to the fixture.
    expect(JSON.stringify(a.responseSchema)).toContain(JSON.stringify(fixture.allowedRequirementIds));
    const c = liveCohort();
    const { adapter } = bench();
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures, adapter, live: c.live });
    const byFixture = new Map<string, Set<string>>();
    for (const r of records) byFixture.set(r.assistant!.fixtureId!, new Set([...(byFixture.get(r.assistant!.fixtureId!) ?? []), r.assistant!.payloadSha256!]));
    for (const hashes of byFixture.values()) expect(hashes.size).toBe(1);
  });

  it('sends each request with no conversation history: a new model per request, given only that request\'s prompt', async () => {
    const c = liveCohort();
    const { adapter, calls } = bench();
    const fixtures = fixturesFor(c.manifest);
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures, adapter, live: c.live });
    expect(calls.createModel).toHaveLength(64);
    expect(calls.generate).toHaveLength(64);
    for (const [i, r] of records.entries()) expect(calls.generate[i]).toBe((await composeRequest(fixtures, r.assistant!.fixtureId!)).prompt);
    // Device-only models carry no cloud parameters, so there is nothing to fall back to.
    for (const spec of calls.createModel) expect(spec.allowCloud).toBe(spec.mode === 'ONLY_IN_CLOUD');
  });

  it('a frozen order that cannot change after start', async () => {
    const fixtures = fixturesFor(resolvedManifest());
    const { adapter } = bench();
    // Unfrozen: nothing runs, dry run or not.
    const unfrozen = resolvedManifest();
    unfrozen.randomization = { ...unfrozen.randomization, seed: null, order: [], orderSha256: null, frozenAtUtc: null };
    await expect(runAssistantCohort({ manifest: unfrozen, fixtures, adapter, live: null })).rejects.toThrow(OrderError);
    // Started, then reordered: the start no longer holds and live dispatch is refused.
    const c = liveCohort();
    const reordered = structuredClone(c.manifest);
    const order = reordered.randomization.order;
    const last = order.length - 1;
    [order[last], order[last - 1]] = [order[last - 1]!, order[last]!];
    await expect(runAssistantCohort({ manifest: reordered, fixtures, adapter, live: c.live })).rejects.toThrow(LiveRefusedError);
    // Re-freezing after start is refused outright.
    expect(() => freezeOrder(c.manifest, 'another-seed', AT, c.starts)).toThrow(/cannot change after start/);
  });

  it('refuses live dispatch on a blocked preflight or an unstarted track', async () => {
    const { adapter, calls } = bench();
    const m = resolvedManifest((x) => { x.proposedVariableBudgetUsd.status = 'proposal_not_authorized'; });
    const fixtures = fixturesFor(m);
    const blocked = preflight({ manifest: m, env: {}, verifier: { recorded: HASHES, recomputed: HASHES }, starts: NO_STARTS });
    await expect(runAssistantCohort({ manifest: m, fixtures, adapter, live: { preflight: blocked, starts: NO_STARTS } })).rejects.toThrow(/budget_not_authorized/);
    const ok = resolvedManifest();
    const pf = preflight({ manifest: ok, env: {}, verifier: { recorded: HASHES, recomputed: HASHES }, starts: NO_STARTS });
    await expect(runAssistantCohort({ manifest: ok, fixtures, adapter, live: { preflight: pf, starts: NO_STARTS } })).rejects.toThrow(/cohort_not_started/);
    expect(calls.generate).toEqual([]);
  });

  it('a dry run is simulated and the T8.4 report accepts it; a measured fake run is reported per route', async () => {
    const m = resolvedManifest();
    const { adapter } = bench();
    const dry = await runAssistantCohort({ manifest: m, fixtures: fixturesFor(m), adapter, live: null });
    expect(dry.records.every((r) => r.dataKind === 'simulated')).toBe(true);
    expect(buildReport(exportResults({ manifest: m, starts: NO_STARTS, records: dry.records, generatedAtUtc: AT }), m)).toBeTruthy();
    const c = liveCohort();
    const live = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter: bench().adapter, live: c.live });
    const report = buildReport(exportResults({ manifest: c.manifest, starts: c.starts, records: live.records, generatedAtUtc: AT }), c.manifest);
    for (const route of report.assistant.routes) {
      expect(route.status).toBe('Measured');
      expect(route.completion).toEqual({ passed: 30, of: 30 });
      expect(route.routing).toEqual({ correct: 30, of: 30 });
    }
    const cloud = measured(live.records).filter((r) => r.mode === 'ONLY_IN_CLOUD');
    expect(cloud.every((r) => r.assistant!.providerInputTokens === 210)).toBe(true);
    // Device usage is not reported by the SDK, so it stays null; bytes are kept as bytes.
    const device = measured(live.records).filter((r) => r.mode === 'ONLY_ON_DEVICE');
    expect(device.every((r) => r.assistant!.providerInputTokens === null && r.assistant!.inputBytes! > 0)).toBe(true);
    expect(report.assistant.routes.find((r) => r.mode === 'ONLY_IN_CLOUD')!.generationComplete.median).toBe(median(cloud.map((r) => r.timings.generationCompleteMs!)));
  });

  it('connects over CDP only to a loopback endpoint and only to an open bench tab, never opening one', async () => {
    bench();
    const page = fakePage();
    let closed = 0;
    const browser = (pages: PageLike[]): BrowserLike => ({ contexts: () => [{ pages: () => pages }], close: async () => { closed += 1; } });
    const other: PageLike = { ...fakePage(), url: () => 'https://example.com/' };
    await expect(connectBenchPage({ endpoint: 'http://10.0.0.5:9222', benchUrl: 'https://selarikru.web.app/bench.html', connect: async () => browser([page]) })).rejects.toThrow(/loopback/);
    await expect(connectBenchPage({ endpoint: 'http://127.0.0.1:9222', benchUrl: 'https://selarikru.web.app/bench.html', connect: async () => browser([other]) })).rejects.toThrow(/no open tab/);
    expect(closed).toBe(1);
    const adapter = await connectBenchPage({ endpoint: 'http://127.0.0.1:9222', benchUrl: 'https://selarikru.web.app/bench.html', connect: async () => browser([other, page]) });
    expect((await adapter.environment()).sdkVersion).toBe('13.1.0');
    await adapter.close!();
    expect(closed).toBe(2);
  });

  it('I2: a request that outlasts its limit is waited for before the next send, so no two requests ever overlap', async () => {
    const c = liveCohort();
    const { adapter, calls } = bench({ realDelayMs: (n) => (n === 5 ? 300 : 5) });
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live, requestTimeoutMs: 100 });
    expect(calls.maxInFlight).toBe(1);
    expect(calls.overlapped).toEqual([]);
    expect(records[4]).toMatchObject({ status: 'timed_out' });
    expect(records.filter((r) => r.status === 'completed')).toHaveLength(63);
    expect(records.some((r) => r.confounders.length > 0)).toBe(false);
  });

  it('I2: a call that never settles stops its route; its remaining slots are not run, and no later sample is recorded as clean', async () => {
    const c = liveCohort();
    let stalledRoute: string | null = null;
    const { adapter } = bench({ answer: (n, spec) => { if (n === 5) { stalledRoute = spec.mode; return 'hang'; } return undefined as never; } });
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live, requestTimeoutMs: 50 });
    expect(records).toHaveLength(64);
    expect(records[4]).toMatchObject({ status: 'timed_out' });
    const after = records.slice(5);
    for (const r of after.filter((x) => x.mode === stalledRoute)) expect(r).toMatchObject({ status: 'not_run', failures: [{ category: 'route_stalled' }] });
    for (const r of after.filter((x) => x.mode !== stalledRoute)) expect(r.confounders.join(' ')).toMatch(/overlapped_in_flight_call/);
  });

  it('I3: a bridge or CDP transport failure is infrastructure: the slot is abandoned and the rest of the cohort is not run', async () => {
    const c = liveCohort();
    bench();
    let n = 0;
    const page: PageLike = {
      url: () => 'https://selarikru.web.app/bench.html',
      async evaluate(fn, arg) {
        n += 1;
        // The 2 readiness calls plus env, then setup and generate pairs: fail partway through.
        if (n === 20) throw new Error('Target page, context or browser has been closed');
        return structuredClone(await fn(structuredClone(arg)));
      },
    };
    const { records } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter: benchPageAdapter(page), live: c.live });
    expect(records).toHaveLength(64);
    const i = records.findIndex((r) => r.status === 'abandoned');
    expect(records[i]!.failures).toEqual([{ category: 'bench_transport_failure', detail: null }]);
    expect(JSON.stringify(records[i])).not.toContain('Target page');
    for (const r of records.slice(i + 1)) expect(r).toMatchObject({ status: 'not_run', failures: [{ category: 'cohort_stopped' }] });
    expect(exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT }).records).toHaveLength(64);
  });

  it('M3: setup has its own long bound from the manifest, apart from the request limit, and its time goes to the ledger', async () => {
    const c = liveCohort((m) => { m.assistant.setupTimeoutSeconds = 5; });
    const { adapter } = bench({ availability: 'downloadable', realDownloadMs: 300 });
    const { records, setupLedger } = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live, requestTimeoutMs: 100 });
    expect(setupLedger.find((e) => e.route === 'ONLY_ON_DEVICE')).toMatchObject({ outcome: 'ready' });
    expect(records.filter((r) => r.mode === 'ONLY_ON_DEVICE' && r.status === 'completed')).toHaveLength(32);
  });

  it('M5: a live cohort refuses a bench page whose SDK, cloud model or origin is not the pinned one, and M4: the adapter is closed anyway', async () => {
    const c = liveCohort((m) => { m.assistant.cloudModel = 'some-other-model'; m.assistant.origin = 'https://elsewhere.example'; });
    const { adapter } = bench();
    let closed = 0;
    await expect(runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter: { ...adapter, close: async () => { closed += 1; } }, live: c.live }))
      .rejects.toThrow(/bench_environment_mismatch: cloudModel.*bench_environment_mismatch: origin|bench_environment_mismatch: cloudModel, bench_environment_mismatch: origin/);
    expect(closed).toBe(1);
  });

  it('N1: a setup that outlasts its bound is waited for, never run twice or overlapped; one that never settles stalls its route', async () => {
    const c = liveCohort();
    const run = async (downloadMs: number) => {
      let setups = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const { adapter: inner } = bench();
      const adapter: RouteAdapter = {
        ...inner,
        async setup(route) {
          if (route === 'ONLY_IN_CLOUD') return inner.setup(route);
          setups += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, downloadMs));
          inFlight -= 1;
          return { route, availability: 'available', outcome: 'ready', downloadMs, errorCode: null, clockDomain: 'browser-monotonic' };
        },
      };
      const out = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter, live: c.live, requestTimeoutMs: 100, setupTimeoutMs: 100 });
      return { ...out, setups, maxInFlight };
    };
    // The reviewer's repro: a download that outlives both the bound and the wait for it.
    const stalled = await run(1000);
    expect(stalled.setups).toBe(1);
    expect(stalled.maxInFlight).toBe(1);
    const dev = stalled.records.filter((r) => r.mode === 'ONLY_ON_DEVICE');
    expect(dev[0]).toMatchObject({ status: 'denied_start', failures: [expect.objectContaining({ category: 'route_unavailable' })] });
    for (const r of dev.slice(1)) expect(r).toMatchObject({ status: 'not_run', failures: [{ category: 'route_stalled' }] });
    const firstDevice = stalled.records.indexOf(dev[0]!);
    for (const r of stalled.records.slice(firstDevice + 1).filter((x) => x.mode === 'ONLY_IN_CLOUD')) expect(r.confounders.join(' ')).toMatch(/overlapped_in_flight_call/);
    expect(stalled.setupLedger.filter((e) => e.route === 'ONLY_ON_DEVICE').map((e) => [e.errorCode, e.superseded])).toEqual([['setup_timeout', false]]);
    // A download that outlives the bound but settles within the wait: its result is kept and setup is not run again.
    const late = await run(150);
    expect(late.setups).toBe(1);
    expect(late.maxInFlight).toBe(1);
    const lateDev = late.records.filter((r) => r.mode === 'ONLY_ON_DEVICE');
    expect(lateDev[0]!.status).toBe('denied_start');
    expect(lateDev.slice(1).every((r) => r.status === 'completed' && r.confounders.length === 0)).toBe(true);
    // The timeout entry is superseded by the late one, so a download sum counts only one of them.
    expect(late.setupLedger.filter((e) => e.route === 'ONLY_ON_DEVICE').map((e) => [e.errorCode, e.outcome, e.superseded])).toEqual([['setup_timeout', 'failed', true], [null, 'ready', false]]);
    // Round 3: a late result that is not ready is not cached: setup gets one more bounded try once the first has settled, and is then final.
    let tries = 0;
    const { adapter: inner } = bench();
    const failing: RouteAdapter = {
      ...inner,
      async setup(route) {
        if (route === 'ONLY_IN_CLOUD') return inner.setup(route);
        tries += 1;
        await new Promise((r) => setTimeout(r, tries === 1 ? 150 : 0));
        return { route, availability: 'unavailable', outcome: 'unavailable', downloadMs: null, errorCode: null, clockDomain: 'browser-monotonic' };
      },
    };
    const failed = await runAssistantCohort({ manifest: c.manifest, fixtures: fixturesFor(c.manifest), adapter: failing, live: c.live, requestTimeoutMs: 100, setupTimeoutMs: 100 });
    expect(tries).toBe(2);
    expect(failed.records.filter((r) => r.mode === 'ONLY_ON_DEVICE').every((r) => r.status === 'denied_start')).toBe(true);
  });
});
