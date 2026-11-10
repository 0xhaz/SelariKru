import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BenchmarkFileSchema, BenchmarkRecordSchema, BenchmarkRecordTemplateSchema, type BenchmarkFile, type BenchmarkRecord } from './index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const template = JSON.parse(readFileSync(join(root, 'fixtures/benchmarks/result.template.json'), 'utf8')) as Record<string, unknown>;

/** Every key path in a JSON value, with array elements collapsed to `[]`. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [prefix] : [...new Set(value.flatMap((v) => keyPaths(v, `${prefix}[]`)))];
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keyPaths(v, `${prefix}.${k}`)]);
  return [];
}

const STARTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CANDIDATE = 'c'.repeat(40);

function file(records: BenchmarkRecord[]): BenchmarkFile {
  return {
    protocolVersion: '0.1', generatedAtUtc: '2026-11-20T10:00:00.000Z', assistantEvidence: [], records,
    cohorts: [{ cohortId: 'c-workers', track: 'workers', plannedPerMode: 5, requiredModes: ['L1'], order: null }, { cohortId: 'c-assistant', track: 'assistant', plannedPerMode: 30, requiredModes: ['ONLY_IN_CLOUD'], order: null }],
  };
}

function notRun(track: 'workers' | 'assistant'): BenchmarkRecord {
  const t = structuredClone(template) as BenchmarkRecord;
  return {
    ...t, dataKind: 'fixture', track, cohortId: `c-${track}`, trialId: `t-${track}`, mode: track === 'workers' ? 'L1' : 'ONLY_IN_CLOUD', attemptId: `a-${track}`,
    assistant: track === 'workers' ? null : { ...t.assistant!, requestedMode: 'ONLY_IN_CLOUD' },
    quality: track === 'workers' ? t.quality : { ...t.quality, criteria: [] },
  };
}

function measuredWorker(): BenchmarkRecord {
  const r = notRun('workers');
  return {
    ...r, dataKind: 'measured', status: 'completed', measuredResultsPresent: true, resultSha256: 'f'.repeat(64), artifactReferences: ['#/evidence?run=1'],
    configuration: { ...r.configuration, manifestSha256: 'e'.repeat(64), starterSha: STARTER, candidateSha: CANDIDATE },
    timings: { ...r.timings, clockDomain: 'server-monotonic', endToEndVerifiedMs: 900_000 },
    quality: { allRequiredChecksPassed: true, withinDeclaredLimits: true, criteria: r.quality.criteria.map((c) => ({ ...c, status: 'passed' as const, evidenceReferences: [`#/evidence?check=${c.id}`] })) },
    operations: { ...r.operations, humanIntervened: false, permittedHumanActions: 0 },
  };
}

function measuredAssistant(): BenchmarkRecord {
  const r = notRun('assistant');
  return {
    ...r, dataKind: 'measured', status: 'completed', measuredResultsPresent: true, resultSha256: 'd'.repeat(64), artifactReferences: ['#/evidence?run=a1'],
    configuration: { ...r.configuration, manifestSha256: 'e'.repeat(64), starterSha: STARTER },
    assistant: { ...r.assistant!, observedInferenceSource: 'IN_CLOUD', schemaValid: true, payloadSha256: 'b'.repeat(64) },
    timings: { ...r.timings, clockDomain: 'browser-monotonic', generationCompleteMs: 1200 },
  };
}

const accepted = (records: BenchmarkRecord[]): boolean => BenchmarkFileSchema.safeParse(file(records)).success;

describe('the benchmark result template and schema', () => {
  it('agree: the template parses as a record template, field for field', () => {
    expect(BenchmarkRecordTemplateSchema.safeParse(template).success).toBe(true);
    expect(BenchmarkRecordTemplateSchema.safeParse({ ...template, bonus: 1 }).success).toBe(false);
    const { resultSha256: _r, ...missing } = template;
    expect(BenchmarkRecordTemplateSchema.safeParse(missing).success).toBe(false);
  });

  it('agree: a template with its identity filled is a valid not-run record in a results file', () => {
    expect(accepted([notRun('workers'), notRun('assistant')])).toBe(true);
    expect(keyPaths(BenchmarkRecordSchema.parse(notRun('workers'))).sort()).toEqual(keyPaths(template).filter((p) => !p.startsWith('.assistant.')).sort());
  });

  it('a measured record names its starter by a full lowercase commit SHA', () => {
    expect(accepted([measuredWorker()])).toBe(true);
    const r = measuredWorker();
    expect(accepted([{ ...r, configuration: { ...r.configuration, starterSha: STARTER.toUpperCase() } }])).toBe(false);
    expect(accepted([{ ...r, configuration: { ...r.configuration, starterSha: STARTER.slice(0, 12) } }])).toBe(false);
    expect(accepted([{ ...r, configuration: { ...r.configuration, starterSha: null } }])).toBe(false);
  });

  it('a permitted human action outside control mode is counted, and its minutes need a count', () => {
    const r = measuredWorker();
    const withAction = { ...r, operations: { ...r.operations, permittedHumanActions: 1 }, humanMinutes: { ...r.humanMinutes, permittedAction: 2, provenance: 'observed' as const, source: 'approval log' } };
    expect(accepted([withAction])).toBe(true);
    expect(accepted([{ ...withAction, operations: { ...withAction.operations, permittedHumanActions: 0 } }])).toBe(false);
    expect(accepted([{ ...withAction, operations: { ...withAction.operations, permittedHumanActions: null } }])).toBe(false);
  });

  it('a measured record carries exactly one hash: the local export hash or, once published, the hash of the redacted record', () => {
    const r = measuredWorker();
    expect(accepted([{ ...r, resultSha256: null, publishedSha256: 'a'.repeat(64) }])).toBe(true);
    expect(accepted([{ ...r, resultSha256: null, publishedSha256: null }])).toBe(false);
    expect(accepted([{ ...r, resultSha256: 'f'.repeat(64), publishedSha256: 'a'.repeat(64) }])).toBe(false);
    expect(accepted([{ ...r, publishedSha256: 'A'.repeat(64), resultSha256: null }])).toBe(false);
  });

  it('a slot attempt is a positive whole number and comes with its slot', () => {
    const r = measuredWorker();
    expect(accepted([{ ...r, slotId: 'workers/block-1/L1', slotAttempt: 2 }])).toBe(true);
    expect(accepted([{ ...r, slotId: 'workers/block-1/L1', slotAttempt: 0 }])).toBe(false);
    expect(accepted([{ ...r, slotId: null, slotAttempt: 1 }])).toBe(false);
  });

  it('a measured assistant request that ran carries its payload hash', () => {
    expect(accepted([measuredAssistant()])).toBe(true);
    const r = measuredAssistant();
    expect(accepted([{ ...r, assistant: { ...r.assistant!, payloadSha256: null } }])).toBe(false);
    expect(accepted([{ ...r, assistant: { ...r.assistant!, payloadSha256: 'B'.repeat(64) } }])).toBe(false);
  });
});
