import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@selarikru/protocol';
import { BenchmarkFileSchema, type BenchmarkFile, type BenchmarkRecord } from '@selarikru/view-protocol';
import { checkResults } from './checks.ts';
import type { Manifest } from './manifest.ts';
import { recordHash } from './report.ts';

/**
 * The scripted publish step: validate a results file against the schema and the same checks export runs, redact what
 * must not leave this machine, stamp the time, and validate again. The web panel reads the output from
 * apps/control-web/public. Writes one file; no network.
 *
 * - Account and host are replaced: a recorded value becomes `redacted`, so it stays distinguishable from never recorded.
 * - Failure detail is dropped; the category stays. Every other string goes through `redactSecrets`.
 * - `resultSha256`, the hash of the unredacted record, is removed: a short dictionary of hosts or accounts could
 *   confirm a guess against it. The published record carries `publishedSha256`, the hash of the redacted record with
 *   its hash fields left out. The local export keeps `resultSha256`.
 */

export const REDACTED_VALUE = 'redacted';
export const PUBLIC_RESULTS_PATH = 'apps/control-web/public/benchmark-results.json';

export class PublishError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the results cannot be published: ${issues.join('; ')}`);
    this.name = 'PublishError';
  }
}

const UtcStamp = z.iso.datetime();

function deepRedact<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(deepRedact) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)])) as T;
  return value;
}

const withheld = (v: string | null): string | null => (v === null ? null : REDACTED_VALUE);

function redactRecord(r: BenchmarkRecord): BenchmarkRecord {
  const { resultSha256: _local, publishedSha256: _previous, measuredResultsPresent, ...rest } = r;
  const c = rest.configuration;
  const redacted = deepRedact({
    ...rest,
    configuration: { ...c, providerAccountReference: withheld(c.providerAccountReference), localHost: withheld(c.localHost), cloudHost: withheld(c.cloudHost) },
    failures: rest.failures.map((f) => ({ category: f.category, detail: null })),
  });
  return { ...redacted, resultSha256: null, publishedSha256: recordHash(redacted), measuredResultsPresent };
}

const issuesOf = (e: z.ZodError): string[] => e.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);

export function preparePublish(input: unknown, generatedAtUtc: string, manifest: Manifest): BenchmarkFile {
  if (!UtcStamp.safeParse(generatedAtUtc).success) throw new PublishError(['generatedAtUtc must be a UTC ISO timestamp']);
  const parsed = BenchmarkFileSchema.safeParse(input);
  if (!parsed.success) throw new PublishError(issuesOf(parsed.error));
  const file = parsed.data;
  const issues = checkResults(file, manifest);
  if (issues.length > 0) throw new PublishError(issues);
  const redacted = {
    ...file, generatedAtUtc, records: file.records.map(redactRecord),
    assistantEvidence: deepRedact(file.assistantEvidence), cohorts: deepRedact(file.cohorts),
  };
  const again = BenchmarkFileSchema.safeParse(redacted);
  if (!again.success) throw new PublishError(issuesOf(again.error));
  return again.data;
}

export function writePublished(file: BenchmarkFile, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
}
