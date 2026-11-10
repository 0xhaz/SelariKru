import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@selarikru/protocol';
import { BenchmarkFileSchema, type BenchmarkFile, type BenchmarkRecord } from '@selarikru/view-protocol';

/**
 * The scripted publish step: validate a results file, redact what must not leave this machine, stamp the time, and
 * validate again. The web panel reads the output from apps/control-web/public. Account, host and failure text are
 * replaced (a recorded value becomes `redacted`, so it stays distinguishable from never recorded), and every other
 * string goes through `redactSecrets`. Writes one file; no network.
 *
 * `resultSha256` is the hash of the raw record as exported, before redaction, so it identifies the full record held
 * locally rather than the published copy.
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
  return deepRedact({
    ...r,
    configuration: { ...r.configuration, providerAccountReference: withheld(r.configuration.providerAccountReference), localHost: withheld(r.configuration.localHost), cloudHost: withheld(r.configuration.cloudHost) },
    failures: r.failures.map((f) => ({ category: f.category, detail: null })),
  });
}

const issuesOf = (e: z.ZodError): string[] => e.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);

export function preparePublish(input: unknown, generatedAtUtc: string): BenchmarkFile {
  if (!UtcStamp.safeParse(generatedAtUtc).success) throw new PublishError(['generatedAtUtc must be a UTC ISO timestamp']);
  const parsed = BenchmarkFileSchema.safeParse(input);
  if (!parsed.success) throw new PublishError(issuesOf(parsed.error));
  const file = parsed.data;
  const redacted = { ...file, generatedAtUtc, records: file.records.map(redactRecord), assistantEvidence: deepRedact(file.assistantEvidence), cohorts: deepRedact(file.cohorts) };
  const again = BenchmarkFileSchema.safeParse(redacted);
  if (!again.success) throw new PublishError(issuesOf(again.error));
  return again.data;
}

export function writePublished(file: BenchmarkFile, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
}
