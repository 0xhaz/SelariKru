import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { LeaseLostError } from '../src/api.ts';
import { sandboxName } from '@selarikru/runtime-docker-local';
import { makeWorld, type World, type WorldOptions } from './world.ts';

let w: World | null = null;
afterEach(async () => {
  await w?.cleanup();
  w = null;
});

async function setup(o: WorldOptions = {}, over: Partial<AttemptDeps> = {}) {
  w = await makeWorld(o);
  const deps: AttemptDeps = {
    api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo },
    heartbeatMs: 20, maxMissedHeartbeats: 3, maxTurns: 8, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l), ...over,
  };
  return { w, deps };
}

const started = () => (w?.sbx.streams.length ?? 0) > 0;
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('runAttempt', () => {
  it('runs the agent in a sandbox, accepts a diff inside allowedPaths, publishes completed once, and cleans up', async () => {
    const { w, deps } = await setup({ agent: async ({ write }) => void (await write('src/new.ts', 'export const b = 2;\n')) });
    const report = await runAttempt(deps, w.lease);
    expect(w.api.published).toEqual([{ outcome: 'completed', reportedCostUsd: 0.05 }]);
    expect(report.outcome).toBe('completed');
    // the sandbox was created with a stable name, its workspace holds the pinned source, and calibration material is absent
    const name = sandboxName('task1', 'att_1');
    expect(w.sbx.calls.find((c) => c[0] === 'create')).toContain(name);
    expect(w.sbx.sandboxes.has(name)).toBe(false);
    expect(w.sbx.sandboxes.has('hq-askwell-jim')).toBe(true);
    expect(await exists(join(w.workRoot, 'attempts', 'att_1'))).toBe(false);
    // the change set went to the artifact store
    expect(report.changeManifest).toMatch(/^[0-9a-f]{64}$/);
    const manifest = JSON.parse(Buffer.from((await w.artifacts.get(report.changeManifest!))!).toString());
    expect(manifest.changes.map((c: { path: string }) => c.path)).toEqual(['src/new.ts']);
    expect(Buffer.from((await w.artifacts.get(manifest.changes[0].sha256))!).toString()).toBe('export const b = 2;\n');
  });

  it('diff outside allowedPaths rejected at completion', async () => {
    const { w, deps } = await setup({
      agent: async ({ write }) => {
        await write('src/ok.ts', 'ok');
        await write('contract/runtime.md', 'tampered');
      },
    });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.api.published).toHaveLength(1);
    expect(w.api.published[0]).toMatchObject({ outcome: 'failed' });
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/outside allowedPaths.*contract\/runtime\.md/);
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
  });

  it('sandbox failure never falls back to host mode', async () => {
    const { w, deps } = await setup({ fake: { failCreate: true, createLeavesOrphan: true } });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.api.published[0]).toMatchObject({ outcome: 'failed' });
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/sandbox/i);
    // no agent ever started, on the host or anywhere else
    expect(w.sbx.streams).toHaveLength(0);
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
    expect(w.sbx.calls.every((c) => ['ls', 'create', 'rm', '--version'].includes(c[0]!))).toBe(true);
  });

  it('an agent exec that cannot start fails the attempt; it is not retried elsewhere', async () => {
    const { w, deps } = await setup({ fake: { failExec: true } });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.sbx.streams).toHaveLength(1);
  });

  it('heartbeats every interval; cancelRequested stops the agent in the sandbox and publishes the outcome', async () => {
    const { w, deps } = await setup({ agent: async () => false, heartbeat: async (n) => ({ cancelRequested: n >= 3 && started() }) });
    const report = await runAttempt(deps, w.lease);
    expect(w.api.heartbeats).toBeGreaterThanOrEqual(3);
    expect(report.outcome).toBe('failed');
    expect(w.api.published).toHaveLength(1);
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/cancel/i);
    expect(w.sbx.calls.some((c) => c[0] === 'exec' && c.join(' ').includes('selarikru-attempt.pid') && c.join(' ').includes('kill -INT'))).toBe(true);
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
  });

  it('a lost lease stops the agent, publishes nothing, and still destroys the sandbox', async () => {
    const { w, deps } = await setup({
      agent: async () => false,
      heartbeat: async (n) => {
        if (n >= 2 && started()) throw new LeaseLostError();
        return { cancelRequested: false };
      },
    });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('lease_lost');
    expect(w.api.published).toHaveLength(0);
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
  });

  it('repeated heartbeat network failures stop the agent locally, because a replacement may already be scheduled', async () => {
    const { w, deps } = await setup({
      agent: async () => false,
      heartbeat: async (n) => {
        if (n >= 2 && started()) throw new Error('network down');
        return { cancelRequested: false };
      },
    });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('lease_lost');
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
  });

  it('a task that exceeds its timeout is stopped and reported failed', async () => {
    const { w, deps } = await setup({ agent: async () => false, task: { limits: { maxAttempts: 3, timeoutSeconds: 10, maxCostUsd: 1 } } }, { timeoutScale: 0.05 });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/timeout/i);
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
  });

  it('does not trust a workspace when the stop could not be confirmed: the attempt fails', async () => {
    const { w, deps } = await setup({ agent: async () => false, fake: { ignoreSignal: true, stopDoesNotStop: true }, heartbeat: async () => ({ cancelRequested: started() }) });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/not confirmed/i);
  });

  it('blocks, without creating a sandbox, when a secret would enter the prompt', async () => {
    const { w, deps } = await setup({ task: { title: 'use key sk-ant-api03-CANARYCANARYCANARY123456 to call' } });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('blocked');
    expect(w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
    expect(JSON.stringify(w.api.published)).not.toContain('CANARY');
  });

  it('blocks when no local source repository is configured for the project, or the task is cloud-only', async () => {
    const a = await setup({}, { repos: {} });
    expect((await runAttempt(a.deps, a.w.lease)).outcome).toBe('blocked');
    expect(a.w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
    await a.w.cleanup();
    const b = await setup({ task: { execution: 'cloud' } });
    expect((await runAttempt(b.deps, b.w.lease)).outcome).toBe('blocked');
  });

  it('blocks on a base that is not a full commit id', async () => {
    const { w, deps } = await setup({ task: { baseSha: 'main' } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('blocked');
  });

  it('the harness prompt carries no task body, and the workspace has no verifier calibration and has contract/runtime.md', async () => {
    let seen: { argv: string[]; files: string[] } | null = null;
    const { w, deps } = await setup({
      agent: async ({ cwd }) => {
        const { readdir } = await import('node:fs/promises');
        const argv = w!.sbx.calls.find((c) => c[0] === 'exec')!;
        seen = { argv: [...argv], files: await readdir(join(cwd, 'tools')).catch(() => []) };
        expect(await readFile(join(cwd, 'contract/runtime.md'), 'utf8')).toBe('# contract\n');
        expect(await readFile(join(cwd, 'TASK.md'), 'utf8')).toContain('Add the thing');
      },
    });
    await runAttempt(deps, w.lease);
    expect(seen!.files).toEqual([]);
    expect(seen!.argv.join(' ')).not.toContain('Add the thing');
  });

  it('cleans up even when publishing the result fails', async () => {
    const { w, deps } = await setup({ publishThrows: true });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('lease_lost');
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
    expect(await exists(join(w.workRoot, 'attempts', 'att_1'))).toBe(false);
  });

  it('logs never contain event content or secrets', async () => {
    const { w, deps } = await setup({ agent: async ({ stream }) => void stream.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'sk-ant-api03-CANARYCANARYCANARY123456' }] } })}\n`) });
    await runAttempt(deps, w.lease);
    expect(w.logs.join('\n')).not.toContain('CANARY');
  });
});
