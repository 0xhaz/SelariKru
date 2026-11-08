/**
 * One real end-to-end attempt: real control API (test database, real clock), real HTTP, real `sbx`, real Claude Code in a
 * sandbox. Opt in with SELARIKRU_REAL_SBX=1 and DATABASE_URL. It spends one short model run and removes its own sandbox by name.
 */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { LocalDiskArtifactStore } from '@selarikru/artifacts';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, enrolRunner, fakeVerifier, testConfig, PROJECT, resetDb, seedTask, setupTestDb, specFor } from '@selarikru/control-api/test-helpers';
import { NodeSbxRunner, SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { createScheduler } from '@selarikru/workflow';
import { POLICY } from '@selarikru/workflow/test-helpers';
import { HttpRunnerApi } from '../src/api.ts';
import { runAttempt } from '../src/attempt.ts';

const enabled = process.env['SELARIKRU_REAL_SBX'] === '1';
const platformRepo = resolve(import.meta.dirname, '..', '..', '..');
const spikeRepo = join(platformRepo, '.superpowers', 'sdd', 'workplan', 'spike-repo-t42');

describe.skipIf(!enabled)('real end-to-end attempt', () => {
  it('claims over HTTP, runs Claude Code in a real sandbox, checks the diff, publishes, and leaves nothing behind', async () => {
    await rm(spikeRepo, { recursive: true, force: true });
    await mkdir(join(spikeRepo, 'contract'), { recursive: true });
    await mkdir(join(spikeRepo, 'tools', 'verifier-calibration'), { recursive: true });
    await writeFile(join(spikeRepo, 'contract', 'runtime.md'), '# Runtime contract\n\nPython 3 standard library only. Tests use unittest and run with `python3 -m unittest`.\n');
    await writeFile(join(spikeRepo, 'tools', 'verifier-calibration', 'secret.txt'), 'CALIBRATION-SHOULD-NEVER-REACH-A-WORKER\n');
    await writeFile(join(spikeRepo, 'README.md'), 'throwaway repo for T4.2\n');
    const g = (...a: string[]) => execFileSync('git', ['-C', spikeRepo, ...a], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', spikeRepo]);
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    const baseSha = g('rev-parse', 'HEAD');

    const t = await setupTestDb();
    await resetDb(t.db);
    const config = testConfig();
    const app = buildApp({ config, db: t.db, verifier: fakeVerifier, now: () => new Date(), policy: API_POLICY, scheduler: createScheduler({ db: t.db, now: () => new Date(), policy: POLICY }) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const taskId = 't42';
    const workRoot = await mkdtemp(join(tmpdir(), 'runner-e2e-'));
    const before = execFileSync('sbx', ['ls', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    const logs: string[] = [];
    const evidence = join(platformRepo, '.superpowers', 'sdd', 'workplan', 'task-T4.2-e2e-evidence.txt');
    await writeFile(evidence, `started ${new Date().toISOString()}\n`);
    const note = (l: string) => appendFile(evidence, `${l}\n`);
    try {
      await seedTask(
        t.db,
        specFor(taskId, {
          baseSha,
          title: 'Add greet.py with function greet(name) returning "Hello, <name>!" and test_greet.py using unittest. Run the test once. Be brief.',
          allowedPaths: ['greet.py', 'test_greet.py'],
          timeoutSeconds: 600,
          maxCostUsd: 1,
        }),
        'ready',
      );
      const { token } = await enrolRunner(app, 'local');
      const api = new HttpRunnerApi(`http://127.0.0.1:${port}`, token);
      const runtime = new SbxRuntimeAdapter(new NodeSbxRunner(), { home: homedir(), forbidden: [platformRepo], attemptsRoot: join(workRoot, 'attempts') });
      const claim = await api.claim();
      expect(claim.lease?.taskId).toBe(taskId);
      const t0 = Date.now();
      const report = await runAttempt(
        { api, runtime, artifacts: new LocalDiskArtifactStore(join(workRoot, 'artifacts')), workRoot, repos: { [PROJECT]: spikeRepo }, heartbeatMs: 10_000, maxMissedHeartbeats: 6, maxTurns: 8, cpus: 2, memoryMiB: 4096, log: (l) => (logs.push(l), void note(l)) },
        claim.lease!,
      );
      await note(`wall ms ${Date.now() - t0} ${JSON.stringify(report)}`);
      expect(report.outcome).toBe('completed');
      const status = await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = ${taskId}`);
      expect(status[0]?.['status']).toBe('verifying');
      const manifest = JSON.parse(Buffer.from((await new LocalDiskArtifactStore(join(workRoot, 'artifacts')).get(report.changeManifest!))!).toString());
      await note(`changes ${JSON.stringify(manifest.changes.map((c: { path: string; status: string }) => `${c.status}:${c.path}`))}`);
      expect(manifest.changes.map((c: { path: string }) => c.path).sort()).toEqual(['greet.py', 'test_greet.py']);
      expect(logs.join('\n')).not.toContain('CALIBRATION');
      expect(logs.join('\n')).toContain('connectedMcp=[]');
    } finally {
      await app.close();
      await t.close();
      const after = execFileSync('sbx', ['ls', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
      await note(`sbx before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      expect(after).toEqual(before);
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
