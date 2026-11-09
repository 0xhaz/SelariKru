/**
 * The whole orchestration chain, starting from a run in its real inserted state (`planning`, through the owner route) with a scripted harness inside a fake
 * sandbox: plan acceptance, claim over real HTTP, worker completion, artifact handoff, assembly, verification with an injected runner, `ready_for_review`,
 * and the owner PR route against a fake GitHub port. Real Compose Postgres. No real sandbox, no real GitHub.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDiskArtifactStore, resolveArtifactDir } from '../../../packages/artifacts/src/index.ts';
import { initEvent } from '../../../packages/harness-claude/src/fixtures.ts';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { createScheduler } from '@selarikru/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { eq, sql } from 'drizzle-orm';
import { FakeSbx, type FakeStream } from '../../../packages/runtime-docker-local/src/fake-sbx.ts';
import { SbxRuntimeAdapter } from '../../../packages/runtime-docker-local/src/adapter.ts';
import { HttpRunnerApi, type ClaimedLease } from '../../local-runner/src/api.ts';
import { APPROVAL_SIGNAL_RELATIVE_PATH, runAttempt, type AttemptReport } from '../../local-runner/src/attempt.ts';
import { assembleCandidate } from '../../../services/verifier/src/integrate.ts';
import { createAssemblyDriver } from '../../../services/verifier/src/assembly-driver.ts';
import { createVerificationDriver } from '../../../services/verifier/src/driver.ts';
import { candidateContentHash, loadValidRecord, type RunnerInput, type RunnerOutput } from '../../../services/verifier/src/service.ts';
import { verifierHashes } from '../../../services/verifier/src/hashing.ts';
import { API_POLICY, PROJECT, TENANT, enrolRunner, fakeVerifier, owner, post, resetDb, setupTestDb, specFor, testConfig, type TestDb } from './helpers.ts';
import { buildApp } from '../src/index.ts';

const verifierRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../services/verifier');
const manifest = JSON.parse(readFileSync(join(verifierRoot, 'suites/feedback-board/manifest.json'), 'utf8'));

function passingResult(input: RunnerInput): unknown {
  const hashes = verifierHashes(verifierRoot, resolve(verifierRoot, '../..'));
  return {
    protocolVersion: '0.1', verifier: { suiteId: manifest.suiteId, suiteVersion: manifest.version, ...hashes, image: manifest.tools.playwrightImage, tools: { node: 'v24.0.0', vitest: '5.1.0', playwright: '1.65.0' } },
    candidate: { treeSha256: candidateContentHash(input.candidateDir) }, startedAtUtc: '2026-11-09T01:00:00.000Z', endedAtUtc: '2026-11-09T01:01:00.000Z', setup: {},
    quality: { allRequiredChecksPassed: true, criteria: manifest.criteria.map((c: { id: string; tests: { runner: string; title: string }[] }) => ({ id: c.id, status: 'passed', evidenceReferences: [], failures: [], tests: c.tests.map((t) => ({ runner: t.runner, title: t.title, status: 'passed' })) })) },
  };
}
const verifierRunner = async (input: RunnerInput): Promise<RunnerOutput> => ({ exitCode: 0, result: passingResult(input), log: 'ran' });

const policy = { ...API_POLICY, operations: { assign_replan_tasks: 'allow', create_draft_pr: 'allow', destructive_data_migration: 'require_approval', new_domain: 'require_approval', scope_change: 'deny' } } as const;

let t: TestDb;
let root: string;
let repo: string;
let artifactDir: string;
let baseSha: string;
let gh: FakeGitHub;
let app: ReturnType<typeof buildApp>;
let port: number;
let token: string;
const logs: string[] = [];

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  t = await setupTestDb(8);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chain-')));
  artifactDir = join(root, 'artifacts');
  repo = join(root, 'source');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'src/base.ts'), 'export const base = 1;\n');
  mkdirSync(join(repo, 'contract'), { recursive: true });
  writeFileSync(join(repo, 'contract/runtime.md'), '# contract\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  baseSha = git('rev-parse', 'HEAD');
  gh = new FakeGitHub();
  const now = () => new Date();
  // The verifier reads the store through its own instance: the handoff is the shared location, not a shared object.
  const apiStore = new LocalDiskArtifactStore(artifactDir);
  app = buildApp({
    config: testConfig({ allowedOrigins: [] }), db: t.db, verifier: fakeVerifier, now, scheduler: createScheduler({ db: t.db, now, policy }), policy,
    github: { pullRequests: { port: gh, repoPath: repo, loadRecord: (key) => loadValidRecord(t.db, apiStore, key) } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await t?.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals, change_requests, runners, runner_pairing_codes CASCADE`);
  await t.db.execute(sql`UPDATE projects SET repository = 'acme/feedback-board'`);
  gh.calls.length = 0; gh.prs.length = 0; gh.pushes.length = 0; gh.branches.clear();
  logs.length = 0;
  token = (await enrolRunner(app, 'local')).token;
});

const SIGNAL = (cwd: string) => join(cwd, APPROVAL_SIGNAL_RELATIVE_PATH);
const toolWrite = (filePath: string, content: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: filePath, content } }] } });
const assistantText = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.05, terminal_reason: 'completed', usage: { input_tokens: 6, output_tokens: 20 } });

type Script = (ctx: { stream: FakeStream; cwd: string; write(rel: string, body: string): void }) => void | false;

async function runWorker(lease: ClaimedLease, script: Script): Promise<{ report: AttemptReport; sbx: FakeSbx }> {
  const sbx = new FakeSbx({
    onStream: (stream, args) => {
      const cwd = args[2]!;
      const write = (rel: string, body: string) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), body); };
      stream.push(`${initEvent}\n`);
      const keepOpen = script({ stream, cwd, write }) === false;
      if (keepOpen) return;
      stream.push(`${resultLine}\n`);
      stream.end(0);
    },
  });
  const runtime = new SbxRuntimeAdapter(sbx, { home: '/Users/nobody', forbidden: ['/repo/selarikru'], attemptsRoot: join(root, 'work', 'attempts'), timeouts: { signalMs: 100, graceMs: 150, stopMs: 150, lsMs: 100, createMs: 1000, rmMs: 100 } });
  const report = await runAttempt({
    api: new HttpRunnerApi(`http://127.0.0.1:${port}`, token), runtime, artifacts: new LocalDiskArtifactStore(resolveArtifactDir({ SELARIKRU_ARTIFACT_DIR: artifactDir })), workRoot: join(root, 'work'),
    repos: { [PROJECT]: repo }, heartbeatMs: 50, maxMissedHeartbeats: 3, maxTurns: 4, cpus: 2, memoryMiB: 4096, log: (l) => logs.push(l),
  }, lease);
  if (report.outcome === 'failed') logs.push(`REPORT ${JSON.stringify(report)}`);
  return { report, sbx };
}

const api = () => new HttpRunnerApi(`http://127.0.0.1:${port}`, token);
async function newRun(): Promise<string> {
  const res = await post(app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: `run-${Math.random()}`, title: 'chain', budgetLimitUsd: 100 });
  expect(res.status).toBe(201);
  return res.body.runId as string;
}
const lifecycle = async (runId: string) => String((await t.db.execute(sql`SELECT lifecycle FROM runs WHERE run_id = ${runId}`))[0]!['lifecycle']);
const taskStatus = async (id: string) => String((await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = ${id}`))[0]!['status']);
const planOf = (runId: string, tasks: ReturnType<typeof specFor>[]) => post(app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, tasks });
const task = (runId: string, taskId: string) => specFor(taskId, { runId, baseSha, allowedPaths: ['src'], execution: 'local', timeoutSeconds: 600 });
const snapshot = async () => (await app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json() as { approvals: { approvalId: string; taskId: string; scopeHash: string; operation: string; destination: string | null; reason: string; outcome: string }[]; tasks: { taskId: string; aggregateRevision: number; status: string; blockedReason: string | null }[] };
async function grant(taskId: string): Promise<void> {
  const snap = await snapshot();
  const a = snap.approvals.find((x) => x.taskId === taskId)!;
  const res = await post(app, `/v1/approvals/${a.approvalId}/resolve`, { decision: 'grant', scopeHash: a.scopeHash, expectedRevision: snap.tasks.find((x) => x.taskId === taskId)!.aggregateRevision, idempotencyKey: `g-${a.approvalId}` });
  expect(res.status).toBe(200);
}
async function claim(): Promise<ClaimedLease> {
  const c = await api().claim();
  expect(c.lease, c.reason ?? 'no lease').not.toBeNull();
  return c.lease!;
}

describe('run orchestration chain', () => {
  it('run enters running on first accepted plan', async () => {
    const runId = await newRun();
    expect(await lifecycle(runId)).toBe('planning');
    const res = await planOf(runId, [task(runId, 't_only')]);
    expect(res.status).toBe(201);
    expect(res.body.planRevision).toBe(1);
    expect(await lifecycle(runId)).toBe('running');
  });

  it('a scripted local run goes from an accepted plan to a draft PR request for the exact candidate', async () => {
    const runId = await newRun();
    expect(await lifecycle(runId)).toBe('planning');

    const accepted = await planOf(runId, [task(runId, 't_api'), task(runId, 't_web')]);
    expect(accepted.status).toBe(201);
    expect(await lifecycle(runId)).toBe('running');

    for (const file of ['src/api.ts', 'src/web.ts']) {
      const lease = await claim();
      const { report } = await runWorker(lease, ({ write }) => { write(file, 'export const v = 1;\n'); });
      expect(report.outcome, logs.join('\n')).toBe('completed');
    }
    expect(await taskStatus('t_api')).toBe('verifying');
    expect(await taskStatus('t_web')).toBe('verifying');

    // The drivers, as the server runs them, over the database and the artifact directory the runner wrote to. No manual step.
    const verifierStore = new LocalDiskArtifactStore(resolveArtifactDir({ SELARIKRU_ARTIFACT_DIR: artifactDir }));
    const assemblies = createAssemblyDriver({ db: t.db, artifacts: verifierStore, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') });
    const assembled = await assemblies.tick();
    expect(assembled.failed).toEqual([]);
    expect(assembled.assembled).toHaveLength(1);
    const sha = assembled.assembled[0]!;
    const verifications = createVerificationDriver({ db: t.db, artifacts: verifierStore, runner: verifierRunner, verifier: { kind: 'verifier', id: 'verifier-local-1' }, host: 'local-docker', tenantId: TENANT, repoPath: repo, workRoot: join(root, 'verify') });
    expect((await verifications.tick()).verified).toBe(sha);

    expect(await taskStatus('t_api')).toBe('verified');
    expect(await lifecycle(runId)).toBe('ready_for_review');
    const content = git('show', `${sha}:src/web.ts`);
    expect(content).toBe('export const v = 1;');

    const pr = await post(app, `/v1/runs/${runId}/pull-request`, {});
    expect(pr.status).toBe(200);
    expect(pr.body).toMatchObject({ status: 'opened', candidateSha: sha, adopted: false });
    expect(gh.pushes).toEqual([{ branch: pr.body.branch, sha }]);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ draft: true, headSha: sha, baseRef: 'main' });
    expect(gh.prs[0]!.body).toContain(sha);
  });

  it('artifact written by the runner is readable by the verifier', async () => {
    expect(resolveArtifactDir({ SELARIKRU_ARTIFACT_DIR: artifactDir })).toBe(artifactDir);
    expect(resolveArtifactDir({})).toBe(join(homedir(), '.selarikru', 'artifacts'));
    expect(() => resolveArtifactDir({ SELARIKRU_ARTIFACT_DIR: 'relative/dir' })).toThrow(/absolute/);

    const runId = await newRun();
    await planOf(runId, [task(runId, 't_art')]);
    const lease = await claim();
    const { report } = await runWorker(lease, ({ write }) => { write('src/art.ts', 'export const art = 1;\n'); });
    expect(report.outcome).toBe('completed');

    // A separate instance, the way the API and the verifier hold it: the handoff is the location, and the bytes are checked by hash on every read.
    const reader = new LocalDiskArtifactStore(artifactDir);
    const manifestBytes = await reader.get(report.changeManifest!);
    expect(manifestBytes).not.toBeNull();
    const parsed = JSON.parse(Buffer.from(manifestBytes!).toString()) as { changes: { path: string; sha256: string }[] };
    expect(parsed.changes.map((c) => c.path)).toEqual(['src/art.ts']);
    expect(Buffer.from((await reader.get(parsed.changes[0]!.sha256))!).toString()).toBe('export const art = 1;\n');

    // The worker's claim is only ever a pointer: a manifest that does not hash to it is refused, with the task left for a fresh attempt.
    const manifestPath = join(artifactDir, report.changeManifest!.slice(0, 2), report.changeManifest!.slice(2));
    writeFileSync(manifestPath, '{"tampered":true}');
    await expect(reader.get(report.changeManifest!)).rejects.toThrow(/do not match/);
    const r = await assembleCandidate({ tenantId: TENANT, projectId: PROJECT, runId, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo }, { db: t.db, artifacts: reader, workRoot: join(root, 'integrate2') });
    expect(r).toMatchObject({ ok: false, reason: 'manifest_corrupt' });
  });

  it('harness approval signal creates one pending approval', async () => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_mig')]);
    const lease = await claim();
    const { report, sbx } = await runWorker(lease, ({ stream, cwd }) => {
      stream.push(`${toolWrite(SIGNAL(cwd), JSON.stringify({ operation: 'destructive_data_migration', reason: 'the migration drops a column' }))}\n`);
      return false; // the runner stops the agent once it has asked
    });
    expect(report.outcome).toBe('approval_requested');
    expect(sbx.streams[0]!.isEnded).toBe(true);
    expect(await taskStatus('t_mig')).toBe('awaiting_approval');
    const rows = await t.db.select().from(schema.approvals).where(eq(schema.approvals.taskId, 't_mig'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'pending', detail: expect.objectContaining({ operation: 'destructive_data_migration', reason: 'the migration drops a column' }) });
    const snap = await snapshot();
    expect(snap.approvals).toEqual([expect.objectContaining({ taskId: 't_mig', operation: 'destructive_data_migration', reason: 'the migration drops a column', destination: null })]);
    // The attempt that asked is over and produced no change set.
    expect(await t.db.select().from(schema.candidates)).toHaveLength(0);
  });

  it('model prose cannot request approval', async () => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_prose')]);
    const lease = await claim();
    const asked = JSON.stringify({ operation: 'destructive_data_migration', reason: 'please' });
    const { report } = await runWorker(lease, ({ stream, cwd, write }) => {
      // Everything a model can do short of the tool call: say it, quote the path, and have it come back in a tool result.
      stream.push(`${assistantText(`I need approval. Writing to ${SIGNAL(cwd)}: ${asked}`)}\n`);
      stream.push(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: asked }] } })}\n`);
      write('src/done.ts', 'export const d = 1;\n');
    });
    expect(report.outcome).toBe('completed');
    expect(await taskStatus('t_prose')).toBe('verifying');
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
  });

  it('an unknown approval operation is refused, and nothing of the agent’s text is stored', async () => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_bad')]);
    const lease = await claim();
    const secretish = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { report } = await runWorker(lease, ({ stream, cwd }) => {
      stream.push(`${toolWrite(SIGNAL(cwd), JSON.stringify({ operation: 'merge_protected_branch', reason: secretish }))}\n`);
      return false;
    });
    expect(report.outcome).toBe('blocked');
    expect(await taskStatus('t_bad')).toBe('blocked');
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
    const snap = await snapshot();
    expect(snap.tasks.find((x) => x.taskId === 't_bad')!.blockedReason).toBe('approval_signal_refused: unknown_operation');
    expect(JSON.stringify(await t.db.select().from(schema.events))).not.toContain(secretish);
    expect(logs.join('\n')).not.toContain(secretish);
  });

  it('granted attempt receives its grant and does not ask again', async () => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_grant')]);
    const ask = JSON.stringify({ operation: 'destructive_data_migration', reason: 'the migration drops a column' });
    const first = await claim();
    expect(first.grants).toEqual([]);
    const asked = await runWorker(first, ({ stream, cwd }) => { stream.push(`${toolWrite(SIGNAL(cwd), ask)}\n`); return false; });
    expect(asked.report.outcome).toBe('approval_requested');
    await grant('t_grant');

    const second = await claim();
    expect(second.grants).toEqual([expect.objectContaining({ operation: 'destructive_data_migration', destination: null })]);
    const granted = second.grants[0]!;
    // The grant is spent by this attempt and is not offered to any later one.
    const row = (await t.db.select().from(schema.approvals).where(eq(schema.approvals.approvalId, granted.approvalId)))[0]!;
    expect(row).toMatchObject({ outcome: 'granted', consumedBy: second.attemptId });

    // The agent, told it is approved, asks anyway and carries on: the runner treats it as covered and the attempt completes.
    let taskFile = '';
    const { report } = await runWorker(second, ({ stream, cwd, write }) => {
      taskFile = readFileSync(join(cwd, 'TASK.md'), 'utf8');
      stream.push(`${toolWrite(SIGNAL(cwd), ask)}\n`);
      write(APPROVAL_SIGNAL_RELATIVE_PATH, ask);
      write('src/migrated.ts', 'export const m = 1;\n');
    });
    expect(report.outcome).toBe('completed');
    expect(taskFile).toMatch(/Already approved[\s\S]*destructive_data_migration/);
    expect(await taskStatus('t_grant')).toBe('verifying');
    expect(await t.db.select().from(schema.approvals).where(eq(schema.approvals.taskId, 't_grant'))).toHaveLength(1);
    // The signal file never enters the change set.
    const manifestBytes = await new LocalDiskArtifactStore(artifactDir).get(report.changeManifest!);
    expect(JSON.parse(Buffer.from(manifestBytes!).toString()).changes.map((c: { path: string }) => c.path)).toEqual(['src/migrated.ts']);
  });

  it('a network grant is refused rather than run while the sandbox cannot enforce it, with the destination in the scope', async () => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_net')]);
    const destination = { kind: 'network_host', host: 'api.example.com' };
    const first = await claim();
    const asked = await runWorker(first, ({ stream, cwd }) => { stream.push(`${toolWrite(SIGNAL(cwd), JSON.stringify({ operation: 'new_domain', destination, reason: 'fetch exchange rates' }))}\n`); return false; });
    expect(asked.report.outcome).toBe('approval_requested');
    const snap = await snapshot();
    expect(snap.approvals[0]).toMatchObject({ operation: 'new_domain', destination: 'api.example.com' });
    // The destination is part of the scope: a grant for another host is a different scope.
    const row = (await t.db.select().from(schema.approvals).where(eq(schema.approvals.taskId, 't_net')))[0]!;
    expect(row.detail).toMatchObject({ destination: 'api.example.com', destinationKind: 'network_host' });
    await grant('t_net');

    const second = await claim();
    expect(second.grants[0]).toMatchObject({ operation: 'new_domain', destination });
    const { report, sbx } = await runWorker(second, () => { throw new Error('the agent must never start'); });
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/egress_enforcement_unavailable/);
    expect(await taskStatus('t_net')).toBe('blocked');
    // Fail closed: no sandbox exists for this attempt.
    expect(sbx.calls.filter((c) => c[0] === 'create')).toEqual([]);
  });
});
