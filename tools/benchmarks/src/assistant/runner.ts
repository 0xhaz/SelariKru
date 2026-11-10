import { mapInferenceSource } from '@selarikru/inference-firebase-web/models';
import type { BenchEnvironment, BenchGenerateResult, BenchRoute, BenchSetupResult } from '@selarikru/inference-firebase-web/bench';
import type { Manifest, Slot } from '../manifest.ts';
import type { RawRecord } from '../report.ts';
import { assertLive, LiveRefusedError, NO_COST, NO_HUMAN_MINUTES, NO_OPERATIONS, NO_RESOURCES, NO_TIMINGS, plannedTrials, type LiveAuthorization, type PlannedTrial } from '../trials.ts';
import { composeRequest, type BriefFixtures } from './payload.ts';
import type { RouteAdapter } from './route.ts';
import { validator } from './validate.ts';

/**
 * Track A: the assistant's on-device and cloud routes, through the bench page. The runner owns the experiment: the
 * frozen order and seed (from the manifest), the payload and its hash, validation and the records. It sends each
 * request on its own, with no conversation history, in the frozen order: the excluded warm-ups first, then the
 * measured requests of both routes interleaved.
 *
 * - The observed source is the response's `inferenceSource`. A source other than the route's, or none, is a routing
 *   failure: the attempt is kept and failed, with the observed source recorded (null when unknown).
 * - First-output time is null when the call does not stream; it is never replaced by the total.
 * - Model download and setup go in a separate ledger, never on a timed record; warm-ups are records flagged as such,
 *   which the report excludes from timing.
 * - Every attempt is kept, failures included. Unreported device usage stays null; bytes are bytes, never tokens.
 */

const EXPECTED: Readonly<Record<BenchRoute, string>> = { ONLY_ON_DEVICE: 'on_device', ONLY_IN_CLOUD: 'in_cloud' };

/** A separate ledger: setup and download per route, kept out of every timing figure. */
export interface SetupLedgerEntry {
  readonly route: BenchRoute;
  readonly at: string;
  readonly availability: BenchSetupResult['availability'];
  readonly outcome: BenchSetupResult['outcome'];
  readonly modelDownloadMs: number | null;
  readonly errorCode: string | null;
  readonly clockDomain: string;
}

/** Output text per trial, for the route-blinded human review. Synthetic fixtures only; never published. */
export interface OutputEntry {
  readonly trialId: string;
  readonly fixtureId: string;
  readonly text: string | null;
}

export interface AssistantCohortOptions {
  readonly manifest: Manifest;
  readonly fixtures: BriefFixtures;
  readonly adapter: RouteAdapter;
  readonly prior?: readonly RawRecord[];
  /** Null: a dry run, recorded as simulated. */
  readonly live: LiveAuthorization | null;
  /** Per-request limit. A request still running then is recorded timed out, and the next waits for it to settle. Default 120 s. */
  readonly requestTimeoutMs?: number;
  /** Per-route setup limit (a device model download). Default: the manifest's `assistant.setupTimeoutSeconds`. */
  readonly setupTimeoutMs?: number;
  /** Aborted by the operator: the rest of the cohort is recorded not run. */
  readonly signal?: AbortSignal;
  readonly onRecord?: (r: RawRecord) => void;
  readonly wallNow?: () => Date;
}

export interface AssistantCohortResult {
  readonly records: readonly RawRecord[];
  readonly setupLedger: readonly SetupLedgerEntry[];
  readonly outputs: readonly OutputEntry[];
  readonly environment: BenchEnvironment;
}

type AssistantSlot = Extract<Slot, { track: 'assistant' }>;

/** A warm-up slot names no fixture; it sends the fixture its number picks, in fixture order. */
const fixtureOf = (m: Manifest, slot: AssistantSlot): string =>
  slot.warmup ? m.assistant.fixtureIds[(Number(slot.id.split('/').at(-1)) - 1) % m.assistant.fixtureIds.length]! : slot.fixtureId;

class RequestTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RequestTimeout()), ms); })]).finally(() => clearTimeout(timer));
}

export async function runAssistantCohort(o: AssistantCohortOptions): Promise<AssistantCohortResult> {
  // M4: whatever happens after the adapter exists, it is closed (for a CDP connection, a disconnect).
  try {
    return await runCohort(o);
  } finally {
    await o.adapter.close?.().catch(() => undefined);
  }
}

/** M5: the bench page must be the pinned configuration. Each difference is a named blocker. */
function environmentIssues(m: Manifest, env: BenchEnvironment): string[] {
  const a = m.assistant;
  const pinned: [string, string | null, string | null][] = [['sdkVersion', a.sdkVersion, env.sdkVersion], ['cloudModel', a.cloudModel, env.cloudModel], ['origin', a.origin, env.origin]];
  return pinned.filter(([, want, got]) => want !== got).map(([field]) => `bench_environment_mismatch: ${field}`);
}

class TransportFailure extends Error {}

async function runCohort(o: AssistantCohortOptions): Promise<AssistantCohortResult> {
  const { manifest: m } = o;
  if (o.live !== null) assertLive(m, 'assistant', o.live);
  const dataKind: RawRecord['dataKind'] = o.live === null ? 'simulated' : 'measured';
  const prior = (o.prior ?? []).filter((r) => r.track === 'assistant' && r.dataKind === dataKind);
  const trials = plannedTrials(m, 'assistant', prior);
  const wallNow = o.wallNow ?? (() => new Date());
  const timeoutMs = o.requestTimeoutMs ?? 120_000;
  // M3: a device model download can take many minutes; setup has its own bound from the manifest.
  const setupTimeoutMs = o.setupTimeoutMs ?? m.assistant.setupTimeoutSeconds * 1000;
  const validate = validator(o.fixtures);
  const environment = await o.adapter.environment();
  if (o.live !== null) {
    const issues = environmentIssues(m, environment);
    if (issues.length > 0) throw new LiveRefusedError(issues);
  }
  const setupLedger: SetupLedgerEntry[] = [];
  const outputs: OutputEntry[] = [];
  const records: RawRecord[] = [];
  const ready = new Map<BenchRoute, BenchSetupResult>();
  const emit = (r: RawRecord) => { records.push(r); o.onRecord?.(r); };
  /** I2 and N1: routes whose request or setup never settled after timing out. Their remaining slots are not run; any later sample may overlap that call. */
  const stalled = new Set<BenchRoute>();
  let transportFailed = false;

  for (const trial of trials) {
    const slot = trial.slot as AssistantSlot;
    const route = slot.mode as BenchRoute;
    const fixtureId = fixtureOf(m, slot);
    const fixture = o.fixtures.fixtures.find((f) => f.id === fixtureId)!;
    const req = await composeRequest(o.fixtures, fixtureId);
    const base = baseRecord(trial, slot, route, dataKind, fixtureId, environment.sdkVersion, req.payloadSha256);
    if (o.signal?.aborted || transportFailed) { emit(notRun(base, 'cohort_stopped')); continue; }
    if (stalled.has(route)) { emit({ ...notRun(base, 'route_stalled'), failures: [{ category: 'route_stalled', detail: 'an earlier request on this route never settled, so nothing more was sent on it' }] }); continue; }
    const overlapNote = stalled.size > 0 ? [`overlapped_in_flight_call: a stalled ${[...stalled].join(', ')} call or setup may still be running in the page`] : [];

    try {
      // Setup before a route's first request, timed apart and ledgered, never on a record.
      let setup = ready.get(route);
      if (setup === undefined) {
        const call = o.adapter.setup(route);
        const done = await transport(call, setupTimeoutMs).catch((e: unknown) => { if (e instanceof RequestTimeout) return null; throw e; });
        if (done === null) {
          setupLedger.push({ route, at: wallNow().toISOString(), availability: 'unknown', outcome: 'failed', modelDownloadMs: null, errorCode: 'setup_timeout', clockDomain: 'browser-monotonic' });
          emit({ ...base, status: 'denied_start', failures: [{ category: 'route_unavailable', detail: `${route} setup did not finish within ${setupTimeoutMs} ms` }], confounders: overlapNote });
          // N1: never start setup again while this one may still be running (a download keeps going in the page). Wait for it, bounded.
          const late = await Promise.race([
            call.then((r): BenchSetupResult => r, (): BenchSetupResult => ({ route, availability: 'unknown', outcome: 'failed', downloadMs: null, errorCode: 'setup_failed_late', clockDomain: 'browser-monotonic' })),
            new Promise<'pending'>((r) => setTimeout(() => r('pending'), 2 * setupTimeoutMs)),
          ]);
          if (late === 'pending') stalled.add(route);
          else {
            setupLedger.push({ route, at: wallNow().toISOString(), availability: late.availability, outcome: late.outcome, modelDownloadMs: late.downloadMs, errorCode: late.errorCode, clockDomain: late.clockDomain });
            // Its result stands for the route from here on: setup is not run a second time.
            ready.set(route, late);
          }
          continue;
        }
        setup = done;
        setupLedger.push({ route, at: wallNow().toISOString(), availability: setup.availability, outcome: setup.outcome, modelDownloadMs: setup.downloadMs, errorCode: setup.errorCode, clockDomain: setup.clockDomain });
        if (setup.outcome === 'ready') ready.set(route, setup);
      }
      if (setup.outcome !== 'ready') {
        // The route cannot serve: nothing is sent, so nothing can fall back. A denied start may be retried in its slot later.
        emit({ ...base, status: 'denied_start', failures: [{ category: 'route_unavailable', detail: `${route} setup ${setup.outcome} (${setup.availability})` }] });
        continue;
      }

      const startedAt = wallNow();
      const call = o.adapter.generate({ route, systemInstruction: req.systemInstruction, prompt: req.prompt, responseSchema: req.responseSchema, dataClassification: o.fixtures.dataClassification });
      let res: BenchGenerateResult;
      try {
        res = await transport(call, timeoutMs);
      } catch (e) {
        if (!(e instanceof RequestTimeout)) throw e;
        emit({ ...ran(base, startedAt, wallNow()), status: 'timed_out', failures: [{ category: 'request_timeout', detail: `no response within ${timeoutMs} ms` }], confounders: overlapNote });
        // I2: never send the next request while this one may still be running in the page.
        const settled = await Promise.race([call.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2 * timeoutMs))]);
        if (!settled) stalled.add(route);
        continue;
      }
      outputs.push({ trialId: trial.trialId, fixtureId, text: res.text });
      const observed = mapInferenceSource(res.inferenceSource);
      const routedCorrectly = res.outcome === 'ok' && res.inferenceSource === EXPECTED[route];
      const validation = res.outcome === 'ok' ? validate(fixture, res.text) : null;
      const failures: RawRecord['failures'] = [];
      if (res.outcome === 'error') failures.push({ category: 'generation_error', detail: res.errorCode });
      else if (!routedCorrectly) failures.push({ category: 'routing_failure', detail: res.inferenceSource === null ? 'no inference source reported' : `observed ${observed === 'UNKNOWN' ? 'an unknown source' : observed} for ${route}` });
      for (const f of validation?.failures ?? []) failures.push({ category: f, detail: null });
      const reportedUsage = res.usage;
      const record = ran(base, startedAt, wallNow());
      emit({
        ...record,
        status: res.outcome === 'error' || !routedCorrectly ? 'failed' : 'completed',
        assistant: {
          ...record.assistant!, observedInferenceSource: observed === 'UNKNOWN' ? null : observed, schemaValid: validation?.schemaValid ?? null,
          providerInputTokens: reportedUsage?.inputTokens ?? null, providerOutputTokens: reportedUsage?.outputTokens ?? null,
          inputBytes: req.inputBytes, outputBytes: res.text === null ? null : Buffer.byteLength(res.text, 'utf8'),
        },
        timings: {
          ...record.timings, clockDomain: res.clockDomain,
          // Null when the call did not stream: never the total in its place.
          firstOutputMs: res.streaming ? res.firstOutputMs : null,
          generationCompleteMs: res.generationCompleteMs,
        },
        resources: {
          ...record.resources,
          providerUsageByRole: reportedUsage && reportedUsage.inputTokens !== null && reportedUsage.outputTokens !== null
            ? [{ role: 'assistant', inputTokens: reportedUsage.inputTokens, outputTokens: reportedUsage.outputTokens, cacheTokens: null, provenance: 'observed', source: 'firebase_ai_logic_usage_metadata' }] : [],
          usageCoverage: reportedUsage ? 'partial' : 'none',
        },
        failures, confounders: overlapNote,
      });
    } catch (e) {
      if (!(e instanceof TransportFailure)) throw e;
      // I3: the bridge or the CDP link failed. That is infrastructure, not a sample: this slot is abandoned and the cohort stops.
      transportFailed = true;
      emit({ ...base, status: 'abandoned', failures: [{ category: 'bench_transport_failure', detail: null }] });
    }
  }
  return { records, setupLedger, outputs, environment };
}

/** A bounded call to the page: a timeout is `RequestTimeout`; any rejection from the bridge or the CDP link is a `TransportFailure`. Its message is never kept. */
function transport<T>(p: Promise<T>, ms: number): Promise<T> {
  return withTimeout(p, ms).catch((e: unknown) => { throw e instanceof RequestTimeout ? e : new TransportFailure(); });
}

type Base = RawRecord;

function baseRecord(trial: PlannedTrial, slot: AssistantSlot, route: BenchRoute, dataKind: RawRecord['dataKind'], fixtureId: string, sdkVersion: string, payload: string): Base {
  return {
    dataKind, status: 'not_run', track: 'assistant', trialId: trial.trialId, mode: route, blockId: null, attemptId: trial.trialId, slotId: slot.id, slotAttempt: trial.slotAttempt,
    configuration: { candidateSha: null, inferenceDestination: route === 'ONLY_ON_DEVICE' ? 'device' : 'cloud', providerAccountReference: null, credentialMode: null, accountTier: null, credentialPath: null, agentState: null, cacheCondition: slot.warmup ? null : 'warm', localHost: null, cloudHost: null },
    assistant: {
      fixtureId, requestedMode: route, observedInferenceSource: null, sdkVersion, schemaValid: null, warmup: slot.warmup, payloadSha256: payload,
      semanticReview: { reviewer: null, routeLabelHidden: null, retainedFacts: null, missingFacts: null, inventedRequirements: null },
      providerInputTokens: null, providerOutputTokens: null, inputBytes: null, outputBytes: null,
    },
    timings: NO_TIMINGS, resources: NO_RESOURCES, cost: NO_COST, humanMinutes: NO_HUMAN_MINUTES,
    quality: { allRequiredChecksPassed: null, criteria: [], withinDeclaredLimits: null }, operations: NO_OPERATIONS,
    failures: [], confounders: [], artifactReferences: [],
  };
}

const notRun = (b: Base, category: string): RawRecord => ({ ...b, failures: [{ category, detail: null }] });

/** The parts every request that was sent carries. */
function ran(b: Base, startedAt: Date, endedAt: Date): RawRecord {
  return {
    ...b,
    timings: { ...NO_TIMINGS, clockDomain: 'browser-monotonic', startedAtUtc: startedAt.toISOString(), endedAtUtc: endedAt.toISOString() },
    operations: { ...NO_OPERATIONS, humanIntervened: false, permittedHumanActions: 0 },
    artifactReferences: [`#/benchmark?trial=${encodeURIComponent(b.trialId)}`],
  };
}
