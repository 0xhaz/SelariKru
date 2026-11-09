import { describe, expect, it } from 'vitest';
import { buildBenchmark, MIN_ATTEMPTS_PER_MODE, type Comparison, type Figure, type WorkerCohortView } from './model.ts';
import { BenchmarkFileSchema, MAX_RESULTS_CHARS, loadBenchmark, type BenchmarkFile, type BenchmarkLoad } from './schema.ts';
import { assistantCohort, assistantRecord, benchmarkFile, completeAssistant, completeWorkers, workerCohort, workerRecord } from './testing.ts';

const ok = (file: BenchmarkFile): BenchmarkLoad => ({ kind: 'ok', file: BenchmarkFileSchema.parse(file) });
const workersOf = (file: BenchmarkFile): WorkerCohortView => buildBenchmark(ok(file)).workers.measured[0]!;
const comparison = (cohort: WorkerCohortView, id: string): Comparison => cohort.comparisons.find((c) => c.id === id)!;
const reasonsOf = (c: Comparison): string => (c.verdict.kind === 'none' ? c.verdict.reasons.join(' | ') : '');

function allFigures(value: unknown): Figure[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(allFigures);
  const v = value as Record<string, unknown>;
  if (typeof v.text === 'string' && 'provenance' in v && 'basis' in v) return [v as unknown as Figure];
  return Object.values(v).flatMap(allFigures);
}

describe('the results file', () => {
  it('is strict: an unknown field refuses the whole file', () => {
    const file = benchmarkFile({ records: completeWorkers('measured') });
    const bad = { ...file, records: [{ ...file.records[0]!, bonus: 1 }, ...file.records.slice(1)] };
    expect(BenchmarkFileSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses a record contradicting itself about what it is', () => {
    const measured = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    expect(BenchmarkFileSchema.safeParse(benchmarkFile({ records: [{ ...measured, measuredResultsPresent: false }] })).success).toBe(false);
    const simulated = workerRecord({ mode: 'L1', index: 0, dataKind: 'simulated' });
    expect(BenchmarkFileSchema.safeParse(benchmarkFile({ records: [{ ...simulated, measuredResultsPresent: true }] })).success).toBe(false);
  });

  it('refuses unavailable usage carrying a zero, because unknown is never zero', () => {
    const record = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', usage: [{ role: 'coding', inputTokens: 0, outputTokens: null, cacheTokens: null, provenance: 'unavailable', source: null }] });
    expect(BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success).toBe(false);
  });

  it('refuses a record for an undeclared cohort, a cohort with no target, or a repeated attempt', () => {
    const record = workerRecord({ mode: 'L1', index: 0 });
    expect(BenchmarkFileSchema.safeParse(benchmarkFile({ cohorts: [assistantCohort()], records: [record] })).success).toBe(false);
    expect(BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record, record] })).success).toBe(false);
    expect(BenchmarkFileSchema.safeParse({ ...benchmarkFile({ records: [] }), cohorts: [{ ...workerCohort(), plannedPerMode: 0 }] }).success).toBe(false);
  });

  it('refuses a flag that disagrees with the criteria, and anything but exactly FB-01 to FB-08', () => {
    const passing = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const refused = (record: typeof passing): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...passing, quality: { ...passing.quality, allRequiredChecksPassed: false } })).toBe(true);
    expect(refused({ ...passing, quality: { ...passing.quality, allRequiredChecksPassed: null } })).toBe(true);
    const failing = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', failedCriteria: ['FB-03'] });
    expect(refused({ ...failing, quality: { ...failing.quality, allRequiredChecksPassed: true } })).toBe(true);
    expect(refused({ ...passing, quality: { ...passing.quality, criteria: passing.quality.criteria.slice(1) } })).toBe(true);
    expect(refused({ ...passing, quality: { ...passing.quality, criteria: [...passing.quality.criteria, { id: 'FB-09', status: 'passed', evidenceReferences: ['x'] }] } })).toBe(true);
  });

  it('refuses any number on an attempt that did not run', () => {
    const notRun = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', status: 'not_run' });
    const refused = (record: typeof notRun): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...notRun, timings: { ...notRun.timings, queueMs: 0 } })).toBe(true);
    expect(refused({ ...notRun, cost: { ...notRun.cost, platformPaidEstimated: 0 } })).toBe(true);
    expect(refused({ ...notRun, resources: { ...notRun.resources, requestedVcpus: 2 } })).toBe(true);
  });

  it('refuses a value with no provenance or source', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const refused = (record: typeof r): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...r, resources: { ...r.resources, workerHoursProvenance: 'unavailable', workerHoursSource: null } })).toBe(true);
    expect(refused({ ...r, humanMinutes: { ...r.humanMinutes, source: null } })).toBe(true);
    expect(refused({ ...r, cost: { ...r.cost, localHardwareEnergyCost: 0 } })).toBe(true);
  });

  it('a measured record that ran must carry what would let someone check it', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const refused = (record: typeof r): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...r, configuration: { ...r.configuration, candidateSha: null } })).toBe(true);
    expect(refused({ ...r, configuration: { ...r.configuration, manifestSha256: null } })).toBe(true);
    expect(refused({ ...r, timings: { ...r.timings, clockDomain: null } })).toBe(true);
    expect(refused({ ...r, artifactReferences: [] })).toBe(true);
    expect(refused({ ...r, resultSha256: null })).toBe(true);
    expect(refused({ ...r, quality: { ...r.quality, criteria: r.quality.criteria.map((c) => ({ ...c, evidenceReferences: [] })) } })).toBe(true);
  });

  it('evidence must be in a form a reader can open, on a commit-shaped and unreused candidate with a unique result hash', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const other = workerRecord({ mode: 'C1', index: 0, dataKind: 'measured' });
    const refused = (...records: (typeof r)[]): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records })).success;
    expect(refused(r, other)).toBe(false);
    expect(refused({ ...r, artifactReferences: ['file:///tmp/x'] })).toBe(true);
    expect(refused({ ...r, artifactReferences: [''] })).toBe(true);
    expect(refused({ ...r, quality: { ...r.quality, criteria: r.quality.criteria.map((c) => ({ ...c, evidenceReferences: ['see notes'] })) } })).toBe(true);
    expect(refused({ ...r, configuration: { ...r.configuration, candidateSha: 'not-a-sha' } })).toBe(true);
    expect(refused(r, { ...other, resultSha256: r.resultSha256 })).toBe(true);
    expect(refused(r, { ...other, configuration: { ...other.configuration, candidateSha: r.configuration.candidateSha } })).toBe(true);
    const unsupported = benchmarkFile({ assistantEvidence: [{ id: 'schema_validation', status: 'recorded', dataKind: 'measured', references: [] }] });
    expect(BenchmarkFileSchema.safeParse(unsupported).success).toBe(false);
  });

  it.each(['failed', 'timed_out', 'cancelled', 'denied_start', 'abandoned'] as const)('a %s attempt that never reached verification is kept with no candidate or artifact', (status) => {
    const honest = { ...workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', status, ms: null }), artifactReferences: [] };
    const record = { ...honest, configuration: { ...honest.configuration, candidateSha: null }, timings: { ...honest.timings, clockDomain: null } };
    const parsed = BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] }));
    expect(parsed.success).toBe(true);
    expect(workersOf(parsed.data!).attempts).toHaveLength(1);
  });

  it('a completed attempt, or one with a judged criterion, still needs its candidate and artifact', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', failedCriteria: ['FB-01'] });
    const refused = (record: typeof r): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...r, configuration: { ...r.configuration, candidateSha: null } })).toBe(true);
    expect(refused({ ...r, artifactReferences: [] })).toBe(true);
    expect(refused({ ...r, status: 'failed', configuration: { ...r.configuration, candidateSha: null } })).toBe(true);
  });

  it('a candidate on any record must be SHA-shaped, and a denied start may link its denial record', () => {
    const denied = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', status: 'denied_start', ms: null });
    const parse = (record: typeof denied): boolean => BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(parse({ ...denied, configuration: { ...denied.configuration, candidateSha: 'not-a-sha' } })).toBe(false);
    expect(parse({ ...denied, artifactReferences: ['#/decisions?card=denied-1'] })).toBe(true);
    expect(parse({ ...denied, artifactReferences: ['notes.txt'] })).toBe(false);
  });

  it('one candidate may repeat inside a trial, not across trials, and a no-change attempt on the starter is exempt', () => {
    const a = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const b = workerRecord({ mode: 'L1', index: 1, dataKind: 'measured' });
    const candidate = a.configuration.candidateSha!;
    const shared = { ...b, configuration: { ...b.configuration, candidateSha: candidate } };
    const parse = (...records: (typeof a)[]): boolean => BenchmarkFileSchema.safeParse(benchmarkFile({ records })).success;
    expect(parse(a, { ...shared, trialId: a.trialId })).toBe(true);
    expect(parse(a, shared)).toBe(false);
    const starter = 'd'.repeat(40);
    const onStarter = (r: typeof a): typeof a => ({ ...r, configuration: { ...r.configuration, starterSha: starter, candidateSha: starter } });
    expect(parse(onStarter(a), onStarter(b))).toBe(true);
  });

  it('refuses a record saying no person intervened while logging intervention or correction minutes', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const refused = (record: typeof r): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...r, humanMinutes: { ...r.humanMinutes, intervention: 3 } })).toBe(true);
    expect(refused({ ...r, humanMinutes: { ...r.humanMinutes, correction: 1 } })).toBe(true);
    expect(refused({ ...r, operations: { ...r.operations, humanIntervened: true }, humanMinutes: { ...r.humanMinutes, intervention: 3 } })).toBe(false);
  });

  it('refuses impossible timings on a passing attempt, and usage with no source', () => {
    const r = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured' });
    const refused = (record: typeof r): boolean => !BenchmarkFileSchema.safeParse(benchmarkFile({ records: [record] })).success;
    expect(refused({ ...r, timings: { ...r.timings, endToEndVerifiedMs: null } })).toBe(true);
    expect(refused({ ...r, timings: { ...r.timings, endToEndVerifiedMs: 0 } })).toBe(true);
    const a = assistantRecord({ route: 'ONLY_IN_CLOUD', index: 0, dataKind: 'measured' });
    expect(refused({ ...a, timings: { ...a.timings, firstOutputMs: 5000, generationCompleteMs: 1000 } })).toBe(true);
    expect(refused({ ...r, resources: { ...r.resources, providerUsageByRole: [{ role: 'coding', inputTokens: 1, outputTokens: 1, cacheTokens: null, provenance: 'observed', source: null }] } })).toBe(true);
  });

  it('a template record with no measurements is accepted only as not run', () => {
    const file = benchmarkFile({ records: [workerRecord({ mode: 'L1', index: 0, status: 'not_run', dataKind: 'measured' })] });
    expect(BenchmarkFileSchema.safeParse(file).success).toBe(true);
  });
});

describe('loading the file', () => {
  const respond = (status: number, type: string, body: string): typeof fetch => async () => new Response(body, { status, headers: { 'content-type': type } });
  it('a missing file reads as absent', async () => {
    await expect(loadBenchmark('x', respond(404, 'text/plain', 'no'))).resolves.toEqual({ kind: 'absent' });
  });
  it("a host's HTML fallback page reads as absent, not as an error", async () => {
    await expect(loadBenchmark('x', respond(200, 'text/html', '<!doctype html>'))).resolves.toEqual({ kind: 'absent' });
    await expect(loadBenchmark('x', respond(200, 'application/json', '<!DOCTYPE html><html></html>'))).resolves.toEqual({ kind: 'absent' });
  });
  it('anything that is not HTML parses or is refused, whatever its content type', async () => {
    await expect(loadBenchmark('x', respond(200, 'text/plain', 'garbage'))).resolves.toMatchObject({ kind: 'invalid' });
    await expect(loadBenchmark('x', respond(200, 'text/plain', JSON.stringify(benchmarkFile({}))))).resolves.toMatchObject({ kind: 'ok' });
  });
  it('a body over the size limit is refused unread', async () => {
    await expect(loadBenchmark('x', respond(200, 'application/json', ' '.repeat(MAX_RESULTS_CHARS + 1)))).resolves.toMatchObject({ kind: 'invalid' });
  });
  it('a broken file is invalid and says why', async () => {
    const out = await loadBenchmark('x', respond(200, 'application/json', '{"protocolVersion":"9"}'));
    expect(out.kind).toBe('invalid');
    await expect(loadBenchmark('x', respond(200, 'application/json', 'not json'))).resolves.toMatchObject({ kind: 'invalid' });
  });
  it('a server error is unreachable, not "no results"', async () => {
    await expect(loadBenchmark('x', respond(500, 'text/plain', 'boom'))).resolves.toMatchObject({ kind: 'unreachable' });
    await expect(loadBenchmark('x', () => Promise.reject(new Error('net')))).resolves.toMatchObject({ kind: 'unreachable' });
  });
});

describe('Not measured', () => {
  it('reads "Not measured" with no results', () => {
    const model = buildBenchmark({ kind: 'absent' });
    expect(model.workers.measured).toEqual([]);
    expect(model.assistant.measured).toEqual([]);
    expect(model.workers.totals.attempts).toBe(0);
    const figures = allFigures([model.workers.placeholder, model.assistant.placeholder]);
    expect(figures.length).toBeGreaterThan(5);
    for (const f of figures) {
      expect(f.text).toBe('Not measured');
      expect(f.text + (f.detail ?? '')).not.toMatch(/\d/);
    }
    expect(model.workers.placeholder.map((r) => r.mode)).toEqual(['L1', 'C1', 'H2']);
  });

  it('a file with no measured records also reads as not measured, and an invalid one shows no numbers', () => {
    const invalid = buildBenchmark({ kind: 'invalid', issues: ['records.0: nope'] });
    expect(invalid.source).toBe('invalid');
    expect(invalid.issues).toEqual(['records.0: nope']);
    expect(invalid.workers.measured).toEqual([]);
    expect(buildBenchmark(ok(benchmarkFile({ records: [] }))).workers.totals.attempts).toBe(0);
  });
});

describe('the two tracks', () => {
  it('Assistant and Workers tabs', () => {
    const model = buildBenchmark(ok(benchmarkFile({ records: [...completeWorkers('measured'), ...completeAssistant('measured')] })));
    expect(model.workers.measured.map((c) => c.cohortId)).toEqual(['cohort-workers']);
    expect(model.assistant.measured.map((c) => c.cohortId)).toEqual(['cohort-assistant']);
    expect(model.workers.totals.attempts).toBe(15);
    expect(model.assistant.totals.attempts).toBe(60);
    expect(model.assistant.measured[0]!.rows.map((r) => r.mode)).toEqual(['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD']);
  });
});

describe('worker rows', () => {
  it('worker rows separate execution host from inference destination', () => {
    const cohort = workersOf(benchmarkFile({ records: completeWorkers('measured') }));
    const l1 = cohort.rows.find((r) => r.mode === 'L1')!;
    const c1 = cohort.rows.find((r) => r.mode === 'C1')!;
    expect(l1.executionHost.text).toBe('Local sandbox');
    expect(l1.inference.text).toBe('Model in cloud');
    expect(c1.executionHost.text).toBe('Cloud sandbox');
    expect(c1.inference.text).toBe('Model in cloud');
    expect(l1.inference.detail).toBe('claude-sonnet-5-5');
    const placeholder = buildBenchmark({ kind: 'absent' }).workers.placeholder.find((r) => r.mode === 'L1')!;
    expect(placeholder.inference.text).toBe('Not measured');
  });

  it('H2 carries a two-worker label', () => {
    const cohort = workersOf(benchmarkFile({ records: completeWorkers('measured') }));
    const h2 = cohort.rows.find((r) => r.mode === 'H2')!;
    expect(h2.workerCount).toBe(2);
    expect(h2.workerLabel).toBe('Two coding workers');
    expect(cohort.rows.find((r) => r.mode === 'L1')!.workerLabel).toBe('One coding worker');
    const c = comparison(cohort, 'H2-L1');
    expect(c.scope).toMatch(/two coding workers/i);
    expect(c.capacityNote).toMatch(/H2 has two coding workers, L1 has one/);
    expect(comparison(cohort, 'L1-C1').capacityNote).toBeNull();
    expect(buildBenchmark({ kind: 'absent' }).workers.placeholder.find((r) => r.mode === 'H2')!.workerLabel).toBe('Two coding workers');
  });

  it('failed trials stay listed', () => {
    const records = [
      ...completeWorkers('measured'),
    ];
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', status: 'failed' });
    records[1] = workerRecord({ mode: 'L1', index: 1, dataKind: 'measured', status: 'abandoned' });
    records[2] = workerRecord({ mode: 'L1', index: 2, dataKind: 'measured', status: 'timed_out' });
    const cohort = workersOf(benchmarkFile({ records }));
    const l1 = cohort.rows.find((r) => r.mode === 'L1')!;
    expect(l1.counts.failed).toBe(1);
    expect(l1.counts.abandoned).toBe(1);
    expect(l1.counts.timedOut).toBe(1);
    expect(l1.counts.passed).toBe(2);
    expect(l1.completion.text).toBe('2 of 5 passed');
    expect(cohort.attempts.filter((a) => a.mode === 'L1').map((a) => a.statusLabel).sort()).toEqual(['Abandoned', 'Failed', 'Passed', 'Passed', 'Timed out']);
    expect(cohort.attempts).toHaveLength(15);
  });

  it('completed attempts failing their checks count as failed, with the criteria named', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', failedCriteria: ['FB-03', 'FB-07'] });
    const cohort = workersOf(benchmarkFile({ records }));
    expect(cohort.rows.find((r) => r.mode === 'L1')!.counts.failed).toBe(1);
    const row = cohort.attempts.find((a) => a.attemptId === 'l1-0-measured')!;
    expect(row.statusLabel).toBe('Failed checks');
    expect(row.criteria).toBe('6 of 8 passed. Failed: FB-03, FB-07');
  });

  it('shows spread and sample size with the median, and a single attempt as a single attempt', () => {
    const cohort = workersOf(benchmarkFile({ records: completeWorkers('measured') }));
    const l1 = cohort.rows.find((r) => r.mode === 'L1')!;
    expect(l1.time.text).toBe('20m 40s median');
    expect(l1.time.detail).toBe('Range 20m 0s to 21m 20s. n=5 of 5.');
    const small = [workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 60_000 })];
    expect(workersOf(benchmarkFile({ records: small })).rows.find((r) => r.mode === 'L1')!.time).toMatchObject({ text: '1m 0s', detail: 'Single attempt, n=1. Exploratory.' });
  });

  it('labels provenance and basis on every figure, and never adds observed to estimated', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', actualUsd: null, estimatedUsd: 9 });
    const cohort = workersOf(benchmarkFile({ records }));
    const l1 = cohort.rows.find((r) => r.mode === 'L1')!;
    for (const f of allFigures(l1)) {
      expect(['observed', 'estimated', 'unavailable', 'simulated']).toContain(f.provenance);
      expect(f.basis.length).toBeGreaterThan(5);
    }
    const [actual, estimated] = l1.cost;
    expect(actual!.provenance).toBe('observed');
    expect(actual!.text).toBe('$4.80');
    expect(actual!.detail).toContain('Partial: 4 of 5 attempts');
    expect(actual!.basis).toContain('rc-2026-11');
    expect(estimated!.provenance).toBe('estimated');
    expect(estimated!.text).toBe('$14.20');
    expect(l1.cost[2]!.provenance).toBe('unavailable');
    expect(l1.cost[2]!.text).toBe('Unavailable');
    expect(l1.cost[2]!.detail).toMatch(/not zero/i);
  });

  it('usage never turns unknown into a number', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', usage: [{ role: 'coding', inputTokens: null, outputTokens: null, cacheTokens: null, provenance: 'unavailable', source: null }] });
    records[1] = workerRecord({ mode: 'L1', index: 1, dataKind: 'measured', usage: [{ role: 'coding', inputTokens: 500, outputTokens: 500, cacheTokens: null, provenance: 'estimated', source: 'rate card' }] });
    const row = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!;
    expect(row.usage.provenance).toBe('observed');
    expect(row.usage.detail).toBe('Median of 3 of 5 attempts with observed usage. 1 estimated, 1 unavailable. Coverage: complete.');
    expect(row.usage.basis).toContain('harness');
    expect(row.usage.basis).not.toContain('Provider-reported');
  });

  it('a role missing its output makes that attempt unavailable, and cache tokens are not added in', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', usage: [{ role: 'coding', inputTokens: 100, outputTokens: null, cacheTokens: null, provenance: 'observed', source: 'harness' }] });
    const row = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!;
    expect(row.usage.detail).toContain('1 unavailable');
    expect(row.usage.text).toBe('128,000 tokens median');
  });

  it('human minutes with a null part are unavailable for that attempt, never summed as zero', () => {
    const records = completeWorkers('measured');
    records[0] = { ...records[0]!, humanMinutes: { ...records[0]!.humanMinutes, review: null } };
    const row = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!;
    expect(row.human.text).toBe('8 min');
    expect(row.human.detail).toContain('Human minutes: 4 of 5 attempts. 1 unavailable.');
  });

  it('worker-hours and human minutes take their provenance and source from the record', () => {
    const records = completeWorkers('measured').map((r) => ({ ...r, resources: { ...r.resources, workerHoursProvenance: 'estimated' as const, workerHoursSource: 'billing export' } }));
    const row = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!;
    expect(row.hours[0]!.provenance).toBe('estimated');
    expect(row.hours[0]!.basis).toContain('billing export');
    expect(row.human.basis).toContain('reviewer log');
  });

  it('delivery time is withheld unless it was on a server monotonic clock', () => {
    const records = completeWorkers('measured').map((r) => ({ ...r, timings: { ...r.timings, clockDomain: 'host-wall' } }));
    const cohort = workersOf(benchmarkFile({ records }));
    expect(cohort.rows.find((r) => r.mode === 'L1')!.time.text).toBe('Withheld');
    expect(reasonsOf(comparison(cohort, 'L1-C1'))).toContain('server monotonic clock');
  });

  it('no 0 of 0: runs and planned attempts are shown instead', () => {
    const records = [0, 1, 2].map((index) => workerRecord({ mode: 'L1', index, dataKind: 'measured', humanIntervened: true, ms: 60_000 }));
    const row = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!;
    expect(row.completion.text).toBe('No comparable attempts');
    expect(row.completion.detail).toContain('3 run of 5 planned.');
  });

  it('an over-limit attempt with all checks passing does not pass and says why', () => {
    const records = completeWorkers('measured');
    records[0] = { ...records[0]!, quality: { ...records[0]!.quality, withinDeclaredLimits: false } };
    const cohort = workersOf(benchmarkFile({ records }));
    expect(cohort.attempts.find((a) => a.attemptId === 'l1-0-measured')!.statusLabel).toBe('Over limit');
    expect(cohort.rows.find((r) => r.mode === 'L1')!.completion.text).toBe('4 of 5 passed');
  });

  it('a not-run row reads not applicable for human intervention', () => {
    const records = [workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', status: 'not_run' })];
    expect(workersOf(benchmarkFile({ records })).attempts[0]!.humanLabel).toBe('Not applicable');
  });

  it('a local cost carries the provenance the record gave it', () => {
    const records = completeWorkers('measured').map((r) => ({ ...r, cost: { ...r.cost, localHardwareEnergyCost: 0, localCostProvenance: 'estimated' as const, localCostSource: 'assumed tariff' } }));
    const local = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!.cost[2]!;
    expect(local.provenance).toBe('estimated');
    expect(local.basis).toContain('assumed tariff');
  });

  it('customer-direct charges are shown apart', () => {
    const records = completeWorkers('measured').map((r) => ({ ...r, cost: { ...r.cost, customerDirectActual: 0.5 } }));
    const direct = workersOf(benchmarkFile({ records })).rows.find((r) => r.mode === 'L1')!.cost[3]!;
    expect(direct.text).toBe('$2.50');
    expect(direct.basis).toContain('Customer-direct');
  });
});

describe('the winner badge', () => {
  const complete = (): BenchmarkFile => benchmarkFile({ records: completeWorkers('measured') });

  it('a complete matched cohort with clearly separated timing can have a winner', () => {
    const cohort = workersOf(complete());
    const c = comparison(cohort, 'L1-C1');
    expect(c.verdict).toMatchObject({ kind: 'winner', mode: 'C1', basis: 'speed' });
    expect(c.verdict.kind === 'winner' ? c.verdict.statement : '').toMatch(/^On this fixture and configuration, 5 of 5 attempts passed/);
  });

  it('H2 against a one-worker mode is described side by side, with no winner', () => {
    const c = comparison(workersOf(complete()), 'H2-L1');
    expect(c.verdict.kind).toBe('descriptive');
    expect(c.sides[0]).toBe('H2: 5 of 5 passed, median 12m 40s, range 12m 0s to 13m 20s, with twice the coding capacity.');
    expect(c.sides[1]).toContain('L1: 5 of 5 passed');
  });

  it('every verdict shows both sides with n of N, and below the target of five says Exploratory', () => {
    const records = (['L1', 'C1'] as const).flatMap((m) => [0, 1, 2].map((index) => workerRecord({ mode: m, index, dataKind: 'measured', ms: (m === 'L1' ? 1_200_000 : 600_000) + index * 1000 })));
    const c = comparison(workersOf(benchmarkFile({ cohorts: [workerCohort({ plannedPerMode: 3, requiredModes: ['L1', 'C1'] }), assistantCohort()], records })), 'L1-C1');
    expect(c.verdict).toMatchObject({ kind: 'winner', mode: 'C1', exploratory: true });
    expect(c.sides.join(' ')).toContain('L1: 3 of 3 passed');
    expect(c.sides[0]).toContain('Exploratory');
  });

  it('a one-attempt margin names no winner', () => {
    const records = completeWorkers('measured');
    records[5] = workerRecord({ mode: 'C1', index: 0, dataKind: 'measured', status: 'failed' });
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toMatch(/one attempt/i);
  });

  it('pass counts over different numbers of attempts name no winner', () => {
    const c1 = Array.from({ length: 10 }, (_, index) => workerRecord({ mode: 'C1', index, dataKind: 'measured', ...(index === 9 ? { failedCriteria: ['FB-01'] } : {}) }));
    const l1 = [0, 1, 2, 3, 4].map((index) => workerRecord({ mode: 'L1', index, dataKind: 'measured' }));
    const c = comparison(workersOf(benchmarkFile({ records: [...l1, ...c1] })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toMatch(/different numbers/i);
  });

  it('a recorded confounder removes the badge and changes the scope', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, confounders: ['ARM laptop against x86 VM'] });
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toContain('ARM laptop against x86 VM');
    expect(c.scope).toContain('End-to-end configuration comparison');
  });

  it('a different manifest blocks a winner', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, config: { manifestSha256: 'other' } });
    expect(reasonsOf(comparison(workersOf(benchmarkFile({ records })), 'L1-C1'))).toContain('Not the same manifest');
  });

  it('names each excluded pair', () => {
    const records = completeWorkers('measured');
    records[5] = workerRecord({ mode: 'C1', index: 0, dataKind: 'measured', status: 'failed' });
    const { pairs } = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(pairs.valid).toBe(4);
    expect(pairs.excluded).toEqual(['block-0: C1 did not pass']);
  });

  it('no winner badge on incomplete or mismatched cohorts', () => {
    // Incomplete: a mode short of its predeclared attempts.
    const short = workersOf(benchmarkFile({ records: completeWorkers('measured').filter((r) => !(r.mode === 'C1' && r.attemptId.startsWith('c1-4'))) }));
    expect(comparison(short, 'L1-C1').verdict.kind).toBe('none');
    expect(reasonsOf(comparison(short, 'L1-C1'))).toContain('C1: 4 of 5 planned attempts');
    // Below the plan's minimum even when "complete".
    const tiny = (['L1', 'C1', 'H2'] as const).flatMap((m) => [0, 1].map((index) => workerRecord({ mode: m, index, dataKind: 'measured', ms: 60_000 * (m === 'L1' ? 9 : 2) })));
    const belowMin = workersOf(benchmarkFile({ cohorts: [workerCohort({ plannedPerMode: 2 }), assistantCohort()], records: tiny }));
    expect(comparison(belowMin, 'L1-C1').verdict.kind).toBe('none');
    expect(reasonsOf(comparison(belowMin, 'L1-C1'))).toContain(`minimum of ${MIN_ATTEMPTS_PER_MODE}`);
    // One mode missing entirely.
    const missing = workersOf(benchmarkFile({ records: completeWorkers('measured').filter((r) => r.mode !== 'C1') }));
    expect(reasonsOf(comparison(missing, 'L1-C1'))).toContain('C1: Not measured');
    // Mismatched on each dimension.
    const dims: [string, string][] = [['starterSha', 'starter'], ['verifierSha', 'verifier'], ['harness', 'harness'], ['codingModel', 'model']];
    for (const [field, word] of dims) {
      const records = completeWorkers('measured');
      records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, config: { [field]: 'different' } });
      const cohort = workersOf(benchmarkFile({ records }));
      expect(comparison(cohort, 'L1-C1').verdict.kind).toBe('none');
      expect(reasonsOf(comparison(cohort, 'L1-C1'))).toContain(`Not the same ${word}`);
    }
    // An unrecorded value cannot match.
    const unrecorded = completeWorkers('measured').map((r) => ({ ...r, configuration: { ...r.configuration, verifierSha: null } }));
    expect(reasonsOf(comparison(workersOf(benchmarkFile({ records: unrecorded })), 'L1-C1'))).toContain('Verifier not recorded');
  });

  it('a not-run attempt leaves the cohort incomplete', () => {
    const records = completeWorkers('measured');
    records[9] = workerRecord({ mode: 'C1', index: 4, dataKind: 'measured', status: 'not_run' });
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toContain('C1: 1 attempt not run');
  });

  it('mixing warm and cold starts blocks a winner and withholds the timing', () => {
    const records = completeWorkers('measured');
    records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, config: { cacheCondition: 'cold' } });
    const cohort = workersOf(benchmarkFile({ records }));
    expect(reasonsOf(comparison(cohort, 'L1-C1'))).toMatch(/warm and cold/i);
    expect(cohort.rows.find((r) => r.mode === 'L1')!.time.text).toBe('Withheld');
  });

  it('human-intervened attempts are excluded from comparisons and shown as such', () => {
    const records = completeWorkers('measured');
    records[3] = workerRecord({ mode: 'L1', index: 3, dataKind: 'measured', humanIntervened: true, ms: 1_260_000 });
    const cohort = workersOf(benchmarkFile({ records }));
    const l1 = cohort.rows.find((r) => r.mode === 'L1')!;
    expect(l1.counts.humanIntervened).toBe(1);
    expect(l1.completion.text).toBe('4 of 4 passed');
    expect(l1.completion.detail).toContain('1 human-intervened attempt excluded');
    expect(comparison(cohort, 'L1-C1').verdict.kind).toBe('none');
    expect(reasonsOf(comparison(cohort, 'L1-C1'))).toContain('L1: 4 of 5 planned attempts');
    expect(reasonsOf(comparison(cohort, 'L1-C1'))).toContain('human-intervened');
    expect(cohort.attempts.find((a) => a.attemptId === 'l1-3-measured')!.humanLabel).toBe('Human-intervened, excluded');
  });

  it('human intervention that was not recorded is not assumed to be none', () => {
    const records = completeWorkers('measured');
    records[3] = workerRecord({ mode: 'L1', index: 3, dataKind: 'measured', humanIntervened: null, ms: 1_260_000 });
    const cohort = workersOf(benchmarkFile({ records }));
    expect(cohort.rows.find((r) => r.mode === 'L1')!.counts.notRecorded).toBe(1);
    expect(comparison(cohort, 'L1-C1').verdict.kind).toBe('none');
    expect(cohort.attempts.find((a) => a.attemptId === 'l1-3-measured')!.humanLabel).toBe('Not recorded, excluded');
  });

  it('a mode with more passes wins on completion, and speed is not used when passes differ', () => {
    const records = completeWorkers('measured');
    records[5] = workerRecord({ mode: 'C1', index: 0, dataKind: 'measured', status: 'failed' });
    records[6] = workerRecord({ mode: 'C1', index: 1, dataKind: 'measured', failedCriteria: ['FB-01'] });
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict).toMatchObject({ kind: 'winner', mode: 'L1', basis: 'completion' });
  });

  it('overlapping ranges give no winner, however the medians differ', () => {
    const records = completeWorkers('measured', { L1: 900_000, C1: 950_000 });
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toMatch(/ranges overlap/i);
  });

  it('too few predeclared valid pairs is exploratory, with no headline speed result', () => {
    const records = completeWorkers('measured').map((r, i) => ({ ...r, blockId: i < 9 ? 'solo' : r.blockId }));
    const c = comparison(workersOf(benchmarkFile({ records })), 'L1-C1');
    expect(c.verdict.kind).toBe('none');
    expect(reasonsOf(c)).toMatch(/exploratory/i);
  });

  it('assistant routes never get a winner: the models differ', () => {
    const cohort = buildBenchmark(ok(benchmarkFile({ records: completeAssistant('measured') }))).assistant.measured[0]!;
    expect(cohort.comparison.verdict.kind).toBe('none');
    expect(cohort.comparison.verdict.kind === 'none' ? cohort.comparison.verdict.reasons.join(' ') : '').toMatch(/different models/i);
  });
});

describe('assistant rows', () => {
  it('a route mismatch or unknown source counts as a routing failure, and warm-ups stay listed but untimed', () => {
    const records = [
      assistantRecord({ route: 'ONLY_ON_DEVICE', index: 0, dataKind: 'measured', ms: 1000 }),
      assistantRecord({ route: 'ONLY_ON_DEVICE', index: 1, dataKind: 'measured', observed: 'IN_CLOUD', ms: 9000 }),
      assistantRecord({ route: 'ONLY_ON_DEVICE', index: 2, dataKind: 'measured', observed: null, ms: 9000 }),
      assistantRecord({ route: 'ONLY_ON_DEVICE', index: 3, dataKind: 'measured', warmup: true, ms: 9000 }),
    ];
    const cohort = buildBenchmark(ok(benchmarkFile({ records }))).assistant.measured[0]!;
    const row = cohort.rows.find((r) => r.mode === 'ONLY_ON_DEVICE')!;
    expect(row.routing.text).toBe('1 of 3 correct');
    expect(row.observedSource).toBe('On device, In cloud, Unknown');
    expect(row.counts.warmups).toBe(1);
    expect(row.complete.text).toBe('1.0s');
    expect(cohort.attempts).toHaveLength(4);
    expect(row.requested).toBe('Device only');
  });

  it('warm-ups go in their own ledger, out of request cost and totals of requests', () => {
    const records = [
      assistantRecord({ route: 'ONLY_IN_CLOUD', index: 0, dataKind: 'measured', costUsd: 1 }),
      assistantRecord({ route: 'ONLY_IN_CLOUD', index: 1, dataKind: 'measured', warmup: true, costUsd: 5 }),
    ];
    const model = buildBenchmark(ok(benchmarkFile({ records })));
    const row = model.assistant.measured[0]!.rows.find((r) => r.mode === 'ONLY_IN_CLOUD')!;
    expect(row.cost.text).toBe('$1.00');
    expect(row.warmups.text).toBe('$5.00');
    expect(row.warmups.detail).toContain('1 warm-up');
  });

  it('only route-blind reviews count', () => {
    const base = assistantRecord({ route: 'ONLY_ON_DEVICE', index: 0, dataKind: 'measured' });
    const open = { ...assistantRecord({ route: 'ONLY_ON_DEVICE', index: 1, dataKind: 'measured' }) };
    open.assistant = { ...open.assistant!, semanticReview: { ...open.assistant!.semanticReview, routeLabelHidden: false } };
    const row = buildBenchmark(ok(benchmarkFile({ records: [base, open] }))).assistant.measured[0]!.rows[0]!;
    expect(row.review.text).toBe('1 of 2 reviewed');
  });

  it('device usage that was not reported stays unavailable', () => {
    const cohort = buildBenchmark(ok(benchmarkFile({ records: completeAssistant('measured') }))).assistant.measured[0]!;
    const device = cohort.rows.find((r) => r.mode === 'ONLY_ON_DEVICE')!;
    expect(device.usage.provenance).toBe('unavailable');
    expect(device.usage.text).toBe('Unavailable');
    const cloud = cohort.rows.find((r) => r.mode === 'ONLY_IN_CLOUD')!;
    expect(cloud.usage.provenance).toBe('observed');
  });

  it('evidence items default to not measured, and a simulated item never counts as recorded', () => {
    const none = buildBenchmark({ kind: 'absent' }).assistant.evidence;
    expect(none.every((e) => e.status === 'not_measured')).toBe(true);
    const file = benchmarkFile({ assistantEvidence: [
      { id: 'device_only_response', status: 'recorded', dataKind: 'simulated', references: [] },
      { id: 'schema_validation', status: 'recorded', dataKind: 'measured', references: ['#/evidence?run=r'] },
    ] });
    const evidence = buildBenchmark(ok(file)).assistant.evidence;
    expect(evidence.find((e) => e.id === 'device_only_response')!.status).toBe('simulated');
    expect(evidence.find((e) => e.id === 'schema_validation')!.status).toBe('recorded');
  });
});

describe('simulated data', () => {
  it('simulated data never enters totals', () => {
    const measured = completeWorkers('measured');
    const file = benchmarkFile({ records: [...measured.slice(0, 5), ...completeWorkers('simulated').filter((r) => r.mode !== 'L1'), ...completeAssistant('simulated')] });
    const model = buildBenchmark(ok(file));
    expect(model.workers.totals.attempts).toBe(5);
    expect(model.workers.totals.passed).toBe(5);
    expect(model.workers.totals.notRecorded).toBe(0);
    expect(model.assistant.totals.attempts).toBe(0);
    expect(model.assistant.measured).toEqual([]);
    const cohort = model.workers.measured[0]!;
    expect(cohort.rows.find((r) => r.mode === 'C1')!.counts.total).toBe(0);
    expect(cohort.rows.find((r) => r.mode === 'C1')!.completion.text).toBe('Not measured');
    // Simulated cost cannot reach the measured sum.
    expect(cohort.rows.find((r) => r.mode === 'L1')!.cost[0]!.text).toBe('$6.00');
    // Simulated attempts cannot complete a measured cohort.
    expect(comparison(cohort, 'L1-C1').verdict.kind).toBe('none');
  });

  it('a complete simulated cohort is shown, labelled, and never produces a winner', () => {
    const model = buildBenchmark(ok(benchmarkFile({ records: [...completeWorkers('simulated'), ...completeAssistant('simulated')] })));
    expect(model.workers.totals.attempts).toBe(0);
    const cohort = model.workers.simulated[0]!;
    expect(cohort.kind).toBe('simulated');
    expect(cohort.rows.find((r) => r.mode === 'C1')!.time.provenance).toBe('simulated');
    expect(cohort.rows.find((r) => r.mode === 'C1')!.time.text).toBe('16m 40s median');
    for (const c of cohort.comparisons) {
      expect(c.verdict.kind).toBe('none');
      expect(reasonsOf(c)).toMatch(/simulated/i);
    }
    for (const f of allFigures(cohort.rows)) {
      expect(f.provenance === 'simulated' || f.provenance === 'unavailable').toBe(true);
    }
    expect(model.assistant.simulated[0]!.comparison.verdict.kind).toBe('none');
  });
});
