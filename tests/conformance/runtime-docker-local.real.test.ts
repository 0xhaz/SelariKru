import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe } from 'vitest';
import { NodeSbxRunner, SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import type { SandboxSpec } from '@selarikru/protocol';
import { runtimeConformance } from './runtime.ts';

/**
 * The same suite against the real `sbx`. Opt in with SELARIKRU_REAL_SBX=1: it creates and removes `selarikru-t*` sandboxes
 * only, by explicit name, and never touches any other sandbox, policy or setting.
 */
const enabled = process.env['SELARIKRU_REAL_SBX'] === '1';

if (enabled) {
  let n = 0;
  const run = Date.now().toString(36);
  runtimeConformance('sbx adapter over the real sbx', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'conf-real-')));
    const runtime = new SbxRuntimeAdapter(new NodeSbxRunner(), {
      home: homedir(),
      forbidden: [resolve(import.meta.dirname, '..', '..')],
      attemptsRoot: join(root, 'attempts'),
    });
    return {
      runtime,
      async newSpec(): Promise<SandboxSpec> {
        const id = `${run}-${++n}`;
        const workspacePath = join(root, 'attempts', id, 'workspace');
        await mkdir(workspacePath, { recursive: true });
        return { attemptId: `conf-attempt-${id}`, taskId: `conf-task-${id}`, workspacePath, cpus: 2, memoryMiB: 4096 };
      },
      longRunning: (h) => ({ attemptId: h.attemptId, command: ['sleep', '300'], cwd: h.workspacePath }),
      async cleanup(handles) {
        for (const h of handles) await runtime.destroy(h).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      },
    };
  });
} else {
  describe.skip('RuntimeAdapter conformance: sbx adapter over the real sbx (set SELARIKRU_REAL_SBX=1)', () => undefined);
}
