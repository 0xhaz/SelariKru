import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SbxRuntimeAdapter, SandboxCreateError, STOP_SCRIPT } from './adapter.ts';
import { FakeSbx, type FakeOptions } from './fake-sbx.ts';
import { sandboxName } from './names.ts';
import type { SandboxSpec } from '@selarikru/protocol';

let root: string;
let ws: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'adapter-')));
  ws = join(root, 'attempts', 'a1', 'workspace');
  await mkdir(ws, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({ attemptId: 'a1', taskId: 't1', workspacePath: ws, cpus: 2, memoryMiB: 4096, ...over });
const make = (opts: FakeOptions = {}) => {
  const sbx = new FakeSbx(opts);
  sbx.addForeign('hq-askwell-jim');
  const rt = new SbxRuntimeAdapter(sbx, {
    home: '/Users/nobody',
    forbidden: ['/repo/selarikru'],
    attemptsRoot: join(root, 'attempts'),
    timeouts: { signalMs: 50, graceMs: 60, stopMs: 80, lsMs: 50, createMs: 500, rmMs: 100 },
  });
  return { sbx, rt };
};
const bundle = { attemptId: 'a1', command: ['claude', '-p', 'hi'], cwd: '/w' };

describe('SbxRuntimeAdapter.create', () => {
  it('creates a stable-named sandbox with exactly one mount and no env, ports, volumes or shared skills', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    expect(h.sandboxId).toBe(sandboxName('t1', 'a1'));
    const create = sbx.calls.find((c) => c[0] === 'create')!;
    expect(create.filter((a) => a === ws)).toHaveLength(1);
    expect(create.slice(-2)).toEqual(['claude', ws]);
    expect(create).toEqual(expect.arrayContaining(['--skills', 'off', '--cpus', '2', '--memory', '4096m']));
    for (const forbidden of ['-e', '--env', '--env-file', '-p', '--publish', '-v', '--volume', '--mount', '--cloud', '--clone', '--kit'])
      expect(create).not.toContain(forbidden);
    expect(create.join(' ')).not.toMatch(/docker\.sock|\.claude|\/Users\/nobody(\s|$)/);
  });

  it('home directory and Docker socket not mounted: refuses unsafe workspaces and destroys a sandbox whose mounts are not just the workspace', async () => {
    const { sbx, rt } = make();
    await expect(rt.create(spec({ workspacePath: '/Users/nobody' }))).rejects.toThrow(/unsafe workspace/);
    await expect(rt.create(spec({ workspacePath: '/repo/selarikru' }))).rejects.toThrow(/unsafe workspace/);
    expect(sbx.calls.some((c) => c[0] === 'create')).toBe(false);

    for (const extra of ['/Users/nobody:/home/agent', '/var/run/docker.sock:/var/run/docker.sock', '/Users/nobody/.claude:/home/agent/.claude']) {
      const m = make({ extraMounts: [extra] });
      await expect(m.rt.create(spec())).rejects.toBeInstanceOf(SandboxCreateError);
      expect(m.sbx.sandboxes.has(sandboxName('t1', 'a1'))).toBe(false);
    }
  });

  it('sandbox failure never falls back to host mode: create failure throws, removes any orphan, and runs nothing else', async () => {
    const { sbx, rt } = make({ failCreate: true, createLeavesOrphan: true });
    await expect(rt.create(spec())).rejects.toBeInstanceOf(SandboxCreateError);
    expect(sbx.sandboxes.has(sandboxName('t1', 'a1'))).toBe(false);
    expect(sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
    const verbs = new Set(sbx.calls.map((c) => c[0]));
    expect([...verbs].every((v) => ['--version', 'ls', 'create', 'rm', 'stop'].includes(v!))).toBe(true);
    expect(sbx.streams).toHaveLength(0);
  });

  it('start on a sandbox that failed to start does not run anything on the host', async () => {
    const { sbx, rt } = make({ failExec: true });
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    expect(await a.exited).toEqual({ code: 125, signal: null });
    expect(sbx.calls.filter((c) => c[0] === 'exec')).toHaveLength(1);
  });

  it('reconciles an older worker of the same task by stable name before creating, and leaves other sandboxes alone', async () => {
    const { sbx, rt } = make();
    const old = await rt.create(spec({ attemptId: 'old', workspacePath: await mk('old') }));
    const oldStream = (await rt.start(old, { ...bundle, attemptId: 'old' })) ;
    const other = await rt.create(spec({ taskId: 'other-task', attemptId: 'x', workspacePath: await mk('x') }));
    sbx.calls.length = 0;
    const fresh = await rt.create(spec());
    expect(sbx.sandboxes.has(old.sandboxId)).toBe(false);
    expect(await oldStream.exited).toBeTruthy();
    expect(sbx.sandboxes.has(other.sandboxId)).toBe(true);
    expect(sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
    expect(sbx.sandboxes.has(fresh.sandboxId)).toBe(true);
    const rmIdx = sbx.calls.findIndex((c) => c[0] === 'rm');
    const createIdx = sbx.calls.findIndex((c) => c[0] === 'create');
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(createIdx);
    expect(sbx.calls.flat().join(' ')).not.toContain('hq-askwell');
  });

  async function mk(n: string): Promise<string> {
    const p = join(root, 'attempts', n, 'workspace');
    await mkdir(p, { recursive: true });
    return p;
  }
});

describe('SbxRuntimeAdapter start/stop/inspect/destroy', () => {
  it('start runs the command through exec in the sandbox workdir, wrapped to record its pid, with stdin closed on request', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    const exec = sbx.calls.find((c) => c[0] === 'exec')!;
    expect(exec.slice(0, 4)).toEqual(['exec', '-w', '/w', h.sandboxId]);
    expect(exec.slice(-3)).toEqual(['claude', '-p', 'hi']);
    expect(exec.join(' ')).toContain('selarikru-attempt.pid');
    sbx.streams[0]!.push('{"a":1}\n');
    sbx.streams[0]!.end(0);
    const got: string[] = [];
    for await (const c of a.output) got.push(c);
    expect(got.join('')).toBe('{"a":1}\n');
    expect(await a.exited).toEqual({ code: 0, signal: null });
  });

  it('stop signals inside the sandbox first and confirms from the run ending, with no sandbox stop needed', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    const ack = await rt.stop(a);
    expect(ack).toMatchObject({ status: 'stopped', terminationConfirmed: true, escalated: false });
    expect(sbx.calls.some((c) => c.join(' ').includes(STOP_SCRIPT))).toBe(true);
    expect(sbx.calls.some((c) => c[0] === 'stop')).toBe(false);
  });

  it('stop escalates to sbx stop when the signal does not end the agent, then confirms by sbx ls', async () => {
    const { sbx, rt } = make({ ignoreSignal: true });
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    const ack = await rt.stop(a);
    expect(ack).toMatchObject({ status: 'stopped', terminationConfirmed: true, escalated: true });
    const verbs = sbx.calls.map((c) => c[0]);
    expect(verbs.lastIndexOf('stop')).toBeLessThan(verbs.lastIndexOf('ls'));
    expect(sbx.sandboxes.get(h.sandboxId)!.status).toBe('stopped');
  });

  it('a run that ended only because we killed the host client is not evidence the agent stopped', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    a.killClient();
    await a.exited;
    const ack = await rt.stop(a);
    expect(ack).toMatchObject({ status: 'stopped', terminationConfirmed: true, escalated: true });
    expect(sbx.calls.some((c) => c[0] === 'stop')).toBe(true);
  });

  it('stop is bounded: a hung sbx stop yields stop_failed, not a hang', async () => {
    const { rt } = make({ ignoreSignal: true, hangStop: true });
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    const t0 = Date.now();
    const ack = await rt.stop(a);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(ack).toMatchObject({ status: 'stop_failed', terminationConfirmed: false, escalated: true });
    expect(ack.detail).toBeTruthy();
  });

  it('stop does not confirm when sbx stop succeeds but ls still shows the sandbox running', async () => {
    const { rt } = make({ ignoreSignal: true, stopDoesNotStop: true });
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    expect(await rt.stop(a)).toMatchObject({ status: 'stop_failed', terminationConfirmed: false });
  });

  it('stop on an already stopped sandbox does not exec into it (exec would restart it)', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    const a = await rt.start(h, bundle);
    sbx.sandboxes.get(h.sandboxId)!.status = 'stopped';
    sbx.streams[0]!.end(143);
    sbx.calls.length = 0;
    const ack = await rt.stop(a);
    expect(ack).toMatchObject({ status: 'stopped', terminationConfirmed: true });
    expect(sbx.calls.some((c) => c[0] === 'exec')).toBe(false);
  });

  it('inspect reports running, stopped (normal) and absent; destroy is idempotent and never touches foreign sandboxes', async () => {
    const { sbx, rt } = make();
    const h = await rt.create(spec());
    expect((await rt.inspect(h)).state).toBe('stopped');
    await rt.start(h, bundle);
    expect(await rt.inspect(h)).toMatchObject({ state: 'running', exists: true });
    await rt.destroy(h);
    await rt.destroy(h);
    expect(await rt.inspect(h)).toMatchObject({ state: 'absent', exists: false });
    await expect(rt.destroy({ ...h, sandboxId: 'hq-askwell-jim' })).rejects.toThrow(/not a selarikru-managed sandbox/);
    expect(sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
  });

  it('capabilities report the observed sbx version and no host fallback', async () => {
    const { rt } = make();
    expect(await rt.capabilities()).toMatchObject({ location: 'local', runtimeVersion: 'v0.51.0', hostFallback: false, stopAcknowledgement: 'confirmed' });
  });

  it('sweepOrphans removes only our sandboxes that no active attempt owns', async () => {
    const { sbx, rt } = make();
    const a = await rt.create(spec());
    const b = await rt.create(spec({ taskId: 't2', attemptId: 'b', workspacePath: await (async () => { const p = join(root, 'attempts', 'b', 'workspace'); await mkdir(p, { recursive: true }); return p; })() }));
    sbx.addForeign('selarikru-spike-a');
    const removed = await rt.sweepOrphans(new Set([a.sandboxId]));
    expect(removed).toEqual([b.sandboxId]);
    expect(sbx.sandboxes.has(a.sandboxId)).toBe(true);
    expect(sbx.sandboxes.has('selarikru-spike-a')).toBe(true);
    expect(sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
  });
});
