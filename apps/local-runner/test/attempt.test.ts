import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { restrictedReason, type RestrictedOutcome } from '@selarikru/domain';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTaskFile, runAttempt, storeChanges, type AttemptDeps } from '../src/attempt.ts';
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

describe('completion gate hardening', () => {
  it('invalid allowedPaths (absolute, parent, glob) block the task before any sandbox exists', async () => {
    for (const bad of ['/etc', '../x', 'src/**']) {
      const { w, deps } = await setup({ task: { allowedPaths: [bad] } });
      const report = await runAttempt(deps, w.lease);
      expect(report.outcome, bad).toBe('blocked');
      expect(w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
      expect((w.api.published[0] as { reason: string }).reason).toMatch(/allowedPaths/);
      await w.cleanup();
    }
  });

  it('a symlink in the workspace is a failed verdict, not a thrown error and not a host file read', async () => {
    const { w, deps } = await setup({ agent: async ({ cwd }) => void (await symlink('/etc/hosts', join(cwd, 'src/evil'))) });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.api.published).toHaveLength(1);
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/symlink/);
    expect(JSON.stringify(await w.artifacts.get(report.changeManifest ?? 'a'.repeat(64)).catch(() => null))).toBe('null');
  });

  it('an artifact-store failure at completion publishes failed instead of leaving the lease to expire', async () => {
    const { w, deps } = await setup({ agent: async ({ write }) => void (await write('src/n.ts', 'n')) });
    const broken = { ...w.artifacts, put: async () => { throw new Error('disk full'); }, get: w.artifacts.get.bind(w.artifacts), has: w.artifacts.has.bind(w.artifacts) };
    const report = await runAttempt({ ...deps, artifacts: broken }, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.api.published).toHaveLength(1);
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/store/i);
  });

  it('storeChanges refuses a file whose bytes no longer match the checked hash, and a file that became a symlink', async () => {
    const { w } = await setup({});
    const ws = join(w.root, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'a.txt'), 'changed-after-check');
    const task = w.task;
    await expect(storeChanges(w.artifacts, ws, [{ path: 'a.txt', status: 'modified', kind: 'file', sha256: 'f'.repeat(64), linkTarget: null }], task)).rejects.toThrow(/changed/);
    await symlink('/etc/hosts', join(ws, 'l.txt'));
    await expect(storeChanges(w.artifacts, ws, [{ path: 'l.txt', status: 'added', kind: 'file', sha256: 'f'.repeat(64), linkTarget: null }], task)).rejects.toThrow();
  });
});

describe('activity on the heartbeat', () => {
  it('reports the tool name and nothing else, and drops a name the wire would refuse', async () => {
    const { w, deps } = await setup({
      agent: async ({ stream }) => {
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Edit', input: { file_path: '/secret/path' } }] } })}\n`);
        await new Promise((r) => setTimeout(r, 90));
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b2', name: 'not a tool name; rm -rf', input: {} }] } })}\n`);
        await new Promise((r) => setTimeout(r, 60));
      },
    });
    await runAttempt(deps, w.lease);
    const reported = (w.api.heartbeat as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1]).filter((a) => a !== undefined);
    // Reported once for the one start: a heartbeat afterwards says only that the runner is alive.
    expect(reported).toEqual(['Edit']);
  });

  it('a tool that hangs is reported once while heartbeats continue', async () => {
    const { w, deps } = await setup({
      agent: async ({ stream }) => {
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } })}\n`);
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    await runAttempt(deps, w.lease);
    const calls = (w.api.heartbeat as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.filter((c) => c[1] !== undefined).map((c) => c[1])).toEqual(['Bash']);
  });

  it('a second start of the same tool is a new report, and a failed heartbeat keeps it pending', async () => {
    let failOnce = true;
    const { w, deps } = await setup({
      heartbeat: async () => {
        if (failOnce) { failOnce = false; throw new Error('blip'); }
        return { cancelRequested: false };
      },
      agent: async ({ stream }) => {
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Edit', input: {} }] } })}\n`);
        await new Promise((r) => setTimeout(r, 70));
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b2', name: 'Edit', input: {} }] } })}\n`);
        await new Promise((r) => setTimeout(r, 70));
      },
    });
    await runAttempt(deps, w.lease);
    const reported = (w.api.heartbeat as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1]).filter((a) => a !== undefined);
    expect(reported.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reported)).toEqual(new Set(['Edit']));
  });
});

describe('the approval signal file', () => {
  it('a request written by Bash is not a signal: the file fails the attempt through the diff gate', async () => {
    const { w, deps } = await setup({
      agent: async ({ stream, cwd, write }) => {
        await write('.selarikru/approval-request.json', '{"operation":"destructive_data_migration","reason":"x"}');
        stream.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `echo '{}' > ${cwd}/.selarikru/approval-request.json` } }] } })}\n`);
      },
    });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/reserved \.selarikru/);
  });
});

describe('a restricted attempt keeps the agent\'s words on this machine', () => {
  const WORDS = 'drop the patients table holding RESTRICTED-CANARY rows';
  const signal = (cwd: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Write', input: { file_path: join(cwd, '.selarikru/approval-request.json'), content: JSON.stringify({ operation: 'destructive_data_migration', reason: WORDS }) } }] } });

  it.each([[false, false], [true, true]] as const)('streamable %s: the published approval reason carries the agent\'s words: %s', async (streamable, carries) => {
    const { w, deps } = await setup({ streamable, agent: async ({ stream, cwd }) => { stream.push(`${signal(cwd)}\n`); return false; } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('approval_requested');
    const sent = w.api.published[0] as { reason: string; operation: string };
    expect(sent.operation).toBe('destructive_data_migration');
    if (carries) expect(sent.reason).toBe(WORDS);
    else {
      expect(sent.reason).not.toContain('RESTRICTED-CANARY');
      expect(sent.reason).toMatch(/destructive_data_migration/);
      expect(w.logs.join('\n')).toContain('RESTRICTED-CANARY');
    }
  });

  it('a diff outside allowedPaths is reported by count only, with the paths in the runner\'s log', async () => {
    const { w, deps } = await setup({ streamable: false, agent: async ({ write }) => { await write('src/ok.ts', 'ok'); await write('secret-plans/RESTRICTED-CANARY.md', 'x'); } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('failed');
    const reason = (w.api.published[0] as { reason: string }).reason;
    expect(reason).toMatch(/^diff outside allowedPaths: 1 path\(s\)/);
    expect(reason).not.toContain('RESTRICTED-CANARY');
    expect(w.logs.join('\n')).toContain('RESTRICTED-CANARY');
  });
});

describe('a restricted attempt publishes a category from the closed list for every error branch', () => {
  const CANARY = 'RESTRICTED-CANARY';
  const brokenStore = (w: World) => ({ ...w.artifacts, put: async () => { throw new Error(`ENOSPC writing secret/${CANARY}.md`); }, get: w.artifacts.get.bind(w.artifacts), has: w.artifacts.has.bind(w.artifacts) });
  // The last field: whether the runner's own sentence for that branch names the canary, so its log has to hold it.
  const cases: [string, WorldOptions, (w: World, deps: AttemptDeps) => AttemptDeps, string, boolean][] = [
    ['the change set cannot be stored', { agent: async ({ write }) => void (await write(`src/${CANARY}.ts`, 'n')) }, (w, d) => ({ ...d, artifacts: brokenStore(w) }), 'failed', true],
    ['the diff cannot be computed', { agent: async ({ cwd }) => { await mkdir(join(cwd, 'src', CANARY)); await chmod(join(cwd, 'src', CANARY), 0o000); } }, (_w, d) => d, 'failed', true],
    ['allowedPaths are invalid', { task: { allowedPaths: [`/${CANARY}`] } }, (_w, d) => d, 'blocked', true],
    ['an MCP server connected', { initMcp: [{ name: CANARY, status: 'connected' }] }, (_w, d) => d, 'failed', true],
    ['the stream reports another model', { initModel: CANARY }, (_w, d) => d, 'blocked', true],
    ['the toolchain pin cannot be resolved', { baseFiles: { 'package.json': JSON.stringify({ packageManager: 'pnpm@10.11.0' }), '.nvmrc': `${CANARY}\n` } }, (_w, d) => d, 'blocked', false],
    ['the task bundle cannot be built', {}, (w, d) => ({ ...d, repos: { proj1: join(w.root, CANARY) } }), 'failed', false],
  ];

  const category: Record<string, string> = {
    'the change set cannot be stored': 'change_set_store_failed', 'the diff cannot be computed': 'diff_failed', 'allowedPaths are invalid': 'allowed_paths_invalid',
    'an MCP server connected': 'unexpected_mcp_server', 'the stream reports another model': 'model_mismatch', 'the toolchain pin cannot be resolved': 'toolchain_unresolved',
    'the task bundle cannot be built': 'task_bundle_failed',
  };

  it.each(cases)('when %s', async (name, world, adjust, outcome, named) => {
    const { w, deps } = await setup({ ...world, streamable: false });
    try {
      expect((await runAttempt(adjust(w, deps), w.lease)).outcome).toBe(outcome);
    } finally {
      await chmod(join(w.workRoot, 'attempts', 'att_1', 'workspace', 'src', CANARY), 0o755).catch(() => undefined);
    }
    expect(w.api.published).toHaveLength(1);
    const sent = w.api.published[0] as { outcome: string; reason: string };
    expect(sent.outcome).toBe(outcome);
    expect(JSON.stringify(sent)).not.toContain(CANARY);
    // The closed list keeps it as sent: nothing outside it left this machine.
    expect(restrictedReason(outcome as RestrictedOutcome, sent.reason)).toBe(sent.reason);
    expect(sent.reason).toBe(category[name]);
    // The detail is not lost: it is in this runner's own log.
    if (named) expect(w.logs.join('\n')).toContain(CANARY);
  });

  it('streamable work still publishes the detail', async () => {
    const { w, deps } = await setup({ agent: async ({ write }) => void (await write('src/n.ts', 'n')) });
    await runAttempt({ ...deps, artifacts: brokenStore(w) }, w.lease);
    expect((w.api.published[0] as { reason: string }).reason).toContain(CANARY);
  });
});

describe('MCP and tool restriction', () => {
  it('launches the agent with an empty strict MCP config and the explicit tool list', async () => {
    const { w, deps } = await setup({});
    await runAttempt(deps, w.lease);
    const exec = w.sbx.calls.find((c) => c[0] === 'exec' && c.includes('claude'))!.join(' ');
    expect(exec).toContain('--strict-mcp-config');
    expect(exec).toContain('--mcp-config={"mcpServers":{}}');
    expect(exec).toMatch(/--tools=Bash,Read,Write,Edit,Glob,Grep/);
    expect(exec).not.toMatch(/WebFetch|WebSearch/);
  });

  it('fails the attempt, stopping the agent, when the init event reports a connected MCP server', async () => {
    const { w, deps } = await setup({ initMcp: [{ name: 'mcp-gateway', status: 'connected' }], agent: async ({ write }) => void (await write('src/n.ts', 'n')) });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/MCP server.*mcp-gateway/);
  });

  it('a server that is merely listed as needing auth is not treated as connected', async () => {
    const { w, deps } = await setup({ initMcp: [{ name: 'gmail', status: 'needs-auth' }], agent: async ({ write }) => void (await write('src/n.ts', 'n')) });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
  });
});

describe('in-guest limit and runner shutdown', () => {
  it('passes the attempt timeout to the sandbox as an in-guest limit', async () => {
    const { w, deps } = await setup({ task: { limits: { maxAttempts: 3, timeoutSeconds: 600, maxCostUsd: 1 } } });
    await runAttempt(deps, w.lease);
    const exec = w.sbx.calls.find((c) => c[0] === 'exec' && c.includes('claude'))!.join(' ');
    expect(exec).toMatch(/timeout -k 10 (\d+) /);
    expect(Number(/timeout -k 10 (\d+) /.exec(exec)![1])).toBeLessThanOrEqual(600);
  });

  it('an abort signal (SIGTERM/SIGINT) stops the agent with a bounded stop, destroys the sandbox, and publishes nothing', async () => {
    const ctl = new AbortController();
    const { w, deps } = await setup({ agent: async () => { setTimeout(() => ctl.abort(), 50); return false; } }, { signal: ctl.signal });
    const t0 = Date.now();
    const report = await runAttempt(deps, w.lease);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(report.outcome).toBe('aborted');
    expect(w.api.published).toHaveLength(0);
    expect(w.sbx.streams[0]!.isEnded).toBe(true);
    expect(w.sbx.sandboxes.has(sandboxName('task1', 'att_1'))).toBe(false);
  });
});

describe('runAttempt', () => {
  it('runs the agent in a sandbox, accepts a diff inside allowedPaths, publishes completed once, and cleans up', async () => {
    const { w, deps } = await setup({ agent: async ({ write }) => void (await write('src/new.ts', 'export const b = 2;\n')) });
    const report = await runAttempt(deps, w.lease);
    expect(w.api.published).toEqual([{ outcome: 'completed', reportedCostUsd: 0.05, changeManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/), reportedUsage: expect.objectContaining({ inputTokens: 6, outputTokens: 20, setupSeconds: expect.any(Number), costBasis: 'list' }) }]);
    expect((w.api.published[0] as { changeManifestSha256: string }).changeManifestSha256).toBe(report.changeManifest);
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
    expect(report.outcome).toBe('infrastructure_failed');
    expect(w.api.published[0]).toMatchObject({ outcome: 'infrastructure_failed' });
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

describe('the base .gitignore at the completion gate', () => {
  const baseFiles = { '.gitignore': 'dist/\ndata/*.sqlite*\n' };

  it('a worker that builds and starts the app can still finish', async () => {
    const { w, deps } = await setup({ baseFiles, agent: async ({ write }) => {
      await write('src/x.ts', 'x');
      await write('dist/assets/app.js', 'built');
      await write('data/feedback.sqlite', 'db');
    } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
  });

  it('a worker cannot hide a change by editing .gitignore', async () => {
    const { w, deps } = await setup({ baseFiles, agent: async ({ write }) => {
      await write('.gitignore', 'dist/\ndata/*.sqlite*\nescaped.txt\n');
      await write('escaped.txt', 'x');
    } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/diff outside allowedPaths: 2 path.*escaped\.txt/);
  });
});

describe('toolchain provisioning', () => {
  const NODE_PROJECT = { '.nvmrc': '24\n', 'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.2' }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' };
  const fail = (step: string, code: number) => ({ provision: (s: string) => (s === step ? { code, stdout: '', stderr: `boom in ${step}`, timedOut: false } : undefined) });
  const execSteps = (world: World) => world.sbx.calls.filter((c) => c[0] === 'exec').map((c) => /selarikru-provision:(\w+)/.exec(c.join(' '))?.[1]).filter(Boolean);

  it('installs the toolchain after the sandbox exists and before the harness starts, and launches with it on PATH', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('completed');
    expect(execSteps(w)).toEqual(['node', 'pnpm', 'deps']);
    const order = w.sbx.calls.map((c) => c[0]);
    expect(order.indexOf('create')).toBeLessThan(order.indexOf('exec'));
    const agent = w.sbx.streams.at(-1)!;
    expect(agent.args.join(' ')).toContain('export PATH="$HOME/.node/bin:$PATH";');
    expect(w.logs.join('\n')).toMatch(/toolchain ready: node 24\.\d+\.\d+ pnpm 9\.12\.2 arch arm64/);
  });

  it('records the time as setup', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, fake: { provision: async () => { await new Promise((r) => setTimeout(r, 30)); return undefined; } } });
    await runAttempt(deps, w.lease);
    const usage = (w.api.published[0] as { reportedUsage: { setupSeconds: number } }).reportedUsage;
    expect(usage.setupSeconds).toBeGreaterThanOrEqual(0.03);
  });

  it('a repository with no toolchain pins runs nothing extra', async () => {
    const { w, deps } = await setup({});
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
    expect(execSteps(w)).toEqual([]);
  });

  it('a pin that cannot be resolved blocks before any sandbox exists', async () => {
    const { w, deps } = await setup({ baseFiles: { ...NODE_PROJECT, '.nvmrc': 'lts/*\n' } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('blocked');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/^toolchain_unresolved: .*\.nvmrc/);
    expect(w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it.each([['node', 66, /SHA-256/], ['pnpm', 70, /could not install pnpm/], ['deps', 1, /frozen-lockfile/]] as const)('%s failing is an infrastructure failure, the harness never starts, the sandbox is removed', async (step, code, reason) => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, fake: fail(step, code) });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('infrastructure_failed');
    expect(w.api.published).toHaveLength(1);
    const published = w.api.published[0] as { outcome: string; reason: string; reportedUsage?: { setupSeconds: number } };
    expect(published.outcome).toBe('infrastructure_failed');
    expect(published.reason).toMatch(/^provisioning_failed: /);
    expect(published.reason).toMatch(reason);
    expect(published.reason).toContain('boom in');
    expect(published.reportedUsage?.setupSeconds).toEqual(expect.any(Number));
    expect(w.sbx.streams).toHaveLength(0);
    expect([...w.sbx.sandboxes.keys()]).toEqual(['hq-askwell-jim']);
    expect(w.logs.join('\n')).toContain('boom in');
  });

  it.each(['node', 'pnpm', 'deps'] as const)('a restricted attempt publishes no guest output line when %s fails, and keeps it in the runner\'s own log', async (step) => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, streamable: false, fake: { provision: (s: string) => (s === step ? { code: 1, stdout: 'error: restricted words on stdout', stderr: 'ERR_RESTRICTED restricted words on stderr', timedOut: false } : undefined) } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('infrastructure_failed');
    const reason = (w.api.published[0] as { reason: string }).reason;
    expect(reason).toMatch(/^provisioning_failed: .*(failed|exit)/);
    expect(reason).not.toMatch(/restricted words|ERR_RESTRICTED/);
    expect(w.logs.join('\n')).toContain('restricted words on stderr');
  });

  it('a step that said why only on stdout leaves the cause in the runner\'s log and on screen', async () => {
    const stdout = ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n\nNote that in CI this is the default.\n';
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, fake: { provision: (s) => (s === 'deps' ? { code: 1, stdout, stderr: '', timedOut: false } : undefined) } });
    await runAttempt(deps, w.lease);
    expect((w.api.published[0] as { reason: string }).reason).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    const logged = w.logs.join('\n');
    expect(logged).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(logged).toContain('Note that in CI');
  });

  it('the worker\'s time limit starts after setup', async () => {
    const { w, deps } = await setup({
      baseFiles: NODE_PROJECT,
      task: { limits: { maxAttempts: 3, timeoutSeconds: 1, maxCostUsd: 1 } },
      fake: { provision: async () => { await new Promise((r) => setTimeout(r, 170)); return undefined; } },
      agent: async () => { await new Promise((r) => setTimeout(r, 500)); },
    }, { timeoutScale: 0.8 });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
    expect(w.api.setupComplete).toHaveBeenCalledTimes(1);
  });

  it('runs inside the deadline the server gives back', async () => {
    const { w, deps } = await setup({
      baseFiles: NODE_PROJECT,
      setupComplete: async () => ({ deadlineAt: new Date(Date.now() + 150).toISOString() }),
      agent: async () => { await new Promise((r) => setTimeout(r, 2_000)); },
    });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/timeout/);
  });

  it('if the server cannot be told, the worker still runs, inside the original deadline', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, setupComplete: async () => { throw new Error('502'); } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
    expect(w.logs.join('\n')).toMatch(/could not report setup/);
  });

  it('a lost lease at that moment starts no worker', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, setupComplete: async () => { throw new LeaseLostError(); } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('lease_lost');
    expect(w.sbx.streams).toHaveLength(0);
  });

  describe('while setup is being reported done', () => {
    /** Answers only after the heartbeat has had time to run, as a slow control plane would. */
    const slowSetup = async () => { await new Promise((r) => setTimeout(r, 120)); return { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() }; };

    it('an owner cancel starts no worker', async () => {
      let reporting = false;
      const { w, deps } = await setup({ baseFiles: NODE_PROJECT, heartbeat: async () => ({ cancelRequested: reporting }), setupComplete: async () => { reporting = true; return slowSetup(); } });
      const report = await runAttempt(deps, w.lease);
      expect(w.sbx.streams).toHaveLength(0);
      expect(report.outcome).toBe('failed');
      expect((w.api.published[0] as { reason: string }).reason).toMatch(/cancelled by owner request before the agent started/);
    });

    it('a runner shutdown starts no worker and publishes nothing', async () => {
      const ctl = new AbortController();
      const { w, deps } = await setup({ baseFiles: NODE_PROJECT, setupComplete: async () => { ctl.abort(); return slowSetup(); } }, { signal: ctl.signal });
      expect((await runAttempt(deps, w.lease)).outcome).toBe('aborted');
      expect(w.sbx.streams).toHaveLength(0);
      expect(w.api.published).toHaveLength(0);
    });

    it('the attempt timeout running out starts no worker, and is setup\'s failure', async () => {
      const { w, deps } = await setup({ baseFiles: NODE_PROJECT, task: { limits: { maxAttempts: 3, timeoutSeconds: 1, maxCostUsd: 1 } }, setupComplete: async () => { await new Promise((r) => setTimeout(r, 400)); return { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() }; } }, { timeoutScale: 0.2 });
      expect((await runAttempt(deps, w.lease)).outcome).toBe('infrastructure_failed');
      expect(w.sbx.streams).toHaveLength(0);
      expect((w.api.published[0] as { reason: string }).reason).toMatch(/timeout was reached during setup/);
    });

    it('a lease lost on a heartbeat starts no worker', async () => {
      let reporting = false;
      const { w, deps } = await setup({ baseFiles: NODE_PROJECT, heartbeat: async () => { if (reporting) throw new LeaseLostError(); return { cancelRequested: false }; }, setupComplete: async () => { reporting = true; return slowSetup(); } });
      expect((await runAttempt(deps, w.lease)).outcome).toBe('lease_lost');
      expect(w.sbx.streams).toHaveLength(0);
      expect(w.api.published).toHaveLength(0);
    });
  });

  it('a sandbox that cannot be created is an infrastructure failure, with its setup time', async () => {
    const { w, deps } = await setup({ fake: { failCreate: true } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('infrastructure_failed');
    const published = w.api.published[0] as { reason: string; reportedUsage?: { setupSeconds: number } };
    expect(published.reason).toMatch(/^provisioning_failed: sandbox unavailable: /);
    expect(published.reportedUsage?.setupSeconds).toEqual(expect.any(Number));
  });

  it('a host git that cannot start is an infrastructure failure, before any sandbox', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT });
    const path = process.env['PATH'];
    process.env['PATH'] = join(w.root, 'nowhere');
    try {
      expect((await runAttempt(deps, w.lease)).outcome).toBe('infrastructure_failed');
    } finally {
      process.env['PATH'] = path;
    }
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/^provisioning_failed: /);
    expect(w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('secrets in the guest\'s stderr stay out of the runner\'s log', async () => {
    const leak = 'ghp_012345678901234567890123456789012345';
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, fake: { provision: () => ({ code: 1, stdout: '', stderr: `token ${leak}`, timedOut: false }) } });
    await runAttempt(deps, w.lease);
    expect(w.logs.join('\n')).not.toContain(leak);
  });

  it('nothing from provisioning reaches the terminal feed', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, fake: { provision: (s) => (s === 'deps' ? { code: 0, stdout: 'Packages: +200\nghp_012345678901234567890123456789012345', stderr: '', timedOut: false } : undefined) } });
    await runAttempt(deps, w.lease);
    for (const call of (w.api.terminal as unknown as { mock: { calls: unknown[][] } }).mock.calls) expect(JSON.stringify(call)).not.toContain('Packages');
  });

  it('a timeout during setup is an infrastructure failure, not the worker\'s', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, task: { limits: { maxAttempts: 3, timeoutSeconds: 1, maxCostUsd: 1 } }, fake: { provision: async (_s, _a, o) => {
      await new Promise<void>((r) => o.signal?.addEventListener('abort', () => r(), { once: true }));
      return { code: null, stdout: '', stderr: '', timedOut: false };
    } } }, { timeoutScale: 0.4 });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('infrastructure_failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/timeout/);
  });

  it('a cancel during setup stops it and is never reported as a setup failure', async () => {
    let beats = 0;
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT, heartbeat: async () => ({ cancelRequested: (beats += 1) >= 1 }), fake: { provision: async (_s, _a, o) => {
      await new Promise<void>((r) => o.signal?.addEventListener('abort', () => r(), { once: true }));
      return { code: null, stdout: '', stderr: '', timedOut: false };
    } } });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/cancel/);
    expect(w.sbx.streams).toHaveLength(0);
  });

  it('a runtime that cannot provision does not launch a worker that cannot build', async () => {
    const { w, deps } = await setup({ baseFiles: NODE_PROJECT });
    const runtime = new Proxy(w.runtime, { get: (t, k) => (k === 'provision' ? undefined : Reflect.get(t, k, t)) }) as typeof w.runtime;
    expect((await runAttempt({ ...deps, runtime }, w.lease)).outcome).toBe('infrastructure_failed');
    expect(w.sbx.streams).toHaveLength(0);
  });
});

describe('TASK.md', () => {
  const spec = (over: object) => ({ taskId: 't', revision: 1, role: 'backend', title: 'API', requirementIds: [], acceptanceCheckIds: [], allowedPaths: ['server', 'migrations', 'tests/backend'], ...over }) as never;

  it('says build output is ignored and how to read the worker split on the pilot', () => {
    const file = renderTaskFile(spec({}));
    expect(file).toMatch(/\.gitignore/);
    expect(file).toMatch(/dependenc/i);
    expect(file).toMatch(/node environment/i);
    expect(file).toMatch(/backend worker/i);
    expect(file).toMatch(/frontend worker/i);
    expect(file).toMatch(/dist\//);
  });

  it('tells the worker the toolchain and dependencies are ready, and how to build and test', () => {
    const file = renderTaskFile(spec({}), { toolchain: { nodeVersion: '24.22.1', pnpmVersion: '9.12.2' } });
    expect(file).toMatch(/Node 24\.22\.1/);
    expect(file).toMatch(/pnpm 9\.12\.2/);
    expect(file).toMatch(/dependencies are installed/i);
    expect(file).toContain('pnpm build');
    expect(file).toContain('pnpm test');
  });

  it('says nothing about a toolchain when none was set up', () => {
    expect(renderTaskFile(spec({}))).not.toMatch(/## Toolchain/);
  });

  it('a generic task gets no pilot text', () => {
    expect(renderTaskFile(spec({ allowedPaths: ['src'] }))).not.toMatch(/frontend worker/i);
  });

  it('a repair names why the last attempt failed, as a report', () => {
    const file = renderTaskFile(spec({}), { priorFailure: 'FB-02 failed: title too long accepted' });
    expect(file).toContain('FB-02 failed: title too long accepted');
    expect(file).toMatch(/not an instruction/i);
    expect(renderTaskFile(spec({}))).not.toMatch(/last attempt/i);
  });
});

