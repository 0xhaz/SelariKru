import { describe, expect, it } from 'vitest';
import { buildBenchmark, MIN_ATTEMPTS_PER_MODE, type Comparison, type Figure, type WorkerCohortView } from './model.ts';
import { BenchmarkFileSchema, loadBenchmark, type BenchmarkFile, type BenchmarkLoad } from './schema.ts';
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
    expect(row.usage.detail).toBe('Median of 3 of 5 attempts with observed usage. 1 estimated, 1 unavailable.');
  });
});

describe('the winner badge', () => {
  const complete = (): BenchmarkFile => benchmarkFile({ records: completeWorkers('measured') });

  it('a complete matched cohort with clearly separated timing can have a winner', () => {
    const cohort = workersOf(complete());
    const c = comparison(cohort, 'L1-C1');
    expect(c.verdict).toMatchObject({ kind: 'winner', mode: 'C1', basis: 'speed' });
    expect(c.verdict.kind === 'winner' ? c.verdict.statement : '').toMatch(/^On this fixture and configuration, 5 of 5 attempts passed/);
    expect(comparison(cohort, 'H2-L1').verdict).toMatchObject({ kind: 'winner', mode: 'H2' });
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
