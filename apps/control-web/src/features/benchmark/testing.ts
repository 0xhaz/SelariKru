import type { BenchmarkCohort, BenchmarkFile, BenchmarkRecord, WorkerMode } from './schema.ts';

/** Test data only. Built by `tests/`, never imported by the app, so none of it reaches a production bundle. Every helper defaults to a simulated record: a test that wants `measured` must say so. */

export const SHA = { starter: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', verifier: 'feedbeef00112233445566778899aabbccddeeff', contract: '0123456789abcdef', manifest: 'fedcba9876543210' } as const;

const blankQuality: BenchmarkRecord['quality'] = {
  allRequiredChecksPassed: null,
  criteria: Array.from({ length: 8 }, (_, i) => ({ id: `FB-0${i + 1}`, status: 'not_run' as const, evidenceReferences: [] })),
  withinDeclaredLimits: null,
};

const evidence = (id: string): string[] => [`#/evidence?check=${id}`];

function passedQuality(): BenchmarkRecord['quality'] {
  return { allRequiredChecksPassed: true, withinDeclaredLimits: true, criteria: blankQuality.criteria.map((c) => ({ ...c, status: 'passed' as const, evidenceReferences: evidence(c.id) })) };
}

function failedQuality(failed: readonly string[]): BenchmarkRecord['quality'] {
  return { allRequiredChecksPassed: false, withinDeclaredLimits: true, criteria: blankQuality.criteria.map((c) => ({ ...c, status: failed.includes(c.id) ? 'failed' as const : 'passed' as const, evidenceReferences: evidence(c.id) })) };
}

const baseConfig: BenchmarkRecord['configuration'] = {
  manifestSha256: SHA.manifest, starterSha: SHA.starter, contractSha256: SHA.contract, verifierSha: SHA.verifier, candidateSha: 'c'.repeat(40),
  harness: 'claude-code', harnessVersion: '2.1.0', codingModel: 'claude-sonnet-5-5', inferenceDestination: 'cloud', providerAccountReference: 'acct-demo',
  cacheCondition: 'warm', localHost: 'arm64-local', cloudHost: 'x86-cloud',
};

export interface WorkerOver {
  readonly mode: WorkerMode;
  readonly index: number;
  readonly ms?: number | null;
  readonly dataKind?: BenchmarkRecord['dataKind'];
  readonly status?: BenchmarkRecord['status'];
  readonly failedCriteria?: readonly string[];
  readonly humanIntervened?: boolean | null;
  readonly cohortId?: string;
  readonly actualUsd?: number | null;
  readonly estimatedUsd?: number | null;
  readonly config?: Partial<BenchmarkRecord['configuration']>;
  readonly confounders?: readonly string[];
  readonly usage?: BenchmarkRecord['resources']['providerUsageByRole'];
}

export function workerRecord(o: WorkerOver): BenchmarkRecord {
  const dataKind = o.dataKind ?? 'simulated';
  const status = o.status ?? 'completed';
  const ran = status !== 'not_run';
  const measured = dataKind === 'measured' && ran;
  const quality = !ran ? blankQuality : status === 'completed' ? (o.failedCriteria ? failedQuality(o.failedCriteria) : passedQuality()) : blankQuality;
  return {
    protocolVersion: '0.1', dataKind, status, track: 'workers', cohortId: o.cohortId ?? 'cohort-workers', trialId: `t-${o.mode}-${o.index}`, mode: o.mode, blockId: `block-${o.index}`,
    attemptId: `${o.mode.toLowerCase()}-${o.index}-${dataKind}`, configuration: { ...baseConfig, candidateSha: ran ? `${String(o.index).repeat(2)}${'c'.repeat(38)}`.slice(0, 40) : null, ...o.config },
    assistant: null,
    timings: { clockDomain: 'server-monotonic', startedAtUtc: null, endedAtUtc: null, firstOutputMs: null, generationCompleteMs: null, schemaValidationMs: null, endToEndVerifiedMs: ran ? (o.ms === undefined ? 900_000 : o.ms) : null, queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null, initialSetupMs: null, modelDownloadMs: null },
    resources: {
      localWorkerHours: ran && o.mode !== 'C1' ? 0.25 : null, cloudWorkerHours: ran && o.mode !== 'L1' ? 0.25 : null, integrationAndVerificationHours: null, workerHoursProvenance: ran ? 'observed' : 'unavailable', workerHoursSource: ran ? 'runner' : null, requestedVcpus: ran ? 2 : null, requestedMemoryGib: ran ? 4 : null, peakRssMiB: null, energyKwh: null,
      providerUsageByRole: o.usage ?? (ran ? [{ role: 'coding', inputTokens: 120_000, outputTokens: 8_000, cacheTokens: 40_000, provenance: 'observed', source: 'harness' }] : []),
      usageCoverage: ran ? 'complete' : 'none', integrationAndVerificationHoursAreSubsetOfHostTotals: true,
    },
    cost: { currency: 'USD', platformPaidActual: ran ? (o.actualUsd === undefined ? 1.2 : o.actualUsd) : null, platformPaidEstimated: ran ? (o.estimatedUsd === undefined ? 1.3 : o.estimatedUsd) : null, customerDirectActual: null, allocatedFixedCost: null, localHardwareEnergyCost: null, localCostProvenance: 'unavailable', localCostSource: null, rateCardVersion: 'rc-2026-11', settlementStatus: ran ? 'settled' : 'unavailable', exclusions: ['fixed subscriptions'] },
    humanMinutes: ran ? { initialSetup: null, scoping: null, intervention: 0, correction: 0, review: 2, provenance: 'observed', source: 'reviewer log' } : { initialSetup: null, scoping: null, intervention: null, correction: null, review: null, provenance: 'unavailable', source: null },
    quality,
    operations: { repairCount: ran ? 0 : null, deniedActionCount: ran ? 0 : null, cleanupConfirmed: ran ? true : null, externalPrUrl: null, humanIntervened: o.humanIntervened === undefined ? false : o.humanIntervened },
    failures: status === 'failed' ? [{ category: 'verifier_failed', detail: 'FB-03 did not pass' }] : [],
    confounders: [...(o.confounders ?? [])],
    artifactReferences: ran ? [`#/evidence?run=${o.mode}-${o.index}`] : [],
    resultSha256: ran ? 'a'.repeat(64) : null,
    measuredResultsPresent: measured,
  };
}

export interface AssistantOver {
  readonly route: 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD';
  readonly index: number;
  readonly dataKind?: BenchmarkRecord['dataKind'];
  readonly status?: BenchmarkRecord['status'];
  readonly observed?: 'ON_DEVICE' | 'IN_CLOUD' | null;
  readonly ms?: number | null;
  readonly schemaValid?: boolean | null;
  readonly warmup?: boolean;
  readonly cohortId?: string;
  readonly costUsd?: number;
}

export function assistantRecord(o: AssistantOver): BenchmarkRecord {
  const dataKind = o.dataKind ?? 'simulated';
  const status = o.status ?? 'completed';
  const ran = status !== 'not_run';
  const device = o.route === 'ONLY_ON_DEVICE';
  const observed = o.observed === undefined ? (device ? 'ON_DEVICE' : 'IN_CLOUD') : o.observed;
  return {
    protocolVersion: '0.1', dataKind, status, track: 'assistant', cohortId: o.cohortId ?? 'cohort-assistant', trialId: `b-${o.index}`, mode: o.route, blockId: null,
    attemptId: `${device ? 'dev' : 'cloud'}-${o.index}-${dataKind}${o.warmup ? '-w' : ''}`, configuration: { ...baseConfig, cacheCondition: 'warm', codingModel: device ? 'gemini-nano' : 'gemini-2.5-flash', inferenceDestination: device ? 'device' : 'cloud', candidateSha: null },
    assistant: {
      fixtureId: `brief-${o.index % 10}`, requestedMode: o.route, observedInferenceSource: ran ? observed : null, sdkVersion: '13.1.0', schemaValid: ran ? (o.schemaValid === undefined ? true : o.schemaValid) : null, warmup: o.warmup ?? false,
      semanticReview: { reviewer: null, routeLabelHidden: ran ? true : null, retainedFacts: ran ? 6 : null, missingFacts: ran ? 0 : null, inventedRequirements: ran ? 0 : null },
      providerInputTokens: device || !ran ? null : 1200, providerOutputTokens: device || !ran ? null : 300, inputBytes: ran ? 2048 : null, outputBytes: ran ? 512 : null,
    },
    timings: { clockDomain: 'browser-monotonic', startedAtUtc: null, endedAtUtc: null, firstOutputMs: ran && o.ms !== null ? (o.ms ?? 1200) / 3 : null, generationCompleteMs: ran ? (o.ms === undefined ? 1200 : o.ms) : null, schemaValidationMs: ran ? 4 : null, endToEndVerifiedMs: null, queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null, initialSetupMs: null, modelDownloadMs: null },
    resources: { localWorkerHours: null, cloudWorkerHours: null, integrationAndVerificationHours: null, workerHoursProvenance: 'unavailable', workerHoursSource: null, requestedVcpus: null, requestedMemoryGib: null, peakRssMiB: null, energyKwh: null, providerUsageByRole: [], usageCoverage: ran ? (device ? 'none' : 'complete') : 'none', integrationAndVerificationHoursAreSubsetOfHostTotals: true },
    cost: { currency: 'USD', platformPaidActual: o.costUsd ?? (device || !ran ? null : 0.001), platformPaidEstimated: null, customerDirectActual: null, allocatedFixedCost: null, localHardwareEnergyCost: null, localCostProvenance: 'unavailable', localCostSource: null, rateCardVersion: 'rc-2026-11', settlementStatus: 'unavailable', exclusions: [] },
    humanMinutes: { initialSetup: null, scoping: null, intervention: null, correction: null, review: null, provenance: 'unavailable', source: null },
    quality: { allRequiredChecksPassed: null, criteria: [], withinDeclaredLimits: null },
    operations: { repairCount: null, deniedActionCount: null, cleanupConfirmed: null, externalPrUrl: null, humanIntervened: false },
    failures: status === 'failed' ? [{ category: 'adapter_error', detail: 'schema unsupported' }] : [],
    confounders: [],
    artifactReferences: ran ? [`#/evidence?run=assistant-${o.index}`] : [],
    resultSha256: ran ? 'b'.repeat(64) : null,
    measuredResultsPresent: dataKind === 'measured' && ran,
  };
}

export const workerCohort = (over: Partial<BenchmarkCohort> = {}): BenchmarkCohort => ({ cohortId: 'cohort-workers', track: 'workers', plannedPerMode: 5, requiredModes: ['L1', 'C1', 'H2'], order: 'seed-7f1e', ...over });
export const assistantCohort = (over: Partial<BenchmarkCohort> = {}): BenchmarkCohort => ({ cohortId: 'cohort-assistant', track: 'assistant', plannedPerMode: 30, requiredModes: ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'], order: 'seed-7f1e', ...over });

export function benchmarkFile(parts: { cohorts?: BenchmarkCohort[]; records?: BenchmarkRecord[]; assistantEvidence?: BenchmarkFile['assistantEvidence'] }): BenchmarkFile {
  return { protocolVersion: '0.1', generatedAtUtc: '2026-11-20T10:00:00.000Z', cohorts: parts.cohorts ?? [workerCohort(), assistantCohort()], records: parts.records ?? [], assistantEvidence: parts.assistantEvidence ?? [] };
}

/** Five attempts per mode, fastest L1 then C1 then H2 by default ms, one failure-free block each. */
export function completeWorkers(dataKind: BenchmarkRecord['dataKind'] = 'simulated', msBy: Partial<Record<WorkerMode, number>> = {}, cohortId = 'cohort-workers'): BenchmarkRecord[] {
  const defaults: Record<WorkerMode, number> = { L1: 1_200_000, C1: 960_000, H2: 720_000, L2: 800_000, C2: 800_000 };
  return (['L1', 'C1', 'H2'] as const).flatMap((mode) => [0, 1, 2, 3, 4].map((index) => workerRecord({ mode, index, dataKind, cohortId, ms: (msBy[mode] ?? defaults[mode]) + index * 20_000 })));
}

export function completeAssistant(dataKind: BenchmarkRecord['dataKind'] = 'simulated', cohortId = 'cohort-assistant'): BenchmarkRecord[] {
  return (['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'] as const).flatMap((route) => Array.from({ length: 30 }, (_, index) => assistantRecord({ route, index, dataKind, cohortId, ms: route === 'ONLY_ON_DEVICE' ? 2400 + index * 10 : 1100 + index * 15 })));
}

/** L1 finished with failures, C1 part-way, H2 and the assistant's cloud route not run at all. */
export function partialFile(): BenchmarkFile {
  const records: BenchmarkRecord[] = [
    workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_290_000, actualUsd: 2.71, estimatedUsd: 2.9 }),
    workerRecord({ mode: 'L1', index: 1, dataKind: 'measured', ms: 1_170_000, actualUsd: 2.4, estimatedUsd: 2.5 }),
    workerRecord({ mode: 'L1', index: 2, dataKind: 'measured', status: 'failed', ms: null, actualUsd: 1.8, estimatedUsd: 1.9 }),
    workerRecord({ mode: 'L1', index: 3, dataKind: 'measured', status: 'abandoned', ms: null, actualUsd: null, estimatedUsd: 0.6 }),
    workerRecord({ mode: 'L1', index: 4, dataKind: 'measured', failedCriteria: ['FB-05'], ms: 1_500_000, actualUsd: 3.1, estimatedUsd: 3.2 }),
    workerRecord({ mode: 'C1', index: 0, dataKind: 'measured', ms: 980_000, actualUsd: null, estimatedUsd: 2.2 }),
    workerRecord({ mode: 'C1', index: 1, dataKind: 'measured', status: 'not_run' }),
    workerRecord({ mode: 'C1', index: 2, dataKind: 'measured', status: 'not_run' }),
  ];
  const device = Array.from({ length: 5 }, (_, index) => assistantRecord({ route: 'ONLY_ON_DEVICE', index, dataKind: 'measured', ms: 2300 + index * 120, ...(index === 3 ? { schemaValid: false } : {}) }));
  return benchmarkFile({ records: [...records, ...device], assistantEvidence: [{ id: 'pinned_configuration', status: 'recorded', dataKind: 'measured', references: ['#/evidence?run=preflight'] }] });
}
