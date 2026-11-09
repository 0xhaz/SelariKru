#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LocalDiskArtifactStore, resolveArtifactDir } from '@selarikru/artifacts';
import { cachedHarnessReport } from '@selarikru/harness-claude';
import { NodeSbxRunner, SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { redactSecrets } from '@selarikru/protocol';
import { HttpRunnerApi } from './api.ts';
import { loadCredentials, pair } from './credentials.ts';
import { RunnerLoop } from './loop.ts';

const stateDir = process.env['SELARIKRU_RUNNER_HOME'] ?? join(homedir(), '.selarikru', 'runner');
/** The SelariKru repository itself (apps/local-runner/src -> repo root): never mounted into a sandbox. */
const platformRepo = resolve(import.meta.dirname, '..', '..', '..');
const artifactDir = resolveArtifactDir();
const log = (line: string): void => console.log(`${new Date().toISOString()} ${redactSecrets(line)}`);

async function loadRepos(extra: readonly string[]): Promise<Record<string, string>> {
  let repos: Record<string, string> = {};
  try {
    const cfg = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8')) as { repos?: Record<string, string> };
    repos = { ...(cfg.repos ?? {}) };
  } catch {
    /* no config file is fine */
  }
  for (const e of extra) {
    const i = e.indexOf('=');
    if (i <= 0) throw new Error(`--repo must be PROJECT_ID=/absolute/path, got ${JSON.stringify(e)}`);
    repos[e.slice(0, i)] = e.slice(i + 1);
  }
  for (const [project, p] of Object.entries(repos)) if (!isAbsolute(p)) throw new Error(`repo path for ${project} must be absolute`);
  return repos;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'pair') {
    const { values } = parseArgs({ args: rest, options: { api: { type: 'string' }, code: { type: 'string' }, label: { type: 'string' } } });
    if (!values.api || !values.code) throw new Error('usage: pair --api https://HOST --code PAIRING_CODE [--label NAME]');
    const r = await pair({ apiUrl: values.api, code: values.code, ...(values.label ? { label: values.label } : {}), stateDir });
    log(`paired as ${r.runnerId} (${r.location}); credentials saved with owner-only permissions in ${stateDir}`);
    return;
  }
  if (cmd === 'run') {
    const { values } = parseArgs({ args: rest, options: { repo: { type: 'string', multiple: true }, poll: { type: 'string' } } });
    const creds = await loadCredentials(stateDir);
    if (!creds) throw new Error('not paired: run `pair` first');
    const repos = await loadRepos(values.repo ?? []);
    const workRoot = join(stateDir, 'work');
    await mkdir(join(workRoot, 'attempts'), { recursive: true, mode: 0o700 });
    const runtime = new SbxRuntimeAdapter(new NodeSbxRunner(), { home: homedir(), forbidden: [platformRepo], attemptsRoot: join(workRoot, 'attempts') });
    const caps = await runtime.capabilities();
    if (caps.runtimeVersion === null) throw new Error('sbx is not available; install and sign in to Docker Sandboxes. There is no host-mode fallback.');
    log(`sbx ${caps.runtimeVersion}; ${Object.keys(repos).length} project source(s) configured; outbound connections only`);
    const api = new HttpRunnerApi(creds.apiBaseUrl, creds.token);
    const ctl = new AbortController();
    // First signal: stop the running agent with a bounded stop, destroy its sandbox, exit. A second one exits at once.
    const shutdown = (): void => {
      if (ctl.signal.aborted) process.exit(130);
      log('shutting down: stopping the running agent and removing its sandbox');
      ctl.abort();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    const loop = new RunnerLoop({
      api,
      runtime,
      pollMs: Number(values.poll ?? 5000),
      // Probed on this machine's host. The CLI inside the sandbox image can differ; the init-event check is what proves the model that actually ran.
      harnessReport: cachedHarnessReport(),
      log,
      attempt: {
        api, runtime, artifacts: new LocalDiskArtifactStore(artifactDir), workRoot, repos,
        heartbeatMs: 10_000, maxMissedHeartbeats: 6, maxTurns: 40, cpus: 2, memoryMiB: 4096, log,
      },
    });
    await loop.run(ctl.signal);
    return;
  }
  throw new Error('usage: selarikru-runner pair|run');
}

main().catch((err: unknown) => {
  console.error(redactSecrets(err instanceof Error ? err.message : 'error'));
  process.exitCode = 1;
});
