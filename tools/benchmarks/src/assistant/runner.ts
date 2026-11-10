import { mapInferenceSource } from '@selarikru/inference-firebase-web/models';
import type { BenchEnvironment, BenchGenerateResult, BenchRoute, BenchSetupResult } from '@selarikru/inference-firebase-web/bench';
import type { Manifest, Slot } from '../manifest.ts';
import type { RawRecord } from '../report.ts';
import { assertLive, NO_COST, NO_HUMAN_MINUTES, NO_OPERATIONS, NO_RESOURCES, NO_TIMINGS, plannedTrials, type LiveAuthorization, type PlannedTrial } from '../trials.ts';
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
  /** Per-request limit. A request still running then is recorded timed out. Default 120 s. */
  readonly requestTimeoutMs?: number;
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
  const { manifest: m } = o;
  if (o.live !== null) assertLive(m, 'assistant', o.live);
  const dataKind: RawRecord['dataKind'] = o.live === null ? 'simulated' : 'measured';
  const prior = (o.prior ?? []).filter((r) => r.track === 'assistant' && r.dataKind === dataKind);
  const trials = plannedTrials(m, 'assistant', prior);
  const wallNow = o.wallNow ?? (() => new Date());
  const timeoutMs = o.requestTimeoutMs ?? 120_000;
  const validate = validator(o.fixtures);
  const environment = await o.adapter.environment();
  const setupLedger: SetupLedgerEntry[] = [];
  const outputs: OutputEntry[] = [];
  const records: RawRecord[] = [];
  const ready = new Map<BenchRoute, BenchSetupResult>();
  const emit = (r: RawRecord) => { records.push(r); o.onRecord?.(r); };

  for (const trial of trials) {
    const slot = trial.slot as AssistantSlot;
    const route = slot.mode as BenchRoute;
    const fixtureId = fixtureOf(m, slot);
    const fixture = o.fixtures.fixtures.find((f) => f.id === fixtureId)!;
    const req = await composeRequest(o.fixtures, fixtureId);
    const base = baseRecord(trial, slot, route, dataKind, fixtureId, environment.sdkVersion, req.payloadSha256);
    if (o.signal?.aborted) { emit(notRun(base, 'cohort_stopped')); continue; }

    // Setup before a route's first request, timed apart and ledgered, never on a record.
    let setup = ready.get(route);
    if (setup === undefined) {
      try {
        setup = await withTimeout(o.adapter.setup(route), timeoutMs);
      } catch {
        setup = { route, availability: 'unknown', outcome: 'failed', downloadMs: null, errorCode: 'setup_timeout', clockDomain: 'browser-monotonic' };
      }
      setupLedger.push({ route, at: wallNow().toISOString(), availability: setup.availability, outcome: setup.outcome, modelDownloadMs: setup.downloadMs, errorCode: setup.errorCode, clockDomain: setup.clockDomain });
      if (setup.outcome === 'ready') ready.set(route, setup);
    }
    if (setup.outcome !== 'ready') {
      // The route cannot serve: nothing is sent, so nothing can fall back. A denied start may be retried in its slot later.
      emit({ ...base, status: 'denied_start', failures: [{ category: 'route_unavailable', detail: `${route} setup ${setup.outcome} (${setup.availability})` }] });
      continue;
    }

    const startedAt = wallNow();
    let res: BenchGenerateResult;
    try {
      res = await withTimeout(o.adapter.generate({ route, systemInstruction: req.systemInstruction, prompt: req.prompt, responseSchema: req.responseSchema }), timeoutMs);
    } catch (e) {
      const timedOut = e instanceof RequestTimeout;
      emit({
        ...ran(base, startedAt, wallNow()), status: timedOut ? 'timed_out' : 'failed',
        failures: [{ category: timedOut ? 'request_timeout' : 'bench_page_error', detail: timedOut ? `no response within ${timeoutMs} ms` : null }],
      });
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
      failures,
    });
  }
  await o.adapter.close?.();
  return { records, setupLedger, outputs, environment };
}

type Base = RawRecord;

function baseRecord(trial: PlannedTrial, slot: AssistantSlot, route: BenchRoute, dataKind: RawRecord['dataKind'], fixtureId: string, sdkVersion: string, payload: string): Base {
  return {
    dataKind, status: 'not_run', track: 'assistant', trialId: trial.trialId, mode: route, blockId: null, attemptId: trial.trialId, slotId: slot.id, slotAttempt: trial.slotAttempt,
    configuration: { candidateSha: null, inferenceDestination: route === 'ONLY_ON_DEVICE' ? 'device' : 'cloud', providerAccountReference: null, credentialMode: null, accountTier: null, cacheCondition: slot.warmup ? null : 'warm', localHost: null, cloudHost: null },
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
