import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointDigest } from '@selarikru/domain';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { makeWorld, type World, type WorldOptions } from './world.ts';

let w: World | null = null;
afterEach(async () => {
  wrote = false;
  await w?.cleanup();
  w = null;
});

async function setup(o: WorldOptions = {}) {
  w = await makeWorld(o);
  const deps: AttemptDeps = {
    api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo },
    heartbeatMs: 20, maxMissedHeartbeats: 3, maxTurns: 8, cpus: 2, memoryMiB: 4096, log: (l) => w!.logs.push(l),
  };
  return { w, deps };
}

const started = () => (w?.sbx.streams.length ?? 0) > 0;
/** Set by a scripted agent once it has written everything, so the stop never races its writes. */
let wrote = false;
const stopWhenWritten = async () => ({ cancelRequested: wrote, handover: wrote ? HANDOVER : null });
const sha = (b: string) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const HANDOVER = { checkpointId: 'ckpt_1', mode: 'resume' as const };
const SECRET = 'sk_live_CANARY0123456789abcdefXYZ';

describe('the prior attempt of a handover', () => {
  it('stops its worker, then sends its change set against the base with every file hashed, secret files and paths outside the allowed paths excluded by path and reason', async () => {
    const { w, deps } = await setup({
      agent: async ({ write }) => {
        await write('src/feature.ts', 'export const feature = 1;\n');
        await write('.env', `API_KEY=${SECRET}\n`);
        await write('notes.md', 'outside\n');
        wrote = true;
        return false;
      },
      heartbeat: stopWhenWritten,
    });
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('failed');
    expect(w.api.checkpoints).toHaveLength(1);
    const body = w.api.checkpoints[0] as { baseSha: string; patchSha256: string; files: { path: string; sha256: string; content: string }[]; exclusions: { path: string; reason: string }[] };
    expect(body.baseSha).toBe(w.sha);
    expect(body.files.map((f) => f.path)).toEqual(['src/feature.ts']);
    expect(body.files[0]!.sha256).toBe(sha('export const feature = 1;\n'));
    expect(body.exclusions).toEqual([{ path: '.env', reason: 'secret_file_name' }, { path: 'notes.md', reason: 'outside_allowed_paths' }]);
    expect(body.patchSha256).toBe(checkpointDigest(w.sha, body.files.map((f) => ({ ...f, status: 'added' as const, executable: false }))));
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(w.logs)).not.toContain(SECRET);
    // The checkpoint went before the acknowledgement: the publish is the last call.
    expect(w.api.published).toHaveLength(1);
  });

  it('excludes a file with secret-shaped content and says so, rather than sending it', async () => {
    const { w, deps } = await setup({
      agent: async ({ write }) => { await write('src/config.ts', `export const key = "${SECRET}";\n`); await write('src/ok.ts', 'ok\n'); wrote = true; return false; },
      heartbeat: stopWhenWritten,
    });
    await runAttempt(deps, w.lease);
    const body = w.api.checkpoints[0] as { files: { path: string }[]; exclusions: { path: string; reason: string }[] };
    expect(body.files.map((f) => f.path)).toEqual(['src/ok.ts']);
    expect(body.exclusions).toEqual([{ path: 'src/config.ts', reason: 'secret_content' }]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('restricted work never sends a checkpoint', async () => {
    const { w, deps } = await setup({
      streamable: false,
      agent: async ({ write }) => { await write('src/feature.ts', 'restricted\n'); wrote = true; return false; },
      heartbeat: stopWhenWritten,
    });
    await runAttempt(deps, w.lease);
    expect(w.api.checkpoints).toHaveLength(0);
    expect(w.api.published).toHaveLength(1);
  });
});

describe('the successor of a handover', () => {
  const carried = 'export const feature = 1;\n';
  const files = [{ path: 'src/feature.ts', status: 'added' as const, sha256: sha(carried), size: carried.length, executable: false }];

  it('applies the checked checkpoint to the base before its worker starts, and its change set is the combined candidate', async () => {
    let seen: string | null = null;
    const { w, deps } = await setup({
      agent: async ({ cwd, write }) => { seen = await readFile(join(cwd, 'src/feature.ts'), 'utf8'); await write('src/more.ts', 'more\n'); },
      fetchCheckpoint: async () => ({ checkpointId: 'ckpt_1', baseSha: w!.sha, patchSha256: checkpointDigest(w!.sha, files), files: files.map((f) => ({ ...f, content: Buffer.from(carried).toString('base64') })) }),
    });
    w.lease.handover = { checkpointId: 'ckpt_1', mode: 'resume', priorAttemptId: 'att_0', baseSha: w.sha, patchSha256: checkpointDigest(w.sha, files), fileCount: 1 };
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('completed');
    expect(seen).toBe(carried);
    const manifest = JSON.parse(Buffer.from((await w.artifacts.get(report.changeManifest!))!).toString()) as { changes: { path: string }[] };
    expect(manifest.changes.map((c) => c.path)).toEqual(['src/feature.ts', 'src/more.ts']);
  });

  it('a checkpoint that does not match its hashes starts nothing and reports why', async () => {
    const { w, deps } = await setup({
      fetchCheckpoint: async () => ({ checkpointId: 'ckpt_1', baseSha: w!.sha, patchSha256: checkpointDigest(w!.sha, files), files: files.map((f) => ({ ...f, content: Buffer.from('tampered\n').toString('base64') })) }),
    });
    w.lease.handover = { checkpointId: 'ckpt_1', mode: 'resume', priorAttemptId: 'att_0', baseSha: w.sha, patchSha256: checkpointDigest(w.sha, files), fileCount: 1 };
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('infrastructure_failed');
    expect((w.api.published[0] as { reason: string }).reason).toMatch(/^checkpoint_tampered/);
    expect(w.sbx.calls.some((c) => c[0] === 'create')).toBe(false);
    expect(w.sbx.streams).toHaveLength(0);
  });

  it('a patch hash other than the lease names refuses, even when the files match each other', async () => {
    const { w, deps } = await setup({
      fetchCheckpoint: async () => ({ checkpointId: 'ckpt_1', baseSha: w!.sha, patchSha256: checkpointDigest(w!.sha, files), files: files.map((f) => ({ ...f, content: Buffer.from(carried).toString('base64') })) }),
    });
    w.lease.handover = { checkpointId: 'ckpt_1', mode: 'resume', priorAttemptId: 'att_0', baseSha: w.sha, patchSha256: '0'.repeat(64), fileCount: 1 };
    const report = await runAttempt(deps, w.lease);
    expect(report.outcome).toBe('infrastructure_failed');
    expect(w.sbx.streams).toHaveLength(0);
  });
});
