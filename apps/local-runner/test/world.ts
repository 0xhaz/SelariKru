import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { LocalDiskArtifactStore } from '@selarikru/artifacts';
import { initEvent } from '@selarikru/harness-claude/fixtures';
import { SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { FakeSbx, type FakeOptions, type FakeStream } from '@selarikru/runtime-docker-local/fake-sbx';
import type { TaskSpec } from '@selarikru/domain';
import type { LeaseGrant, LeaseRef, RecordedAssignment } from '@selarikru/protocol';
import { LeaseLostError, type ClaimedLease, type RunnerApi, type RunnerResult } from '../src/api.ts';

export const resultLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.05, terminal_reason: 'completed', usage: { input_tokens: 6, output_tokens: 20 }, ...over });

export interface World {
  root: string;
  repo: string;
  sha: string;
  workRoot: string;
  sbx: FakeSbx;
  runtime: SbxRuntimeAdapter;
  artifacts: LocalDiskArtifactStore;
  api: RunnerApi & { published: RunnerResult[]; heartbeats: number };
  lease: ClaimedLease;
  task: TaskSpec;
  logs: string[];
  controlStreams: FakeStream[];
  cleanup(): Promise<void>;
}

export interface WorldOptions {
  fake?: FakeOptions;
  /** What the scripted agent does inside its workspace. Returns false to leave the run open (for cancel tests). */
  agent?: (ctx: { stream: FakeStream; cwd: string; write(rel: string, body: string): Promise<void> }) => Promise<boolean | void>;
  heartbeat?: (n: number) => Promise<{ cancelRequested: boolean }>;
  task?: Partial<TaskSpec>;
  publishThrows?: boolean;
  initMcp?: Array<{ name: string; status: string }>;
  /** The model the scripted init event reports. Default: the fixture's. Null: an init event naming no model. */
  initModel?: string | null;
  /** The stream sends no init event at all. */
  noInit?: boolean;
  grants?: LeaseGrant[];
  /** What the claim decided about output leaving the machine. Default true. */
  streamable?: boolean;
  /** Called when a control shell is opened, so a test can stand in for the guest helper. */
  onControlStream?: (stream: FakeStream, args: readonly string[]) => void;
  /** What the claim decided about hosting a control session. Default false. */
  controllable?: boolean;
  /** Null: a lease with no recorded model. */
  assignment?: RecordedAssignment | null;
}

export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-')));
  const repo = join(root, 'source-repo');
  await mkdir(repo);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  for (const [p, b] of Object.entries({ 'src/app.ts': 'export const a = 1;\n', 'contract/runtime.md': '# contract\n', 'tools/verifier-calibration/secret.json': '{}' })) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), b);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');

  const workRoot = join(root, 'work');
  const logs: string[] = [];
  const controlStreams: FakeStream[] = [];
  const fake: FakeOptions = {
    ...o.fake,
    onStream: (stream, args) => {
      if (args[1] === '-i') { controlStreams.push(stream); o.onControlStream?.(stream, args); return; }
      const cwd = args[2]!;
      const write = async (rel: string, body: string) => {
        await mkdir(dirname(join(cwd, rel)), { recursive: true });
        await writeFile(join(cwd, rel), body);
      };
      void (async () => {
        if (!o.noInit) stream.push(`${o.initMcp || o.initModel !== undefined ? JSON.stringify({ ...JSON.parse(initEvent), ...(o.initMcp ? { mcp_servers: o.initMcp } : {}), ...(o.initModel !== undefined ? { model: o.initModel } : {}) }) : initEvent}\n`);
        const keepOpen = o.agent ? (await o.agent({ stream, cwd, write })) === false : false;
        if (keepOpen) return;
        stream.push(`${resultLine()}\n`);
        stream.end(0);
      })();
    },
  };
  const sbx = new FakeSbx(fake);
  sbx.addForeign('hq-askwell-jim');
  const runtime = new SbxRuntimeAdapter(sbx, {
    home: '/Users/nobody',
    forbidden: ['/repo/selarikru'],
    attemptsRoot: join(workRoot, 'attempts'),
    timeouts: { signalMs: 100, graceMs: 150, stopMs: 150, lsMs: 100, createMs: 1000, rmMs: 100 },
  });
  const artifacts = new LocalDiskArtifactStore(join(root, 'artifacts'));

  const task: TaskSpec = {
    schemaVersion: 1, tenantId: 'ten', projectId: 'proj1', runId: 'run1', taskId: 'task1', boardId: 'b1', revision: 1, role: 'backend', title: 'Add the thing',
    baseSha: sha, requirementIds: ['R1'], dependencies: [], contractRefs: [], allowedPaths: ['src'], resourceClaims: [], acceptanceCheckIds: [],
    classification: 'internal', policyVersion: 'v1', execution: 'local', inferencePolicyId: 'p1', limits: { maxAttempts: 3, timeoutSeconds: 30, maxCostUsd: 1 }, ...o.task,
  } as TaskSpec;
  const lease: ClaimedLease = { streamable: o.streamable ?? true, controllable: o.controllable ?? false, attemptId: 'att_1', fence: 1, leaseToken: 'tok', taskId: 'task1', projectId: 'proj1', deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), grants: o.grants ?? [], assignment: o.assignment === undefined ? { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'role', route: 'cloud' } : o.assignment };

  let hb = 0;
  const published: RunnerResult[] = [];
  const api = {
    published,
    get heartbeats() {
      return hb;
    },
    claim: vi.fn(async () => ({ lease, reason: null })),
    task: vi.fn(async (_l: LeaseRef) => task),
    heartbeat: vi.fn(async (_l: LeaseRef) => {
      hb += 1;
      return o.heartbeat ? o.heartbeat(hb) : { cancelRequested: false };
    }),
    result: vi.fn(async (_l: LeaseRef, r: RunnerResult) => {
      if (o.publishThrows) throw new LeaseLostError();
      published.push(r);
    }),
    terminal: vi.fn(async () => undefined),
  } as unknown as World['api'];

  return {
    root, repo, sha, workRoot, sbx, runtime, artifacts, api, lease, task, logs, controlStreams,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
