import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import { IN_REPO_STARTER } from '../src/workers/dry-run.ts';
import { starterRepoFrom } from '../src/workers/isolation.ts';
import { FIXTURE_MANIFEST_PATH, resolvedManifest } from './fixtures.ts';
import { watchNetwork } from './network.ts';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test';

let dir: string;
let lines: string[];
const io = (env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'present' }): Io => ({
  out: (s) => lines.push(s), err: (s) => lines.push(s), env, now: () => '2026-11-20T10:00:00.000Z', cwd: dir,
});

beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-run-cli-'))); lines = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the runner commands', () => {
  it('refuse --live on the tracked manifest before connecting or dispatching anything, and write no records', async () => {
    const net = watchNetwork();
    try {
      const records = join(dir, 'records.json');
      expect(await main(['run-workers', '--live', '--manifest', FIXTURE_MANIFEST_PATH, '--records', records, '--starter', dir], io())).toBe(1);
      expect(lines.join('\n')).toMatch(/live dispatch refused: .*budget_not_authorized/);
      expect(await main(['run-assistant', '--live', '--manifest', FIXTURE_MANIFEST_PATH, '--records', records, '--cdp', 'http://127.0.0.1:9222', '--bench-url', 'https://selarikru.web.app/bench.html'], io())).toBe(1);
      expect(existsSync(records)).toBe(false);
      expect(net.calls()).toEqual([]);
      expect(lines.join('\n')).not.toContain('present');
    } finally {
      net.restore();
    }
  });

  it('need exactly one of --live and --dry-run', async () => {
    expect(await main(['run-workers', '--records', join(dir, 'r.json')], io())).toBe(2);
    expect(await main(['run-assistant', '--live', '--dry-run', '--records', join(dir, 'r.json')], io())).toBe(2);
  });

  it('an assistant dry run writes simulated records, the setup ledger and outputs, and the report reads them, with no network', async () => {
    const net = watchNetwork();
    try {
      const manifestPath = join(dir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(resolvedManifest()));
      const records = join(dir, 'assistant.json');
      expect(await main(['run-assistant', '--dry-run', '--manifest', manifestPath, '--records', records], io()), lines.join('\n')).toBe(0);
      const written = JSON.parse(readFileSync(records, 'utf8')) as { dataKind: string }[];
      expect(written).toHaveLength(64);
      expect(written.every((r) => r.dataKind === 'simulated')).toBe(true);
      expect(JSON.parse(readFileSync(`${records}.setup.json`, 'utf8'))).toHaveLength(2);
      expect(JSON.parse(readFileSync(`${records}.outputs.json`, 'utf8'))).toHaveLength(64);
      expect(await main(['report', '--manifest', manifestPath, '--records', records], io())).toBe(0);
      // Run again: every slot already has a final outcome, so nothing is added.
      expect(await main(['run-assistant', '--dry-run', '--manifest', manifestPath, '--records', records], io())).toBe(0);
      expect(JSON.parse(readFileSync(records, 'utf8'))).toHaveLength(64);
      expect(net.calls()).toEqual([]);
    } finally {
      net.restore();
    }
  });

  it('a worker dry run records L1 through the real product and C1 and H2 as Not measured', async () => {
    const files = execFileSync('git', ['-C', IN_REPO_STARTER, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const starter = join(dir, 'starter');
    const sha = starterRepoFrom(IN_REPO_STARTER, starter, files);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resolvedManifest((m) => { m.repository.starterSha = sha; m.workers.attemptsPerRequiredMode = 1; })));
    const records = join(dir, 'workers.json');
    expect(await main(['run-workers', '--dry-run', '--manifest', manifestPath, '--records', records, '--starter', starter], io({ DATABASE_URL })), lines.join('\n')).toBe(0);
    const written = JSON.parse(readFileSync(records, 'utf8')) as { mode: string; status: string }[];
    expect(written.map((r) => [r.mode, r.status]).sort()).toEqual([['C1', 'not_run'], ['H2', 'not_run'], ['L1', 'completed']]);
    expect(JSON.parse(readFileSync(`${records}.budget.json`, 'utf8')).spentUsd).toBeCloseTo(0.1);
    expect(lines.join('\n')).not.toContain('selarikru_test:');
    expect(await main(['report', '--manifest', manifestPath, '--records', records], io())).toBe(0);
  }, 60_000);

  it('D6: with the tracked cli_login mode, preflight blocks the workers track until the CLI probe says logged in, and prints no account details', async () => {
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(resolvedManifest((m) => { m.credentials.mode = 'cli_login'; })));
    const probeIo = (status: { present: boolean; loggedIn: boolean | null; sandboxSecret?: boolean | null } | null): Io => ({ ...io({}), ...(status ? { cliLogin: async () => status } : {}) });
    expect(await main(['run-workers', '--live', '--manifest', manifestPath, '--records', join(dir, 'r.json'), '--starter', dir], probeIo(null))).toBe(1);
    expect(lines.join('\n')).toMatch(/claude_cli_login_unchecked/);
    lines = [];
    expect(await main(['run-workers', '--live', '--manifest', manifestPath, '--records', join(dir, 'r.json'), '--starter', dir], probeIo({ present: true, loggedIn: false }))).toBe(1);
    expect(lines.join('\n')).toMatch(/claude_cli_not_logged_in/);
    lines = [];
    // Logged in: the credential check passes; the track is still refused for its other blockers (here the frozen hashes and no start).
    expect(await main(['run-workers', '--live', '--manifest', manifestPath, '--records', join(dir, 'r.json'), '--starter', dir], probeIo({ present: true, loggedIn: true, sandboxSecret: true }))).toBe(1);
    expect(lines.join('\n')).toMatch(/live dispatch refused: .*cohort_not_started: workers/);
    expect(lines.join('\n')).not.toMatch(/claude_cli_|sbx_anthropic_/);
    expect(lines.join('\n')).not.toMatch(/api_key_missing|@/);
  });
});
