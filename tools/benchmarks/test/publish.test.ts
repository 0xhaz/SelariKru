import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkFileSchema } from '@selarikru/view-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { PublishError, preparePublish, REDACTED_VALUE } from '../src/publish.ts';
import { exportResults } from '../src/report.ts';
import { FIXTURE_MANIFEST_PATH, HASHES, SECRET, pairedWorkers, rawWorker, resolvedManifest } from './fixtures.ts';
import { watchNetwork } from './network.ts';

const exported = () => exportResults({
  manifest: resolvedManifest(), manifestSha256: 'e'.repeat(64), generatedAtUtc: '2026-11-20T10:00:00.000Z',
  records: [
    ...pairedWorkers(1).map((r) => ({ ...r, configuration: { ...r.configuration, providerAccountReference: 'acct-9f8e7d' } })),
    rawWorker({ mode: 'L1', block: 2, status: 'failed', failureDetail: `push to haz-macbook.local refused: ${SECRET}` }),
    { ...rawWorker({ mode: 'L1', block: 3 }), confounders: [`api_key=${SECRET}`] },
  ],
});

describe('the scripted publish step', () => {
  it('redacts account, host and failure text, stamps generatedAtUtc, and still validates', () => {
    const published = preparePublish(exported(), '2026-11-21T08:30:00.000Z');
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
    // Hashes and SHAs survive untouched.
    expect(l1.configuration.candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(l1.resultSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a file that does not validate, and a stamp that is not a UTC timestamp', () => {
    const file = exported();
    expect(() => preparePublish({ ...file, records: [{ ...file.records[0]!, bonus: 1 }] }, '2026-11-21T08:30:00.000Z')).toThrow(PublishError);
    expect(() => preparePublish(file, 'yesterday')).toThrow(PublishError);
  });
});

describe('the benchmark CLI', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const io = () => ({ out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); }, env: { ANTHROPIC_API_KEY: SECRET }, now: () => '2026-11-21T08:30:00.000Z' });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bench-')); out = []; err = []; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('preflight, report and publish read and write files only: no fetch, socket, request or lookup', async () => {
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resolvedManifest(), null, 2));
    const hashesPath = join(dir, 'HASHES.json');
    writeFileSync(hashesPath, JSON.stringify(HASHES));
    const lockPath = join(dir, 'pnpm-lock.yaml');
    writeFileSync(lockPath, 'lockfile');
    const recordsPath = join(dir, 'records.json');
    writeFileSync(recordsPath, JSON.stringify([...pairedWorkers(3), rawWorker({ mode: 'L1', block: 4, status: 'failed', failureDetail: SECRET })]));
    const resultsPath = join(dir, 'results.json');
    const publicPath = join(dir, 'public', 'benchmark-results.json');

    const net = watchNetwork();
    let codes: number[];
    try {
      codes = [
        await main(['preflight', '--manifest', manifestPath, '--hashes', hashesPath, '--lockfile', lockPath], io()),
        await main(['report', '--manifest', manifestPath, '--records', recordsPath, '--out', resultsPath], io()),
        await main(['publish', '--results', resultsPath, '--out', publicPath], io()),
      ];
    } finally {
      net.restore();
    }
    expect(net.calls()).toEqual([]);
    // The lockfile here is not the frozen one, so preflight reports blocked (exit 1); report and publish succeed.
    expect(codes).toEqual([1, 0, 0]);
    expect(out.join('\n')).toContain('lockfile_not_frozen');
    expect(`${out.join('\n')}${err.join('\n')}`).not.toContain(SECRET);
    expect(existsSync(publicPath)).toBe(true);
    const published = BenchmarkFileSchema.parse(JSON.parse(readFileSync(publicPath, 'utf8')));
    expect(published.generatedAtUtc).toBe('2026-11-21T08:30:00.000Z');
    expect(readFileSync(publicPath, 'utf8')).not.toContain(SECRET);
  });

  it('preflights the tracked fixture manifest and blocks it, listing unsupported modes', async () => {
    const code = await main(['preflight', '--manifest', FIXTURE_MANIFEST_PATH], { ...io(), env: {} });
    expect(code).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('unresolved: cohortId');
    expect(text).toMatch(/C1.*Not measured/);
  });

  it('refuses an unknown command and a missing argument with a message, not a stack', async () => {
    expect(await main(['dispatch'], io())).toBe(2);
    expect(await main(['report'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/usage/i);
  });

  it('freeze records a seed and order, and refuses after start', async () => {
    const manifestPath = join(dir, 'manifest.json');
    const m = resolvedManifest();
    m.randomization = { ...m.randomization, seed: null, order: [], orderSha256: null, frozenAtUtc: null };
    writeFileSync(manifestPath, JSON.stringify(m));
    expect(await main(['freeze', '--manifest', manifestPath, '--seed', 'seed-abc'], io())).toBe(0);
    const frozen = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(frozen.randomization).toMatchObject({ seed: 'seed-abc', frozenAtUtc: '2026-11-21T08:30:00.000Z' });
    const startPath = join(dir, 'start.json');
    expect(await main(['record-start', '--manifest', manifestPath, '--start', startPath], io())).toBe(0);
    expect(await main(['freeze', '--manifest', manifestPath, '--seed', 'seed-other', '--start', startPath], io())).toBe(1);
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
