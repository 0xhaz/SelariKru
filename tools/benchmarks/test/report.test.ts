import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkFileSchema, BenchmarkRecordTemplateSchema } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { ExportError, buildReport, exportResults, renderReport, type RawRecord } from '../src/report.ts';
import { REPO_ROOT, SECRET, STARTER, pairedWorkers, rawAssistant, rawWorker, resolvedManifest } from './fixtures.ts';

const MANIFEST_SHA = 'e'.repeat(64);
const AT = '2026-11-20T10:00:00.000Z';
const exported = (records: RawRecord[], manifest = resolvedManifest()) => exportResults({ manifest, manifestSha256: MANIFEST_SHA, records, generatedAtUtc: AT });
const report = (records: RawRecord[], manifest = resolvedManifest()) => buildReport(exported(records, manifest), manifest);
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
    const manifest = resolvedManifest();
    const file = exported([rawWorker({ mode: 'L1', block: 1, status: 'denied_start' }), rawWorker({ mode: 'L1', block: 2, status: 'not_run' }), rawAssistant({ route: 'ONLY_ON_DEVICE', index: 0 })], manifest);
    for (const r of file.records) {
      expect(r.configuration).toMatchObject({ manifestSha256: MANIFEST_SHA, starterSha: STARTER, contractSha256: manifest.repository.contractSha256, verifierSha: manifest.repository.verifierSha, harness: 'claude-code', harnessVersion: '2.1.0' });
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
    expect(() => exported(pairedWorkers(1), resolvedManifest((m) => { m.repository.starterSha = null; }))).toThrow(ExportError);
    expect(() => exported(pairedWorkers(1), resolvedManifest((m) => { m.cohortId = null; }))).toThrow(/cohortId/);
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
    const withFail = [...records, rawWorker({ mode: 'L1', block: 6, ms: 60_000, failed: true })];
    expect(report(withFail).workers.modes.find((m) => m.mode === 'L1')!.deliveryTime.median).toBe(median(l1Ms));
    // Simulated and fixture records are never measurements: they are counted aside and change no figure.
    const withSim = [...records, rawWorker({ mode: 'L1', block: 7, ms: 1, dataKind: 'simulated' })];
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
    const records = [rawWorker({ mode: 'L1', block: 1 }), rawWorker({ mode: 'L1', block: 2, status: 'failed' }), rawWorker({ mode: 'L1', block: 3, status: 'timed_out' }), rawWorker({ mode: 'L1', block: 4, status: 'cancelled' }), rawWorker({ mode: 'L1', block: 5, status: 'not_run' }), rawWorker({ mode: 'L1', block: 6, status: 'denied_start' })];
    const l1 = report(records).workers.modes.find((m) => m.mode === 'L1')!;
    expect(l1.attempts).toEqual({ planned: 5, recorded: 6, passed: 1, completedFailing: 0, failed: 1, timedOut: 1, cancelled: 1, deniedStart: 1, abandoned: 0, notRun: 1, missing: 0 });
    const c1 = report([rawWorker({ mode: 'C1', block: 1 })]).workers.modes.find((m) => m.mode === 'C1')!;
    expect(c1.attempts).toMatchObject({ planned: 5, recorded: 1, missing: 4 });
    expect(renderReport(report([rawWorker({ mode: 'C1', block: 1 })]))).toMatch(/C1.*4 planned attempts have no record/);
  });

  it('fewer than 3 valid pairs → exploratory, no headline ratio', () => {
    const two = report(pairedWorkers(2)).workers.comparisons.find((c) => c.id === 'L1-C1')!;
    expect(two).toMatchObject({ validPairs: 2, exploratory: true, headlineRatio: null });
    expect(renderReport(report(pairedWorkers(2)))).toMatch(/L1-C1.*exploratory/i);
    // A pair with a failure is excluded and listed, never silently dropped.
    const mixed = [...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4 }), rawWorker({ mode: 'C1', block: 4, status: 'timed_out' })];
    const c = report(mixed).workers.comparisons.find((x) => x.id === 'L1-C1')!;
    expect(c.validPairs).toBe(3);
    expect(c.excludedPairs).toEqual([{ blockId: 'block-4', reason: 'C1 did not pass' }]);
    expect(c.exploratory).toBe(false);
    expect(c.headlineRatio).toBeCloseTo(median([0, 1, 2].map((i) => (1_200_000 + i * 10_000) / (960_000 + i * 10_000))), 6);
    expect(c.completion).toEqual({ a: { passed: 4, of: 4 }, b: { passed: 3, of: 4 } });
    // A trial that used control mode, or did not record it, is not a valid pair member.
    const controlled = [...pairedWorkers(3).map((r) => (r.mode === 'L1' && r.blockId === 'block-1' ? { ...r, operations: { ...r.operations, humanIntervened: true }, humanMinutes: { ...r.humanMinutes, intervention: 2 } } : r))];
    expect(report(controlled).workers.comparisons.find((x) => x.id === 'L1-C1')).toMatchObject({ validPairs: 2, exploratory: true, headlineRatio: null });
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
