import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkFileSchema, BenchmarkRecordTemplateSchema } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { manifestSha256, NO_STARTS, type Manifest, type StartRecords } from '../src/manifest.ts';
import { ExportError, ReportError, buildReport, exportResults, renderReport, type RawRecord } from '../src/report.ts';
import { REPO_ROOT, SECRET, STARTER, pairedWorkers, rawAssistant, rawWorker, resolvedManifest, started } from './fixtures.ts';

type Cohort = { manifest: Manifest; starts: StartRecords };
const AT = '2026-11-20T10:00:00.000Z';
const exported = (records: RawRecord[], c: Cohort = started()) => exportResults({ manifest: c.manifest, starts: c.starts, records, generatedAtUtc: AT });
const report = (records: RawRecord[], c: Cohort = started()) => buildReport(exported(records, c), c.manifest);
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** Every object key path in a JSON value. Arrays are leaves: their element shapes are the schema's business, not the template's. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keyPaths(v, `${prefix}.${k}`)]);
  return [];
}

describe('T8.4 export', () => {
  it('conforms to the result template: every exported record has exactly the template fields', () => {
    const template = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/benchmarks/result.template.json'), 'utf8'));
    expect(BenchmarkRecordTemplateSchema.safeParse(template).success).toBe(true);
    const file = exported([...pairedWorkers(1), rawWorker({ mode: 'H2', block: 1, status: 'denied_start' }), rawAssistant({ route: 'ONLY_IN_CLOUD', index: 0 })]);
    expect(BenchmarkFileSchema.safeParse(file).success).toBe(true);
    const templateKeys = keyPaths(template).sort();
    for (const record of file.records) {
      const keys = keyPaths(record);
      const expected = record.assistant === null ? templateKeys.filter((p) => !p.startsWith('.assistant.')) : templateKeys;
      expect(keys.sort()).toEqual(expected);
    }
  });

  it('fills every record configuration from the manifest, including denied starts', () => {
    const c = started();
    const manifest = c.manifest;
    const records = [rawWorker({ mode: 'L1', block: 1, status: 'denied_start' }), rawWorker({ mode: 'L1', block: 2, status: 'not_run' }), rawAssistant({ route: 'ONLY_ON_DEVICE', index: 0 })];
    const file = exported(records, c);
    for (const r of file.records) {
      expect(r.configuration).toMatchObject({ manifestSha256: manifestSha256(manifest), starterSha: STARTER, contractSha256: manifest.repository.contractSha256, verifierSha: manifest.repository.verifierSha, harness: 'claude-code', harnessVersion: '2.1.0' });
      expect(r.cohortId).toBe(`cohort-2026-11-${r.track}`);
      expect(r.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(file.records[0]!.configuration.codingModel).toBe('claude-sonnet-5-5');
    expect(file.records[2]!.configuration.codingModel).toBe('gemini-nano');
    expect(file.cohorts).toEqual([
      { cohortId: 'cohort-2026-11-workers', track: 'workers', plannedPerMode: 5, requiredModes: ['L1', 'C1', 'H2'], order: `seed seed-7f1e; order sha256 ${manifest.randomization.orderSha256}` },
      { cohortId: 'cohort-2026-11-assistant', track: 'assistant', plannedPerMode: 30, requiredModes: ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'], order: `seed seed-7f1e; order sha256 ${manifest.randomization.orderSha256}` },
    ]);
  });

  it('keeps one record per trial and refuses a second', () => {
    expect(() => exported([rawWorker({ mode: 'L1', block: 1 }), { ...rawWorker({ mode: 'L1', block: 2 }), trialId: 'w-b1-L1', attemptId: 'other' }])).toThrow(/one record per trial/);
  });

  it('refuses a delivery time not on the server monotonic clock', () => {
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, clockDomain: 'host-wall' })])).toThrow(/server-monotonic/);
  });

  it('refuses to export measured records before the manifest is resolved', () => {
    expect(() => exported(pairedWorkers(1), started(resolvedManifest((m) => { m.repository.starterSha = null; })))).toThrow(ExportError);
    expect(() => exported(pairedWorkers(1), started(resolvedManifest((m) => { m.cohortId = null; })))).toThrow(/cohortId/);
  });

  it('exports measured records only for a started track, under the manifest it started with', () => {
    const c = started();
    // No start for the track: refused. Simulated records need no start.
    expect(() => exported(pairedWorkers(1), { manifest: resolvedManifest(), starts: NO_STARTS })).toThrow(/cohort_not_started/);
    expect(exported(pairedWorkers(1).map((r) => ({ ...r, dataKind: 'simulated' as const })), { manifest: resolvedManifest(), starts: NO_STARTS }).records).toHaveLength(2);
    // Changed after start: refused with the same reason preflight gives.
    const changed = structuredClone(c.manifest);
    changed.environment.codingModel = 'some-other-model';
    expect(() => exported(pairedWorkers(1), { manifest: changed, starts: c.starts })).toThrow(/manifest_changed_after_start/);
    // The assistant track not having started blocks only its own records.
    const workersOnly = { manifest: { ...c.manifest, starts: { ...c.manifest.starts, assistant: null } }, starts: { ...c.starts, assistant: null } };
    expect(exported(pairedWorkers(1), workersOnly).records).toHaveLength(2);
    expect(() => exported([rawAssistant({ route: 'ONLY_IN_CLOUD', index: 0 })], workersOnly)).toThrow(/cohort_not_started/);
  });

  it('refuses a record outside the frozen order, or a slot attempt given twice', () => {
    expect(() => exported([rawWorker({ mode: 'L1', block: 6 })])).toThrow(/workers\/block-6\/L1 is not in the frozen order/);
    expect(() => exported([{ ...rawWorker({ mode: 'L1', block: 1 }), slotId: 'workers/block-1/C1' }])).toThrow(/does not match/);
    expect(() => exported([{ ...rawWorker({ mode: 'L1', block: 1 }), slotId: null, slotAttempt: null }])).toThrow(/needs its slot/);
    expect(() => exported([rawWorker({ mode: 'L1', block: 1 }), rawWorker({ mode: 'L1', block: 1, trialId: 'w-b1-L1-again' })])).toThrow(/attempt 1 twice/);
    const warm = rawAssistant({ route: 'ONLY_IN_CLOUD', index: 0, warmup: true });
    expect(() => exported([{ ...warm, assistant: { ...warm.assistant!, warmup: false } }])).toThrow(/does not match/);
  });

  it('refuses a raw record carrying a summary, or a mode the manifest does not plan', () => {
    expect(() => exported([{ ...rawWorker({ mode: 'L1', block: 1 }), medianMs: 1 } as unknown as RawRecord])).toThrow(ExportError);
    expect(() => exported([{ ...rawWorker({ mode: 'L1', block: 1 }), mode: 'L2' }])).toThrow(/not planned/);
  });
});

describe('T8.4 report', () => {
  it('computes medians from raw records only', () => {
    const records = pairedWorkers(5);
    const r = report(records);
    const l1 = r.workers.modes.find((m) => m.mode === 'L1')!;
    const l1Ms = records.filter((x) => x.mode === 'L1').map((x) => x.timings.endToEndVerifiedMs!);
    expect(l1.deliveryTime).toMatchObject({ n: 5, median: median(l1Ms), min: Math.min(...l1Ms), max: Math.max(...l1Ms), provenance: 'observed' });
    // A failing attempt's time is not in the passing median, and nothing the input claims as a summary is used.
    const four = records.filter((x) => x.blockId !== 'block-5');
    const withFail = [...four, rawWorker({ mode: 'L1', block: 5, ms: 60_000, failed: true })];
    const fourMs = four.filter((x) => x.mode === 'L1').map((x) => x.timings.endToEndVerifiedMs!);
    expect(report(withFail).workers.modes.find((m) => m.mode === 'L1')!.deliveryTime.median).toBe(median(fourMs));
    // Simulated and fixture records are never measurements: they are counted aside and change no figure.
    const withSim = [...records, rawWorker({ mode: 'L1', block: 1, ms: 1, dataKind: 'simulated', trialId: 'sim-b1-L1' })];
    const sim = report(withSim);
    expect(sim.workers.modes.find((m) => m.mode === 'L1')!.deliveryTime.median).toBe(median(l1Ms));
    expect(sim.excluded).toEqual({ simulated: 1, fixture: 0 });
    // Assistant medians: complete-response and first-output, warm-ups excluded, first output null when unavailable.
    const assistant = [0, 1, 2].map((i) => rawAssistant({ route: 'ONLY_IN_CLOUD', index: i, ms: 1000 + i * 100 })).concat(rawAssistant({ route: 'ONLY_IN_CLOUD', index: 9, ms: 5, warmup: true }));
    const cloud = report(assistant).assistant.routes.find((x) => x.mode === 'ONLY_IN_CLOUD')!;
    expect(cloud.generationComplete).toMatchObject({ n: 3, median: 1100 });
    expect(cloud.firstOutput).toMatchObject({ n: 0, median: null, provenance: 'unavailable' });
    expect(cloud.warmups).toBe(1);
  });

  it('completion rate shown beside timing', () => {
    const records = [...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4, status: 'timed_out' }), rawWorker({ mode: 'L1', block: 5, failed: true })];
    const l1 = report(records).workers.modes.find((m) => m.mode === 'L1')!;
    expect(l1.deliveryTime.completion).toEqual({ passed: 3, of: 5 });
    expect(l1.claim).toBe('On this fixture/configuration, 3 of 5 attempts passed; successful runs had median 20m 10s.');
    const text = renderReport(report(records));
    expect(text).toMatch(/L1.*3 of 5 attempts passed; median 20m 10s/);
    // A mode with nothing measured is Not measured, never a time.
    const h2 = report(records).workers.modes.find((m) => m.mode === 'H2')!;
    expect(h2.deliveryTime).toMatchObject({ n: 0, median: null, completion: { passed: 0, of: 0 } });
    expect(h2.status).toBe('Not measured');
  });

  it('every attempt is accounted for, and none is dropped', () => {
    const records = [
      rawWorker({ mode: 'L1', block: 1 }), rawWorker({ mode: 'L1', block: 2, status: 'failed' }), rawWorker({ mode: 'L1', block: 3, status: 'timed_out' }),
      rawWorker({ mode: 'L1', block: 4, status: 'cancelled' }), rawWorker({ mode: 'L1', block: 5, status: 'denied_start' }),
      rawWorker({ mode: 'L1', block: 5, status: 'not_run', trialId: 'w-b5-L1-r2', slotAttempt: 2 }),
    ];
    const l1 = report(records).workers.modes.find((m) => m.mode === 'L1')!;
    // Each slot counts once by its last attempt; the earlier attempt is superseded, and the totals add up to the records.
    expect(l1.attempts).toEqual({ planned: 5, recorded: 6, superseded: 1, passed: 1, completedFailing: 0, failed: 1, timedOut: 1, cancelled: 1, deniedStart: 0, abandoned: 0, notRun: 1, missing: 0 });
    expect(l1.superseded).toEqual([{ trialId: 'w-b5-L1', slotId: 'workers/block-5/L1', slotAttempt: 1, status: 'denied_start' }]);
    const c1 = report([rawWorker({ mode: 'C1', block: 1 })]).workers.modes.find((m) => m.mode === 'C1')!;
    expect(c1.attempts).toMatchObject({ planned: 5, recorded: 1, missing: 4 });
    expect(renderReport(report([rawWorker({ mode: 'C1', block: 1 })]))).toMatch(/C1.*4 planned attempts have no record/);
  });

  it('reconciles against the frozen order: a replacement represents its slot whatever the file order', () => {
    const base = pairedWorkers(3).map((r) => (r.trialId === 'w-b1-L1' ? { ...r, slotAttempt: 2 } : r));
    // Only an infrastructure outcome may be replaced: the original was abandoned.
    const original = rawWorker({ mode: 'L1', block: 1, trialId: 'w-b1-L1-orig', status: 'abandoned', slotAttempt: 1 });
    const first = report([original, ...base]);
    const last = report([...base, original]);
    for (const r of [first, last]) {
      const c = r.workers.comparisons.find((x) => x.id === 'L1-C1')!;
      expect(c).toMatchObject({ validPairs: 3, exploratory: false });
      const l1 = r.workers.modes.find((m) => m.mode === 'L1')!;
      expect(l1.superseded.map((s) => s.trialId)).toEqual(['w-b1-L1-orig']);
      expect(l1.attempts).toMatchObject({ recorded: 4, superseded: 1, passed: 3, completedFailing: 0 });
      // The superseded attempt's time is not in the median; its spend is in the total, and it counts in completion.
      expect(l1.deliveryTime.n).toBe(3);
      expect(l1.spend.value).toBe(6);
      expect(l1.deliveryTime.completion).toEqual({ passed: 3, of: 4 });
      expect(l1.slotCompletion).toEqual({ passed: 3, of: 3 });
    }
    expect(JSON.stringify(first)).toBe(JSON.stringify(last));
  });

  it('every attempt that ran counts towards completion and the claim, superseded ones included', () => {
    const records = [rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'abandoned' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })];
    const l1 = report(records).workers.modes.find((m) => m.mode === 'L1')!;
    expect(l1.deliveryTime.completion).toEqual({ passed: 1, of: 2 });
    expect(l1.claim).toMatch(/^On this fixture\/configuration, 1 of 2 attempts passed;/);
    // The slot-level figure sits beside it, labelled as slots.
    expect(l1.slotCompletion).toEqual({ passed: 1, of: 1 });
    expect(renderReport(report(records))).toMatch(/L1: 1 of 2 attempts passed;.*\(slots: 1 of 1 passed\)/);
    // A replacement for a not-run attempt adds nothing that ran.
    const notRun = [rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'not_run' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })];
    expect(report(notRun).workers.modes.find((m) => m.mode === 'L1')!.deliveryTime.completion).toEqual({ passed: 1, of: 1 });
    expect(report(records).workers.comparisons.find((c) => c.id === 'L1-C1')!.completion.a).toEqual({ passed: 1, of: 2 });
  });

  it('a slot is retried only after an infrastructure outcome, never after a real result', () => {
    // Probe H: timed out, then retried until it passed. Refused, so there is no best-of-N.
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'timed_out' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })]))
      .toThrow(/attempt 1 \(timed_out\) cannot be replaced/);
    // Probe H2: passed, then replaced by a failure. Refused too.
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2, failed: true })]))
      .toThrow(/attempt 1 \(completed\) cannot be replaced/);
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'failed' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })]))
      .toThrow(/attempt 1 \(failed\) cannot be replaced/);
    for (const status of ['denied_start', 'abandoned', 'not_run'] as const) {
      expect(exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a', status }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })]).records).toHaveLength(2);
    }
    // The same rule holds on a results file handed to the report.
    const c = started();
    const file = structuredClone(exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'abandoned' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 2 })], c));
    file.records[0]!.status = 'cancelled';
    expect(() => buildReport(file, c.manifest)).toThrow(/cancelled\) cannot be replaced/);
  });

  it('slot attempts run 1..n with no gaps', () => {
    // Probe G: attempts 1 and 3, with 2 dropped.
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, trialId: 'a', status: 'abandoned' }), rawWorker({ mode: 'L1', block: 1, trialId: 'b', slotAttempt: 3 })]))
      .toThrow(/attempts must run 1\.\.n with no gaps/);
    // Probe G2: a lone attempt 2.
    expect(() => exported([rawWorker({ mode: 'L1', block: 1, slotAttempt: 2 })])).toThrow(/attempts must run 1\.\.n with no gaps/);
  });

  it('a slot with no record is missing, by slot, even when a replacement makes the count look full', () => {
    const l1 = [1, 2, 3, 4].map((b) => rawWorker({ mode: 'L1', block: b, ...(b === 1 ? { status: 'denied_start' as const } : {}) })).concat(rawWorker({ mode: 'L1', block: 1, trialId: 'w-b1-L1-replacement', slotAttempt: 2 }));
    const mode = report(l1).workers.modes.find((m) => m.mode === 'L1')!;
    expect(mode.attempts).toMatchObject({ planned: 5, recorded: 5, superseded: 1, missing: 1 });
    expect(mode.missingSlots).toEqual(['workers/block-5/L1']);
    expect(renderReport(report(l1))).toMatch(/L1.*1 planned attempts have no record \(workers\/block-5\/L1\)/);
  });

  it('runs the same checks on a results file as export does, in the report and on publish', () => {
    const c = started();
    const wrongClock = structuredClone(exported(pairedWorkers(3), c));
    wrongClock.records[0]!.timings.clockDomain = 'host-wall';
    expect(() => buildReport(wrongClock, c.manifest)).toThrow(ReportError);
    expect(() => buildReport(wrongClock, c.manifest)).toThrow(/server-monotonic/);
    const dup = structuredClone(exported(pairedWorkers(3), c));
    dup.records[2] = { ...dup.records[2]!, trialId: dup.records[0]!.trialId };
    expect(() => buildReport(dup, c.manifest)).toThrow(/one record per trial/);
    const shortSha = structuredClone(exported(pairedWorkers(1), c));
    shortSha.records[0]!.configuration.candidateSha = 'ABCDEF1';
    expect(() => buildReport(shortSha, c.manifest)).toThrow(/commit SHA/);
    // The schema checks candidate SHAs on measured records only; the shared checks hold every record to it.
    const sim = rawWorker({ mode: 'L1', block: 1, dataKind: 'simulated' });
    expect(() => exported([{ ...sim, configuration: { ...sim.configuration, candidateSha: 'ABCDEF1' } }])).toThrow(/candidateSha is not a full lowercase commit SHA/);
    // A file exported under another manifest is refused against this one.
    const other = started(resolvedManifest((m) => { m.environment.codingModel = 'another-model'; }));
    expect(() => buildReport(exported(pairedWorkers(1), other), c.manifest)).toThrow(/manifest/);
  });

  it('fewer than 3 valid pairs → exploratory, no headline ratio', () => {
    const two = report(pairedWorkers(2)).workers.comparisons.find((c) => c.id === 'L1-C1')!;
    expect(two).toMatchObject({ validPairs: 2, exploratory: true, headlineRatio: null });
    expect(renderReport(report(pairedWorkers(2)))).toMatch(/L1-C1.*exploratory/i);
    // A pair with a failure is excluded and listed, never silently dropped.
    const mixed = [...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4 }), rawWorker({ mode: 'C1', block: 4, status: 'timed_out' })];
    const c = report(mixed).workers.comparisons.find((x) => x.id === 'L1-C1')!;
    expect(c.validPairs).toBe(3);
    // Planned blocks with no records are listed too, never silently dropped.
    expect(c.excludedPairs).toEqual([{ blockId: 'block-4', reason: 'C1 did not pass' }, { blockId: 'block-5', reason: 'L1 has no record' }]);
    expect(c.exploratory).toBe(false);
    expect(c.headlineRatio).toBeCloseTo(median([0, 1, 2].map((i) => (1_200_000 + i * 10_000) / (960_000 + i * 10_000))), 6);
    expect(c.completion).toEqual({ a: { passed: 4, of: 4 }, b: { passed: 3, of: 4 } });
    // A trial that used control mode, or did not record it, is not a valid pair member.
    const controlled = [...pairedWorkers(3).map((r) => (r.mode === 'L1' && r.blockId === 'block-1' ? { ...r, operations: { ...r.operations, humanIntervened: true }, humanMinutes: { ...r.humanMinutes, intervention: 2 } } : r))];
    expect(report(controlled).workers.comparisons.find((x) => x.id === 'L1-C1')).toMatchObject({ validPairs: 2, exploratory: true, headlineRatio: null });
  });

  it('unknowns stay unknown: human minutes, and unrecorded permitted actions keep a trial out of pairs', () => {
    // rawWorker records review minutes but leaves setup and scoping unrecorded: the total is unavailable, never a partial sum.
    const l1 = report(pairedWorkers(3)).workers.modes.find((m) => m.mode === 'L1')!;
    expect(l1.humanMinutes).toEqual({ value: null, provenance: 'unavailable', knownSubtotal: 6 });
    const full = pairedWorkers(3).map((r) => ({ ...r, humanMinutes: { ...r.humanMinutes, initialSetup: 0, scoping: 1, permittedAction: 0 } }));
    expect(report(full).workers.modes.find((m) => m.mode === 'L1')!.humanMinutes).toEqual({ value: 9, provenance: 'observed', knownSubtotal: 9 });
    const unrecorded = pairedWorkers(3).map((r) => (r.trialId === 'w-b2-C1' ? { ...r, operations: { ...r.operations, permittedHumanActions: null } } : r));
    const c = report(unrecorded).workers.comparisons.find((x) => x.id === 'L1-C1')!;
    expect(c).toMatchObject({ validPairs: 2, exploratory: true, headlineRatio: null });
    expect(c.excludedPairs.filter((p) => p.reason !== 'L1 has no record')).toEqual([{ blockId: 'block-2', reason: 'C1 did not record permitted human actions' }]);
  });

  it('shows permitted human actions per pair and lists a difference within a pair as a confounder', () => {
    const records = pairedWorkers(3).map((r) => (r.trialId === 'w-b1-L1' ? rawWorker({ mode: 'L1', block: 1, permittedHumanActions: 2, ms: r.timings.endToEndVerifiedMs }) : r));
    const c = report(records).workers.comparisons.find((x) => x.id === 'L1-C1')!;
    expect(c.pairs.map((p) => [p.blockId, p.permittedActions])).toEqual([['block-1', { a: 2, b: 0 }], ['block-2', { a: 0, b: 0 }], ['block-3', { a: 0, b: 0 }], ['block-4', { a: null, b: null }], ['block-5', { a: null, b: null }]]);
    expect(c.confounders).toEqual(['block-1: L1 had 2 permitted human actions outside control mode, C1 had 0.']);
    expect(renderReport(report(records))).toMatch(/L1-C1.*Confounders: block-1: L1 had 2 permitted human actions outside control mode, C1 had 0\./);
  });

  it('cost per delivered change unavailable when spend unknown', () => {
    const known = report(pairedWorkers(3)).workers.modes.find((m) => m.mode === 'L1')!;
    expect(known.costPerDeliveredChange).toMatchObject({ value: 1.5, provenance: 'observed' });
    const unknown = [...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4, status: 'failed', actualUsd: null })];
    const l1 = report(unknown).workers.modes.find((m) => m.mode === 'L1')!;
    expect(l1.costPerDeliveredChange.value).toBeNull();
    expect(l1.costPerDeliveredChange.provenance).toBe('unavailable');
    expect(l1.costPerDeliveredChange.text).toBe('Unavailable');
    expect(l1.spend.value).toBeNull();
    expect(l1.spend.knownSubtotal).toBe(4.5);
    // Estimated spend on every attempt gives an estimated figure, labelled so.
    const est = report(pairedWorkers(3).map((r) => ({ ...r, cost: { ...r.cost, platformPaidActual: null, platformPaidEstimated: 2 } })));
    expect(est.workers.modes.find((m) => m.mode === 'L1')!.costPerDeliveredChange).toMatchObject({ value: 2, provenance: 'estimated' });
    // No passing change: no denominator, so unavailable, never zero or infinite.
    const none = report([rawWorker({ mode: 'L1', block: 1, failed: true })]).workers.modes.find((m) => m.mode === 'L1')!;
    expect(none.costPerDeliveredChange).toMatchObject({ value: null, provenance: 'unavailable' });
    // Assistant spend that is never reported stays unavailable rather than zero.
    expect(report([rawAssistant({ route: 'ONLY_ON_DEVICE', index: 0 })]).assistant.routes.find((x) => x.mode === 'ONLY_ON_DEVICE')!.spend).toMatchObject({ value: null, provenance: 'unavailable' });
  });

  it('counts permitted human actions outside control mode beside the mode', () => {
    const records = pairedWorkers(3).map((r, i) => (i === 0 ? rawWorker({ mode: 'L1', block: 1, permittedHumanActions: 2, ms: r.timings.endToEndVerifiedMs }) : r));
    const r = report(records);
    expect(r.workers.modes.find((m) => m.mode === 'L1')!.permittedHumanActions).toBe(2);
    expect(r.workers.comparisons.find((c) => c.id === 'L1-C1')!.validPairs).toBe(3);
    expect(renderReport(r)).toMatch(/L1.*2 permitted human actions outside control mode/);
  });

  it('credentials redacted', () => {
    const records = [...pairedWorkers(1).map((r) => ({ ...r, configuration: { ...r.configuration, providerAccountReference: 'acct-9f8e7d', localHost: 'haz-macbook.local' } })), rawWorker({ mode: 'L1', block: 2, status: 'failed', failureDetail: `auth failed with ${SECRET} on haz-macbook.local`, account: 'acct-9f8e7d' })];
    const r = report(records);
    const out = `${JSON.stringify(r)}\n${renderReport(r)}`;
    for (const leaked of [SECRET, 'acct-9f8e7d', 'haz-macbook.local', 'arm64-laptop', 'cloud-run-x86']) expect(out).not.toContain(leaked);
    // The failure is still accounted for, by category.
    expect(r.workers.modes.find((m) => m.mode === 'L1')!.failureCategories).toEqual({ failed: 1 });
    // A secret slipped into a free-text field the report repeats (a confounder) is redacted too.
    const confounded = report([{ ...rawWorker({ mode: 'L1', block: 1 }), confounders: [`token=${SECRET}`] }]);
    expect(`${JSON.stringify(confounded)}${renderReport(confounded)}`).not.toContain(SECRET);
  });
});

describe('D6 credential mode', () => {
  it('carries the credential mode and account tier on every worker record, and refuses a worker record without its mode', () => {
    const file = exported([...pairedWorkers(1), rawWorker({ mode: 'H2', block: 1, status: 'not_run' })]);
    for (const r of file.records) expect(r.configuration).toMatchObject({ credentialMode: 'cli_login', accountTier: 'tier-2' });
    const bare = rawWorker({ mode: 'L1', block: 1 });
    expect(() => exported([{ ...bare, configuration: { ...bare.configuration, credentialMode: null } }])).toThrow(/credential mode/);
  });

  it('states the account confounder when L1 and C1 or H2 use different credential modes or account tiers', () => {
    const same = report(pairedWorkers(3));
    expect(same.workers.comparisons.find((c) => c.id === 'L1-C1')!.confounders).toEqual([]);
    const modes = report([...pairedWorkers(3).map((r) => (r.mode === 'C1' ? { ...r, configuration: { ...r.configuration, credentialMode: 'api_key' as const } } : r))]);
    const c = modes.workers.comparisons.find((x) => x.id === 'L1-C1')!;
    // M7: both sides worded alike, and the tier labelled as declared in the manifest, not observed.
    expect(c.confounders).toContain('account confounder: L1 ran with credential mode cli_login on account tier tier-2 (declared); C1 ran with credential mode api_key on account tier tier-2 (declared). Not an isolated placement comparison.');
    expect(renderReport(modes)).toMatch(/account confounder/);
    const tiers = report([...pairedWorkers(3).map((r) => (r.mode === 'C1' ? { ...r, configuration: { ...r.configuration, accountTier: 'tier-4' } } : r))]);
    expect(tiers.workers.comparisons.find((x) => x.id === 'L1-C1')!.confounders.join(' ')).toMatch(/account confounder: L1 ran with credential mode cli_login on account tier tier-2 \(declared\); C1 ran with credential mode cli_login on account tier tier-4 \(declared\)/);
  });
});
