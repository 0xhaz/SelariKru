import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeSbx } from '@selarikru/runtime-docker-local/fake-sbx';
import { SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import type { SandboxSpec } from '@selarikru/protocol';
import { runtimeConformance } from './runtime.ts';

let n = 0;

runtimeConformance('sbx adapter over a faked sbx', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'conf-fake-')));
  const sbx = new FakeSbx();
  const runtime = new SbxRuntimeAdapter(sbx, {
    home: '/Users/nobody',
    forbidden: [],
    attemptsRoot: join(root, 'attempts'),
    timeouts: { signalMs: 100, graceMs: 100, stopMs: 100, lsMs: 100, createMs: 1000, rmMs: 100 },
  });
  return {
    runtime,
    async newSpec(): Promise<SandboxSpec> {
      const id = `${++n}`;
      const workspacePath = join(root, 'attempts', id, 'workspace');
      await mkdir(workspacePath, { recursive: true });
      return { attemptId: `attempt-${id}`, taskId: `task-${id}`, workspacePath, cpus: 2, memoryMiB: 4096 };
    },
    longRunning: (h) => ({ attemptId: h.attemptId, command: ['sleep', '300'], cwd: h.workspacePath }),
    async cleanup(handles) {
      for (const h of handles) await runtime.destroy(h);
      await rm(root, { recursive: true, force: true });
    },
  };
});
