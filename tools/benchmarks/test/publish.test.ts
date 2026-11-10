import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkFileSchema } from '@selarikru/view-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/canonical.ts';
import { main } from '../src/cli.ts';
import type { Manifest } from '../src/manifest.ts';
import { PublishError, preparePublish, REDACTED_VALUE } from '../src/publish.ts';
import { exportResults, recordHash } from '../src/report.ts';
import { FIXTURE_MANIFEST_PATH, SECRET, pairedWorkers, rawAssistant, rawWorker, resolvedManifest, started, verifierTree } from './fixtures.ts';
import { watchNetwork } from './network.ts';

const cohort = started();
const exported = () => exportResults({
  manifest: cohort.manifest, starts: cohort.starts, generatedAtUtc: '2026-11-20T10:00:00.000Z',
  records: [
    ...pairedWorkers(1).map((r) => ({ ...r, configuration: { ...r.configuration, providerAccountReference: 'acct-9f8e7d' } })),
    rawWorker({ mode: 'L1', block: 2, status: 'failed', failureDetail: `push to haz-macbook.local refused: ${SECRET}` }),
    { ...rawWorker({ mode: 'L1', block: 3 }), confounders: [`api_key=${SECRET}`] },
  ],
});
const publish = (file: unknown, at = '2026-11-21T08:30:00.000Z') => preparePublish(file, at, cohort.manifest);

describe('the scripted publish step', () => {
  it('redacts account, host and failure text, stamps generatedAtUtc, and still validates', () => {
    const published = publish(exported());
    expect(BenchmarkFileSchema.safeParse(published).success).toBe(true);
    expect(published.generatedAtUtc).toBe('2026-11-21T08:30:00.000Z');
    const text = JSON.stringify(published);
    for (const leaked of [SECRET, 'acct-9f8e7d', 'haz-macbook.local', 'arm64-laptop', 'cloud-run-x86']) expect(text).not.toContain(leaked);
    const l1 = published.records.find((r) => r.trialId === 'w-b1-L1')!;
    // Recorded-but-withheld stays distinguishable from never recorded.
    expect(l1.configuration.providerAccountReference).toBe(REDACTED_VALUE);
    expect(l1.configuration.localHost).toBe(REDACTED_VALUE);
    expect(l1.configuration.cloudHost).toBeNull();
    const failed = published.records.find((r) => r.trialId === 'w-b2-L1')!;
    expect(failed.failures).toEqual([{ category: 'failed', detail: null }]);
    // SHAs survive untouched.
    expect(l1.configuration.candidateSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('drops the unredacted hash and carries the hash of the redacted record instead', () => {
    const local = exported();
    const published = publish(local);
    for (const r of local.records) expect(r.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const r of published.records) {
      expect(r.resultSha256).toBeNull();
      const { resultSha256: _r, publishedSha256, measuredResultsPresent: _m, ...rest } = r;
      expect(publishedSha256).toBe(recordHash(rest));
    }
    // No published hash equals a local one.
    const localHashes = new Set(local.records.map((r) => r.resultSha256));
    expect(published.records.some((r) => localHashes.has(r.publishedSha256))).toBe(false);
  });

  it('a short dictionary of hosts and accounts cannot be confirmed from the published file', () => {
    const base = rawWorker({ mode: 'L1', block: 1 });
    const file = exportResults({
      manifest: cohort.manifest, starts: cohort.starts, generatedAtUtc: '2026-11-20T10:00:00.000Z',
      records: [{ ...base, configuration: { ...base.configuration, localHost: 'haz-macbook.local', providerAccountReference: 'acct-1' } }],
    });
    const published = publish(file);
    const text = JSON.stringify(published);
    const hashesInFile = new Set(text.match(/[0-9a-f]{64}/g) ?? []);
    const record = published.records[0]!;
    const { resultSha256: _r, publishedSha256: _p, measuredResultsPresent: _m, ...rest } = record;
    let tried = 0;
    for (const host of ['arm64-laptop', 'haz-mbp.local', 'haz-macbook.local']) {
      for (const acct of ['acct-0', 'acct-1']) {
        tried++;
        const failures = file.records[0]!.failures;
        const guess = { ...rest, failures, configuration: { ...rest.configuration, localHost: host, providerAccountReference: acct } };
        // Both ways a hash could be formed: with the hash fields left out, and the probe's way, with publishedSha256 kept.
        for (const candidate of [recordHash(guess), canonicalSha256({ ...guess, publishedSha256: null }), canonicalSha256({ ...guess, publishedSha256: record.publishedSha256 })]) {
          expect(hashesInFile.has(candidate)).toBe(false);
        }
      }
    }
    expect(tried).toBe(6);
  });

  it('refuses a file that does not validate, and a stamp that is not a UTC timestamp', () => {
    const file = exported();
    expect(() => publish({ ...file, records: [{ ...file.records[0]!, bonus: 1 }] })).toThrow(PublishError);
    expect(() => publish(file, 'yesterday')).toThrow(PublishError);
  });

  it('runs the same checks as export: a wrong clock, a repeated trial or another manifest is refused', () => {
    const wrongClock = structuredClone(exported());
    wrongClock.records[0]!.timings.clockDomain = 'host-wall';
    expect(() => publish(wrongClock)).toThrow(/server-monotonic/);
    const dup = structuredClone(exported());
    dup.records[1] = { ...dup.records[1]!, trialId: dup.records[0]!.trialId };
    expect(() => publish(dup)).toThrow(/one record per trial/);
    const other = structuredClone(cohort.manifest);
    other.environment.codingModel = 'another-model';
    expect(() => preparePublish(exported(), '2026-11-21T08:30:00.000Z', other)).toThrow(/another manifest/);
    // A published file still passes the checks, so the report can be built from it.
    expect(() => publish(publish(exported()))).not.toThrow();
  });
});

describe('the benchmark CLI', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const io = (env: Record<string, string> = { ANTHROPIC_API_KEY: SECRET }) => ({
    out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); }, env, now: () => '2026-11-21T08:30:00.000Z',
  });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bench-')); out = []; err = []; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A manifest frozen to a verifier tree on disk, so preflight can pass. */
  function setUp(over: (m: Manifest) => void = () => {}): { manifestPath: string; tree: string[] } {
    const t = verifierTree(dir);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resolvedManifest((m) => {
      m.repository.verifierSha256 = t.hashes.verifierSha256;
      m.repository.lockfileSha256 = t.hashes.lockfileSha256;
      over(m);
    }), null, 2));
    return { manifestPath, tree: ['--verifier', t.verifierRoot, '--repo', t.repoRoot] };
  }

  it('preflight, record-start, report and publish read and write files only: no fetch, socket, request or lookup', async () => {
    const { manifestPath, tree } = setUp();
    const recordsPath = join(dir, 'records.json');
    writeFileSync(recordsPath, JSON.stringify([...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4, status: 'failed', failureDetail: SECRET }), rawAssistant({ route: 'ONLY_IN_CLOUD', index: 0 })]));
    const resultsPath = join(dir, 'results.json');
    const publicPath = join(dir, 'public', 'benchmark-results.json');

    const net = watchNetwork();
    let codes: number[];
    try {
      codes = [
        await main(['preflight', '--manifest', manifestPath, ...tree], io()),
        await main(['record-start', '--track', 'workers', '--manifest', manifestPath, ...tree], io()),
        await main(['record-start', '--track', 'assistant', '--manifest', manifestPath, ...tree], io()),
        await main(['report', '--manifest', manifestPath, '--records', recordsPath, '--out', resultsPath], io()),
        await main(['publish', '--manifest', manifestPath, '--results', resultsPath, '--out', publicPath], io()),
      ];
    } finally {
      net.restore();
    }
    expect(net.calls()).toEqual([]);
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    expect(`${out.join('\n')}${err.join('\n')}`).not.toContain(SECRET);
    expect(existsSync(join(dir, 'cohort-start-workers.json'))).toBe(true);
    const published = BenchmarkFileSchema.parse(JSON.parse(readFileSync(publicPath, 'utf8')));
    expect(published.generatedAtUtc).toBe('2026-11-21T08:30:00.000Z');
    expect(published.records.every((r) => r.resultSha256 === null && r.publishedSha256 !== null)).toBe(true);
    expect(readFileSync(publicPath, 'utf8')).not.toContain(SECRET);
  });

  it('preflight recomputes the verifier and lockfile hashes from their files', async () => {
    const { manifestPath, tree } = setUp();
    writeFileSync(join(dir, 'repo/pnpm-lock.yaml'), 'lockfileVersion: moved');
    expect(await main(['preflight', '--manifest', manifestPath, ...tree], io())).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('lockfile_not_frozen');
    expect(text).toContain('verifier_not_frozen');
    expect(text).toContain('verifier_hashes_stale');
  });

  it('preflights the tracked fixture manifest and blocks it, listing unsupported modes', async () => {
    const code = await main(['preflight', '--manifest', FIXTURE_MANIFEST_PATH], io({}));
    expect(code).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('unresolved: cohortId');
    expect(text).toMatch(/C1.*Not measured/);
  });

  it('refuses an unknown command and a missing argument with a message, not a stack', async () => {
    expect(await main(['dispatch'], io())).toBe(2);
    expect(await main(['report'], io())).toBe(2);
    expect(await main(['record-start'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/usage/i);
  });

  it('record-start needs a passing preflight for the track it starts', async () => {
    const { manifestPath, tree } = setUp();
    // No API key: workers are blocked, the assistant is not.
    expect(await main(['record-start', '--track', 'workers', '--manifest', manifestPath, ...tree], io({}))).toBe(1);
    expect(err.join('\n')).toContain('api_key_missing: ANTHROPIC_API_KEY');
    expect(existsSync(join(dir, 'cohort-start-workers.json'))).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).starts.workers).toBeNull();
    expect(await main(['record-start', '--track', 'assistant', '--manifest', manifestPath, ...tree], io({}))).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).starts.assistant).toMatchObject({ startedAtUtc: '2026-11-21T08:30:00.000Z' });
  });

  it('freeze records a seed and order, and refuses after start, by the file or by the manifest alone', async () => {
    const { manifestPath, tree } = setUp((m) => { m.randomization = { ...m.randomization, seed: null, order: [], orderSha256: null, frozenAtUtc: null }; });
    expect(await main(['freeze', '--manifest', manifestPath, '--seed', 'seed-abc'], io())).toBe(0);
    const frozen = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(frozen.randomization).toMatchObject({ seed: 'seed-abc', frozenAtUtc: '2026-11-21T08:30:00.000Z' });
    expect(await main(['record-start', '--track', 'workers', '--manifest', manifestPath, ...tree], io())).toBe(0);
    expect(await main(['freeze', '--manifest', manifestPath, '--seed', 'seed-other'], io())).toBe(1);
    // Without the start file, the manifest's own stamp still refuses.
    rmSync(join(dir, 'cohort-start-workers.json'));
    expect(await main(['freeze', '--manifest', manifestPath, '--seed', 'seed-other'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/after start/);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).randomization.seed).toBe('seed-abc');
  });
});

describe('the network watcher', () => {
  it('records and refuses a call, so a silent network use would fail the tests above', () => {
    const net = watchNetwork();
    try {
      expect(() => fetch('https://example.invalid')).toThrow(/refused/);
    } finally {
      net.restore();
    }
    expect(net.calls()).toEqual(['fetch']);
  });
});
