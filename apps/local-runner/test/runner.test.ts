import dgram from 'node:dgram';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, pair } from '../src/credentials.ts';
import { RunnerLoop } from '../src/loop.ts';
import { HttpRunnerApi, assertSafeApiUrl } from '../src/api.ts';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { SbxRuntimeAdapter, sandboxName } from '@selarikru/runtime-docker-local';
import { makeWorld, WORLD_SCOPE, type World } from './world.ts';

let w: World | null = null;
let tmp: string | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.cleanup();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  w = null;
  tmp = null;
});

const deps = (w: World): AttemptDeps => ({
  api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo },
  codingWorkers: 'claude_code', heartbeatMs: 20, maxMissedHeartbeats: 3, cpus: 2, memoryMiB: 4096, log: (l) => w.logs.push(l),
});

describe('outbound-only', () => {
  it('no inbound listener opened: a full claim-run-publish cycle never listens, binds or serves', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen').mockImplementation(() => {
      throw new Error('listen() called');
    });
    const bind = vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(() => {
      throw new Error('bind() called');
    });
    w = await makeWorld({ agent: async ({ write }) => void (await write('src/x.ts', 'x')) });
    let n = 0;
    w.api.claim = vi.fn(async () => (n++ === 0 ? { lease: w!.lease, reason: null } : { lease: null, reason: 'nothing' }));
    const ctl = new AbortController();
    const loop = new RunnerLoop({ api: w.api, runtime: w.runtime, attempt: deps(w), pollMs: 10, sleep: async () => { if (n >= 2) ctl.abort(); }, log: () => undefined });
    await loop.run(ctl.signal);
    expect(w.api.published).toHaveLength(1);
    expect(listen).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    // no net.Server is alive in this process
    const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
    expect(handles.filter((h) => h instanceof net.Server)).toEqual([]);
  });

  it('the runner source has no server, listen, bind or websocket-server code path', async () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const banned = /\b(createServer|\.listen\(|\.bind\(|WebSocketServer|dgram|node:http2?['"]|node:https['"]|node:net['"]|node:tls['"]|fastify|express)\b/;
    for (const f of await readdir(dir)) {
      const text = await readFile(join(dir, f), 'utf8');
      expect(banned.test(text), f).toBe(false);
    }
  });
});

describe('RunnerLoop', () => {
  it('sweeps orphaned selarikru sandboxes at startup (never foreign ones), then claims and runs', async () => {
    w = await makeWorld({});
    w.sbx.addForeign('selarikru-spike-a');
    // an orphan from a previous run of this runner
    const orphan = sandboxName(WORLD_SCOPE, 'old-task', 'old-attempt');
    w.sbx.sandboxes.set(orphan, { status: 'stopped', mounts: [], workspaces: [], agent: 'claude' });
    const logs: string[] = [];
    w.api.claim = vi.fn(async () => ({ lease: null, reason: 'nothing_ready' }));
    const ctl = new AbortController();
    const loop = new RunnerLoop({ api: w.api, runtime: w.runtime, attempt: deps(w), pollMs: 5, sleep: async () => ctl.abort(), log: (l) => logs.push(l) });
    await loop.run(ctl.signal);
    expect(w.sbx.sandboxes.has(orphan)).toBe(false);
    expect(w.sbx.sandboxes.has('selarikru-spike-a')).toBe(true);
    expect(w.sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
    expect(logs.join('\n')).toContain('removed 1 orphaned');
  });

  it('C1: two runners on one machine never sweep each other\'s sandboxes, and a legacy unscoped one is left alone', async () => {
    w = await makeWorld({});
    // Another runner on the same sbx (for example T6.7's cloud-location runner, or a benchmark trial), with a live sandbox of its own.
    const other = new SbxRuntimeAdapter(w.sbx, { scope: 'ten:runner_other', home: '/Users/nobody', forbidden: [], attemptsRoot: null });
    const theirs = sandboxName('ten:runner_other', 'task1', 'att_1');
    w.sbx.sandboxes.set(theirs, { status: 'running', mounts: [], workspaces: [], agent: 'claude' });
    const legacy = 'selarikru-t12345678-a87654321';
    w.sbx.sandboxes.set(legacy, { status: 'stopped', mounts: [], workspaces: [], agent: 'claude' });
    const mine = sandboxName(WORLD_SCOPE, 'task1', 'att_1');
    w.sbx.sandboxes.set(mine, { status: 'stopped', mounts: [], workspaces: [], agent: 'claude' });
    w.api.claim = vi.fn(async () => ({ lease: null, reason: 'nothing_ready' }));
    const ctl = new AbortController();
    await new RunnerLoop({ api: w.api, runtime: w.runtime, attempt: deps(w), pollMs: 5, sleep: async () => ctl.abort(), log: () => undefined }).run(ctl.signal);
    expect(w.sbx.sandboxes.has(mine)).toBe(false);
    expect(w.sbx.sandboxes.has(theirs)).toBe(true);
    expect(w.sbx.sandboxes.has(legacy)).toBe(true);
    expect(await other.sweepOrphans(new Set([theirs]))).toEqual([]);
    expect(w.sbx.sandboxes.has(theirs)).toBe(true);
  });

  it('aborting the loop reaches the running attempt, which stops and cleans up, and the loop ends promptly', async () => {
    const ctl = new AbortController();
    w = await makeWorld({ agent: async () => { setTimeout(() => ctl.abort(), 50); return false; } });
    w.api.claim = vi.fn(async () => ({ lease: w!.lease, reason: null }));
    const loop = new RunnerLoop({ api: w.api, runtime: w.runtime, attempt: deps(w), pollMs: 10, log: () => undefined });
    const t0 = Date.now();
    await loop.run(ctl.signal);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
    expect(w.sbx.sandboxes.has(sandboxName(WORLD_SCOPE, 'task1', 'att_1'))).toBe(false);
    expect(w.api.published).toHaveLength(0);
  });

  it('runs one attempt at a time and backs off after a claim error without crashing', async () => {
    w = await makeWorld({});
    let calls = 0;
    w.api.claim = vi.fn(async () => {
      calls++;
      throw new Error('network down');
    });
    const ctl = new AbortController();
    const sleeps: number[] = [];
    const loop = new RunnerLoop({ api: w.api, runtime: w.runtime, attempt: deps(w), pollMs: 10, sleep: async (ms) => { sleeps.push(ms); if (calls >= 3) ctl.abort(); }, log: () => undefined });
    await loop.run(ctl.signal);
    expect(calls).toBe(3);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });
});

describe('pairing and credentials', () => {
  it('pairs with a code, stores the token 0600 in the state dir, and never returns or logs it', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pair-'));
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.test/v1/runners/enroll');
      expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer srp_code123456789012345678');
      return new Response(JSON.stringify({ runnerId: 'runner_1', token: 'srt_TOKENTOKENTOKENTOKEN1234', location: 'local', tenantId: 'ten' }), { status: 201 });
    });
    const out = await pair({ apiUrl: 'https://api.example.test', code: 'srp_code123456789012345678', label: 'laptop', stateDir: tmp, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.stringify(out)).not.toContain('TOKENTOKEN');
    expect(out).toMatchObject({ runnerId: 'runner_1', location: 'local' });
    const file = join(tmp, 'credentials.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await loadCredentials(tmp))!.token).toBe('srt_TOKENTOKENTOKENTOKEN1234');
  });

  it('refuses a cloud-location pairing code for a local runner, and a failed enrol stores nothing', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pair-'));
    const cloud = vi.fn(async () => new Response(JSON.stringify({ runnerId: 'r', token: 'srt_x', location: 'cloud', tenantId: 't' }), { status: 201 }));
    await expect(pair({ apiUrl: 'https://api.example.test', code: 'c', stateDir: tmp, fetchImpl: cloud as unknown as typeof fetch })).rejects.toThrow(/local/);
    const bad = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(pair({ apiUrl: 'https://api.example.test', code: 'c', stateDir: tmp, fetchImpl: bad as unknown as typeof fetch })).rejects.toThrow(/401/);
    expect(await loadCredentials(tmp)).toBeNull();
  });

  it('refuses credentials readable by others, and a non-https API URL except loopback', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pair-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmp, 'credentials.json'), JSON.stringify({ apiBaseUrl: 'https://a.test', runnerId: 'r', token: 'srt_x', location: 'local', tenantId: 't' }), { mode: 0o644 });
    await expect(loadCredentials(tmp)).rejects.toThrow(/permissions/);
    expect(() => assertSafeApiUrl('http://api.example.test')).toThrow();
    expect(() => assertSafeApiUrl('http://127.0.0.1:8080')).not.toThrow();
    expect(() => assertSafeApiUrl('http://localhost:8080')).not.toThrow();
    expect(() => assertSafeApiUrl('https://api.example.test')).not.toThrow();
  });
});

describe('HttpRunnerApi', () => {
  it('maps 409 to a lost lease and sends only outbound requests with the bearer token', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => (String(url).endsWith('/heartbeat') ? new Response('{}', { status: 409 }) : new Response(JSON.stringify({ lease: null, reason: 'x' }), { status: 200 })));
    const api = new HttpRunnerApi('https://api.example.test', 'srt_t', fetchImpl as unknown as typeof fetch);
    await expect(api.heartbeat({ attemptId: 'a', fence: 1, leaseToken: 't' })).rejects.toThrow(/lease/);
    expect(await api.claim()).toEqual({ lease: null, reason: 'x' });
    expect(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer srt_t' });
  });
});

void runAttempt;
