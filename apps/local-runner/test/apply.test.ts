import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeCheckedFiles } from '../src/checkpoint.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLY_HARNESS_REPORT, acceptedProposalDigest, sha256Hex, type AcceptedProposal } from '@selarikru/domain';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { harnessReportFor } from '../src/loop.ts';
import { makeWorld, type World, type WorldOptions } from './world.ts';

let w: World | null = null;
afterEach(async () => {
  await w?.cleanup();
  w = null;
});

const APPLY = { provider: 'selarikru', model: 'apply-proposal', source: 'proposal', route: 'none' } as const;
const BEFORE = 'export const a = 1;\n';
const AFTER = 'export const a = 2;\n';
const NEW = 'export const b = 1;\n';
const DIFF = [
  '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-export const a = 1;', '+export const a = 2;',
  '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export const b = 1;', '',
].join('\n');

const proposalFor = (baseSha: string, over: Partial<AcceptedProposal> = {}): AcceptedProposal => ({
  proposalId: 'req_1', taskId: 'task1', taskRevision: 1, baseSha, routeRecordId: 'rr_1', diff: DIFF,
  results: [{ path: 'src/app.ts', sha256: sha256Hex(AFTER), content: AFTER }, { path: 'src/new.ts', sha256: sha256Hex(NEW), content: NEW }],
  ...over,
});

/** An apply attempt's world: the lease names the proposal, and the API answers it (or what `answer` makes of it). */
async function setup(o: WorldOptions & { answer?: (p: AcceptedProposal) => unknown; proposalOver?: (sha: string) => Partial<AcceptedProposal> } = {}, over: Partial<AttemptDeps> = {}) {
  let sha = '';
  w = await makeWorld({ assignment: APPLY, ...o, fetchProposal: async () => { const p = proposalFor(sha, o.proposalOver?.(sha) ?? {}); return o.answer ? o.answer(p) : p; } });
  sha = w.sha;
  const p = proposalFor(sha, o.proposalOver?.(sha) ?? {});
  w.lease = { ...w.lease, proposal: { proposalId: p.proposalId, digest: acceptedProposalDigest(p), fileCount: p.results.length, baseSha: sha } };
  const deps: AttemptDeps = {
    api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo },
    heartbeatMs: 20, maxMissedHeartbeats: 3, maxTurns: 8, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l), codingWorkers: 'off', ...over,
  };
  return { w, deps };
}

const reasonOf = (world: World) => (world.api.published[0] as { reason?: string }).reason;
const created = (world: World) => world.sbx.calls.some((c) => c[0] === 'create');
const manifestPaths = async (world: World, sha: string) => (JSON.parse(Buffer.from((await world.artifacts.get(sha))!).toString()) as { changes: { path: string; sha256: string | null }[] }).changes;

describe('the apply worker (H5): no model, checked results only', () => {
  it('writes the checked results into a clean workspace and publishes exactly them as the change set; no agent runs', async () => {
    const { w, deps } = await setup();
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('completed');
    expect(w.api.setupComplete).toHaveBeenCalledTimes(1);
    // No toolchain is pinned here: nothing runs in the sandbox, and no model process ever starts.
    expect(w.sbx.streams).toHaveLength(0);
    const changes = await manifestPaths(w, report.changeManifest!);
    expect(changes.map((c) => [c.path, c.sha256])).toEqual([['src/app.ts', sha256Hex(AFTER)], ['src/new.ts', sha256Hex(NEW)]]);
    expect(w.logs.join('\n')).toMatch(/accepted proposal req_1 applied: 2 file\(s\)/);
  });

  it('runs the base\'s build and test scripts in the sandbox after setup is acknowledged, and a failing test fails the attempt', async () => {
    const NODE = { '.nvmrc': '24\n', 'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.2', scripts: { build: 'tsc', test: 'vitest run' } }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' };
    const ok = await setup({ baseFiles: NODE });
    expect((await runAttempt(ok.deps, ok.w.lease)).outcome).toBe('completed');
    expect(ok.w.sbx.streams.map((s) => s.args.slice(-3).join(' '))).toEqual(['pnpm run build', 'pnpm run test']);
    expect(ok.w.sbx.streams.every((s) => !s.args.join(' ').includes('claude'))).toBe(true);
    await ok.w.cleanup();
    const failing = await setup({ baseFiles: NODE, streamExit: (args) => (args.join(' ').endsWith('run test') ? 1 : 0) });
    expect((await runAttempt(failing.deps, failing.w.lease)).outcome).toBe('failed');
    expect(reasonOf(failing.w)).toMatch(/^tests_failed: pnpm run test exited with code 1/);
  });

  it('refuses a tampered hash, a path escape and a proposal the lease does not name, before any sandbox exists', async () => {
    const tampered = await setup({ answer: (p) => ({ ...p, results: [{ ...p.results[0]!, sha256: sha256Hex('other') }, p.results[1]!] }) });
    expect((await runAttempt(tampered.deps, tampered.w.lease)).outcome).toBe('blocked');
    expect(reasonOf(tampered.w)).toBe('proposal_invalid: hash_mismatch');
    expect(created(tampered.w)).toBe(false);
    await tampered.w.cleanup();

    const escape = await setup({ answer: (p) => ({ ...p, diff: '--- /dev/null\n+++ b/src/../../x.ts\n@@ -0,0 +1 @@\n+x\n', results: [{ path: 'src/../../x.ts', sha256: sha256Hex('x\n'), content: 'x\n' }] }) });
    expect((await runAttempt(escape.deps, escape.w.lease)).outcome).toBe('blocked');
    expect(reasonOf(escape.w)).toMatch(/^proposal_invalid: path_invalid/);
    expect(await stat(join(escape.w.workRoot, '..', 'x.ts')).then(() => true, () => false)).toBe(false);
    await escape.w.cleanup();

    const other = await setup({ answer: (p) => ({ ...p, proposalId: 'req_other' }) });
    expect((await runAttempt(other.deps, other.w.lease)).outcome).toBe('blocked');
    expect(reasonOf(other.w)).toMatch(/not the one the lease names/);
  });

  it('refuses a base the diff does not reproduce the results from: blocked with the reason, no repair, nothing written and no sandbox made', async () => {
    const { w, deps } = await setup({ baseFiles: { 'src/app.ts': 'export const a = 7;\n' } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('blocked');
    expect(reasonOf(w)).toMatch(/^proposal_base_mismatch/);
    expect(created(w)).toBe(false);
  });

  it('refuses to write through a symlinked ancestor', async () => {
    const created1 = { diff: '--- /dev/null\n+++ b/src/link/evil.ts\n@@ -0,0 +1 @@\n+x\n', results: [{ path: 'src/link/evil.ts', sha256: sha256Hex('x\n'), content: 'x\n' }] };
    const { w, deps } = await setup({ proposalOver: () => created1 });
    // The base itself holds the link, relative and inside the repository (the bundle keeps those): src/link -> ../contract. Commit it, and point the task at that commit.
    await symlink('../contract', join(w.repo, 'src/link'));
    execFileSync('git', ['-C', w.repo, 'add', '-A']);
    execFileSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'link']);
    const sha = execFileSync('git', ['-C', w.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const p = proposalFor(sha, created1);
    vi.mocked(w.api.task).mockResolvedValue({ ...w.task, baseSha: sha });
    vi.mocked(w.api.fetchProposal!).mockResolvedValue(p);
    w.lease = { ...w.lease, proposal: { proposalId: p.proposalId, digest: acceptedProposalDigest(p), fileCount: 1, baseSha: sha } };
    // The base, not the project, refuses it: blocked with a base reason, no repair spent (m4).
    expect((await runAttempt(deps, w.lease)).outcome).toBe('blocked');
    expect(reasonOf(w)).toMatch(/^proposal_base_mismatch: src\/link\/evil\.ts would be written through a link/);
    expect(created(w)).toBe(false);
  });

  it('build output the proposal does not contain is ignored and not published; a build that changes an accepted file blocks', async () => {
    const NODE = { '.nvmrc': '24\n', 'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.2', scripts: { build: 'tsc' } }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' };
    const stray = await setup({ baseFiles: NODE, agent: async ({ write }) => void (await write('src/stray.ts', 'x')) });
    const report = await runAttempt(stray.deps, stray.w.lease);
    expect(report.outcome).toBe('completed');
    expect((await manifestPaths(stray.w, report.changeManifest!)).map((c) => c.path)).toEqual(['src/app.ts', 'src/new.ts']);
    await stray.w.cleanup();
    const touched = await setup({ baseFiles: NODE, agent: async ({ write }) => void (await write('src/new.ts', 'rewritten by the build\n')) });
    expect((await runAttempt(touched.deps, touched.w.lease)).outcome).toBe('blocked');
    expect(reasonOf(touched.w)).toBe('proposal_changes_mismatch: 1 accepted file(s) changed during build or test');
  });

  it('writes the results only after the setup ack, so setup runs on the base', async () => {
    const seen: string[] = [];
    const { w, deps } = await setup({ setupComplete: async () => {
      seen.push(await readFile(join(w!.workRoot, 'attempts', 'att_1', 'workspace', 'src/app.ts'), 'utf8'));
      return { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() };
    } });
    expect((await runAttempt(deps, w.lease)).outcome).toBe('completed');
    expect(seen).toEqual([BEFORE]);
  });
});

describe('coding workers off (H5/H6)', () => {
  it('a lease for a model harness is refused before any sandbox exists: no claude or sbx-claude process starts', async () => {
    w = await makeWorld({});
    const deps: AttemptDeps = {
      api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo },
      heartbeatMs: 20, maxMissedHeartbeats: 3, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l), codingWorkers: 'off',
    };
    expect((await runAttempt(deps, w.lease)).outcome).toBe('blocked');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/^coding_workers_off/);
    expect(w.sbx.calls).toEqual([]);
    expect(w.sbx.streams).toHaveLength(0);
  });

  it('the harness report is the apply worker only, and the Claude probe is never run', async () => {
    const probe = vi.fn(async () => [{ provider: 'anthropic', harnessVersion: '2.1.0', models: ['claude-sonnet-5-5'] }]);
    expect(await harnessReportFor('off', probe)()).toEqual([APPLY_HARNESS_REPORT]);
    expect(probe).not.toHaveBeenCalled();
    expect(await harnessReportFor('claude_code', probe)()).toEqual([{ provider: 'anthropic', harnessVersion: '2.1.0', models: ['claude-sonnet-5-5'] }, APPLY_HARNESS_REPORT]);
  });
});

describe('base files for the patch agent (H5)', () => {
  it('answers from git at the base: regular text files in scope only, within the limits, secret content left out by path', async () => {
    const { answerFileRequest } = await import('../src/files.ts');
    w = await makeWorld({ baseFiles: {
      'src/b.ts': 'export const b = 1;\n', 'src/.env': 'TOKEN=abc\n', 'src/keys/id_rsa': 'k\n', 'src/big.ts': 'x'.repeat(20_001),
      'src/bin.dat': 'a\u0000b', 'src/k.ts': 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    } });
    // Uncommitted work in the checkout is never read: git at the base only.
    execFileSync('sh', ['-c', `printf 'changed' > ${join(w.repo, 'src/app.ts')}`]);
    const answer = await answerFileRequest(w.repo, { requestId: 'frq_1', projectId: 'proj1', baseSha: w.sha, mode: 'read', paths: ['src'], allowedPaths: ['src'] });
    expect(answer.files).toEqual([{ path: 'src/app.ts', content: 'export const a = 1;\n' }, { path: 'src/b.ts', content: 'export const b = 1;\n' }]);
    expect(answer.omitted).toEqual([{ path: 'src/big.ts', reason: 'too_large' }, { path: 'src/bin.dat', reason: 'not_text' }, { path: 'src/k.ts', reason: 'secret_content' }]);
    expect(JSON.stringify(answer)).not.toMatch(/\.env|id_rsa|verifier-calibration/);
    expect(await answerFileRequest(undefined, { requestId: 'frq_2', projectId: 'p', baseSha: w.sha, mode: 'read', paths: ['src'], allowedPaths: ['src'] })).toEqual({ requestId: 'frq_2', files: [], omitted: [], noCheckout: true });
  });
});

describe('the writer\'s own escape guard (H5 fix round 1)', () => {
  it('refuses a parent segment, an absolute path and a linked ancestor, and writes nothing when any target is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-'));
    const ws = join(root, 'ws');
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(ws, 'src/link'));
    const bytes = Buffer.from('x\n');
    expect(await writeCheckedFiles(ws, [{ path: '../escape.ts', bytes, mode: 'keep' }])).toMatchObject({ ok: false });
    expect(await writeCheckedFiles(ws, [{ path: '/etc/escape.ts', bytes, mode: 'keep' }])).toMatchObject({ ok: false });
    expect(await writeCheckedFiles(ws, [{ path: 'src/ok.ts', bytes, mode: 'keep' }, { path: 'src/link/evil.ts', bytes, mode: 'keep' }])).toMatchObject({ ok: false, detail: 'src/link/evil.ts would be written through a link' });
    await writeFile(join(ws, 'src/file'), 'f');
    expect(await writeCheckedFiles(ws, [{ path: 'src/file/x.ts', bytes, mode: 'keep' }])).toMatchObject({ ok: false });
    for (const p of [join(root, 'escape.ts'), join(root, 'outside', 'evil.ts'), join(ws, 'src/ok.ts')]) expect(await stat(p).then(() => true, () => false), p).toBe(false);
  });
});

describe('the runner binary\'s default wiring (H5 fix round 1)', () => {
  it('with no SELARIKRU_CODING_WORKERS, coding workers are off: no model harness, no probe, only the apply worker reported', async () => {
    const { runnerWiring } = await import('../src/wiring.ts');
    const probe = vi.fn(async () => [{ provider: 'anthropic', harnessVersion: '2.1.0', models: ['claude-sonnet-5-5'] }]);
    const off = runnerWiring({}, probe);
    expect(off.codingWorkers).toBe('off');
    expect(off.harnesses).toEqual([]);
    expect(await off.harnessReport()).toEqual([APPLY_HARNESS_REPORT]);
    expect(probe).not.toHaveBeenCalled();
    expect(runnerWiring({ SELARIKRU_CODING_WORKERS: '' }, probe).codingWorkers).toBe('off');
    expect(runnerWiring({ SELARIKRU_CODING_WORKERS: 'claude_code' }, probe).harnesses.map((h) => h.provider)).toEqual(['anthropic']);
    expect(() => runnerWiring({ SELARIKRU_CODING_WORKERS: 'yes' }, probe)).toThrow(/off.*claude_code/);
  });
});

describe('fix round 1: listing base files (I4, M6)', () => {
  it('lists regular files under any number of allowed paths, paths and sizes only, and reads git literally', async () => {
    const { answerFileRequest } = await import('../src/files.ts');
    const allowed = Array.from({ length: 12 }, (_, i) => `src/m${i}`);
    w = await makeWorld({ task: { allowedPaths: allowed }, baseFiles: Object.fromEntries([...allowed.map((p, i) => [`${p}/a.ts`, 'x'.repeat(i + 1)]), ['src/m1/[x].ts', 'lit'], ['src/m1/x.ts', 'not matched by a glob']]) });
    const listed = await answerFileRequest(w.repo, { requestId: 'frq_l', projectId: 'proj1', baseSha: w.sha, mode: 'list', paths: allowed, allowedPaths: allowed });
    // `src/m1/[x].ts` is not a path a read may serve (a glob character), so it is not listed; the 12 allowed paths each list their file, plus `src/m1/x.ts`.
    expect(listed.entries).toHaveLength(13);
    expect(listed.entries).toContainEqual({ path: 'src/m11/a.ts', size: 12 });
    expect(listed.files).toEqual([]);
    // git reads a pathspec literally: `src/m1/[x].ts` names that file only, never `src/m1/x.ts` by glob.
    const { listEntries } = await import('../src/files.ts');
    expect((await listEntries(w.repo, w.sha, 'src/m1/[x].ts')).map((e) => e.path)).toEqual(['src/m1/[x].ts']);
  });
});
