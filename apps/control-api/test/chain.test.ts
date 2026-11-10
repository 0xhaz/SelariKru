/**
 * The whole orchestration chain, starting from a run in its real inserted state (`planning`, through the owner route) with a scripted harness inside a fake
 * sandbox: plan acceptance, claim over real HTTP, worker completion, artifact handoff, assembly, verification with an injected runner, `ready_for_review`,
 * and the owner PR route against a fake GitHub port. Real Compose Postgres. No real sandbox, no real GitHub.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDiskArtifactStore, resolveArtifactDir } from '../../../packages/artifacts/src/index.ts';
import { initEvent } from '../../../packages/harness-claude/src/fixtures.ts';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { createScheduler, reopenStaleVerification } from '@selarikru/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, withTx } from '@selarikru/persistence';
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
import { TEST_CATALOG, API_POLICY, INTRUDER_TOKEN, PROJECT, TENANT, enrolRunner, fakeVerifier, owner, post, resetDb, setupTestDb, specFor, testConfig, type TestDb } from './helpers.ts';
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

const policy = { ...API_POLICY, operations: { assign_replan_tasks: 'allow', create_draft_pr: 'allow', destructive_data_migration: 'require_approval', new_domain: 'require_approval', new_connector: 'require_approval', scope_change: 'require_approval', broader_scope: 'require_approval' } } as const;

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
    config: testConfig({ allowedOrigins: [] }), db: t.db, verifier: fakeVerifier, now, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now, policy }), policy,
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

  it.each(['new_domain', 'new_connector'] as const)('%s is refused when asked, because the runtime cannot enforce it: no approval is opened', async (operation) => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_net')]);
    const lease = await claim();
    const { report } = await runWorker(lease, ({ stream, cwd }) => { stream.push(`${toolWrite(SIGNAL(cwd), JSON.stringify({ operation, destination: { kind: 'network_host', host: 'api.example.com' }, reason: 'fetch rates' }))}\n`); return false; });
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toBe('egress_enforcement_unavailable');
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
    expect((await snapshot()).tasks.find((x) => x.taskId === 't_net')!.blockedReason).toBe('egress_enforcement_unavailable');
  });

  it.each(['scope_change', 'broader_scope'] as const)('%s is refused when asked: no approval is opened and TASK.md never offered it', async (operation) => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_scope')]);
    const lease = await claim();
    let taskFile = '';
    const { report } = await runWorker(lease, ({ stream, cwd }) => {
      taskFile = readFileSync(join(cwd, 'TASK.md'), 'utf8');
      stream.push(`${toolWrite(SIGNAL(cwd), JSON.stringify({ operation, reason: 'need more' }))}\n`);
      return false;
    });
    expect(report).toMatchObject({ outcome: 'blocked', reason: 'scope_grant_unavailable' });
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
    for (const never of ['new_domain', 'new_connector', 'scope_change', 'broader_scope']) expect(taskFile).not.toContain(never);
    expect(taskFile).toContain('breaking_api_change');
    expect(taskFile).toContain('destructive_data_migration');
  });

  it.each(['new_domain', 'new_connector', 'scope_change', 'broader_scope'] as const)('the runner route refuses %s whatever a runner sends', async (operation) => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_route')]);
    const c = await claim();
    const destination = operation === 'new_domain' || operation === 'new_connector' ? { destination: { kind: 'network_host', host: 'api.example.com' } } : {};
    const res = await post(app, '/v1/runners/result', { lease: { attemptId: c.attemptId, fence: c.fence, leaseToken: c.leaseToken }, result: { outcome: 'approval_requested', reason: 'r', operation, ...destination } }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taskStatus: 'blocked' });
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
  });

  it.each(['sk-ant-api03-abcdefghijklmnop.example.com', 'glpat-abcdefghijklmnopqrstuv.example.com', 'xoxb-1234567890-abc.example.com'])('the runner route refuses a secret-shaped destination: %s', async (host) => {
    const runId = await newRun();
    await planOf(runId, [task(runId, 't_host')]);
    const c = await claim();
    const res = await post(app, '/v1/runners/result', { lease: { attemptId: c.attemptId, fence: c.fence, leaseToken: c.leaseToken }, result: { outcome: 'approval_requested', reason: 'r', operation: 'new_domain', destination: { kind: 'network_host', host } } }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(host);
    expect(await t.db.select().from(schema.approvals)).toHaveLength(0);
  });

  it('a change_merged edge is refused at plan acceptance with a typed error', async () => {
    const runId = await newRun();
    const dep = specFor('t_b', { runId, baseSha, allowedPaths: ['src'], execution: 'local', dependencies: [{ taskId: 't_a', revision: 1, condition: 'change_merged' }] });
    const res = await planOf(runId, [task(runId, 't_a'), dep]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('plan_invalid');
    expect(res.body.error.details).toEqual([{ kind: 'unsupported_dependency_condition', taskId: 't_b', dependsOn: 't_a', condition: 'change_merged' }]);
    expect(await lifecycle(runId)).toBe('planning');
  });

  describe('owner reverify', () => {
    async function blockedOnVerifier(taskId: string): Promise<{ runId: string; sha: string; store: LocalDiskArtifactStore }> {
      const runId = await newRun();
      await planOf(runId, [task(runId, taskId)]);
      const { report } = await runWorker(await claim(), ({ write }) => { write(`src/${taskId}.ts`, 'export const v = 1;\n'); });
      expect(report.outcome).toBe('completed');
      const store = new LocalDiskArtifactStore(artifactDir);
      const { assembled } = await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick();
      const sha = assembled[0]!;
      const down = createVerificationDriver({ db: t.db, artifacts: store, runner: async () => ({ exitCode: null, result: null, log: 'docker daemon restarting' }), verifier: { kind: 'verifier', id: 'verifier-local-1' }, host: 'local-docker', tenantId: TENANT, repoPath: repo, workRoot: join(root, 'verify'), maxVerificationRetries: 0 });
      expect((await down.tick()).reaped).toEqual([sha]);
      expect(await taskStatus(taskId)).toBe('blocked');
      return { runId, sha, store };
    }
    const reverify = (runId: string, key: string, over: Record<string, unknown> = {}) => post(app, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: key, ...over });

    it('sends finished work back and reaches a verdict without running a worker, idempotently', async () => {
      const { runId, sha, store } = await blockedOnVerifier('t_redo');
      const attemptsBefore = await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_redo'`);
      const first = await reverify(runId, 'k1');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ runId, reopened: ['t_redo'] });
      expect(await taskStatus('t_redo')).toBe('verifying');
      const same = await reverify(runId, 'k1');
      expect(same.status).toBe(200);
      expect(await t.db.execute(sql`SELECT 1 FROM task_commands WHERE command = 'reverify'`)).toHaveLength(1);

      const assembled = await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick();
      expect(assembled.assembled).toEqual([sha]);
      const up = createVerificationDriver({ db: t.db, artifacts: store, runner: verifierRunner, verifier: { kind: 'verifier', id: 'verifier-local-1' }, host: 'local-docker', tenantId: TENANT, repoPath: repo, workRoot: join(root, 'verify') });
      expect((await up.tick()).verified).toBe(sha);
      expect(await taskStatus('t_redo')).toBe('verified');
      expect(await lifecycle(runId)).toBe('ready_for_review');
      expect(await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_redo'`)).toEqual(attemptsBefore);
    });

    describe('a verified task whose record went stale', () => {
      let real: { checkManifestSha256: string; verifierSha256: string };
      let trustedNow: { checkManifestSha256: string; verifierSha256: string };
      const STALE = { checkManifestSha256: 'e'.repeat(64), verifierSha256: 'f'.repeat(64) };
      let evApp: ReturnType<typeof buildApp>;
      beforeEach(async () => {
        real = { checkManifestSha256: createHash('sha256').update(readFileSync(join(verifierRoot, 'suites/feedback-board/manifest.json'))).digest('hex'), verifierSha256: verifierHashes(verifierRoot, resolve(verifierRoot, '../..')).verifierSha256 };
        trustedNow = real;
        const store = new LocalDiskArtifactStore(artifactDir);
        const now = () => new Date();
        evApp = buildApp({
          config: testConfig({ allowedOrigins: [] }), db: t.db, verifier: fakeVerifier, now, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now, policy }), policy,
          evidence: { trusted: () => trustedNow, artifacts: store, loadRecord: (key) => loadValidRecord(t.db, store, key, { trusted: trustedNow }) },
        });
        await evApp.ready();
      });
      afterEach(() => evApp.close());

      async function verifiedRun(taskId: string): Promise<{ runId: string; sha: string; store: LocalDiskArtifactStore }> {
        const runId = await newRun();
        await planOf(runId, [task(runId, taskId)]);
        const { report } = await runWorker(await claim(), ({ write }) => { write(`src/${taskId}.ts`, 'export const v = 1;\n'); });
        expect(report.outcome).toBe('completed');
        const store = new LocalDiskArtifactStore(artifactDir);
        const { assembled } = await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick();
        const sha = assembled[0]!;
        expect((await verification(store, verifierRunner).tick()).verified).toBe(sha);
        expect(await taskStatus(taskId)).toBe('verified');
        expect(await lifecycle(runId)).toBe('ready_for_review');
        return { runId, sha, store };
      }
      const verification = (store: LocalDiskArtifactStore, runner: (i: RunnerInput) => Promise<RunnerOutput>, maxVerificationRetries = 0) => createVerificationDriver({ db: t.db, artifacts: store, runner, verifier: { kind: 'verifier', id: 'verifier-local-1' }, host: 'local-docker', tenantId: TENANT, repoPath: repo, workRoot: join(root, 'verify'), maxVerificationRetries });
      const failing = async (input: RunnerInput): Promise<RunnerOutput> => {
        const passed = passingResult(input) as { quality: { allRequiredChecksPassed: boolean; criteria: { id: string; status: string; failures: unknown[]; tests: { status: string }[] }[] } };
        const c = passed.quality.criteria[0]!;
        c.status = 'failed'; c.failures = [{ test: 'a test', status: 'failed', message: 'expected 201' }]; c.tests = c.tests.map((x) => ({ ...x, status: 'failed' }));
        passed.quality.allRequiredChecksPassed = false;
        return { exitCode: 1, result: passed, log: 'ran' };
      };
      const reverify = (runId: string, key: string, over: Record<string, unknown> = {}) => post(evApp, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: key, ...over });
      const verifyingNow = () => t.db.execute(sql`SELECT status FROM task_status WHERE status = 'verifying'`);

      it('reports not valid while it runs, promotes only on a new applied record, and runs no worker', async () => {
        const { runId, sha, store } = await verifiedRun('t_stale');
        const attemptsBefore = await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_stale'`);
        trustedNow = STALE;
        expect(await loadValidRecord(t.db, store, { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: trustedNow })).toBeNull();

        const first = await reverify(runId, 'k1');
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ runId, reopened: ['t_stale'] });
        // The status during a re-verify: `verifying`, attempt reopened, run out of review, the old record no longer live.
        expect(await taskStatus('t_stale')).toBe('verifying');
        expect(await lifecycle(runId)).toBe('running');
        expect(await t.db.execute(sql`SELECT 1 FROM check_runs WHERE candidate_sha = ${sha} AND result <> 'invalidated'`)).toHaveLength(0);
        expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'run.reverted'`)).toHaveLength(1);
        // Nothing can read it as verified or open a PR on it while it is pending, even if the hashes now match again.
        trustedNow = real;
        expect(await loadValidRecord(t.db, store, { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: real })).toBeNull();
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).body.error.details).toMatchObject({ reason: 'run_not_ready' });

        // A repeat with the same key replays; a new key finds nothing more to do and spends nothing.
        const same = await reverify(runId, 'k1');
        expect(same.status).toBe(200);
        const again = await reverify(runId, 'k2');
        expect(again.status).toBe(403);
        expect(again.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
        expect(await t.db.execute(sql`SELECT 1 FROM task_commands WHERE command = 'reverify'`)).toHaveLength(1);

        // The driver reruns the same commit; the assembly driver has nothing to rebuild.
        expect((await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick()).assembled).toEqual([]);
        expect((await verification(store, verifierRunner).tick()).verified).toBe(sha);
        expect(await taskStatus('t_stale')).toBe('verified');
        expect(await lifecycle(runId)).toBe('ready_for_review');
        const fresh = await loadValidRecord(t.db, store, { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: real });
        expect(fresh?.result).toBe('passed');
        expect(await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_stale'`)).toEqual(attemptsBefore);
        expect(await verifyingNow()).toHaveLength(0);
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).status).toBe(200);
      });

      it('a failed verdict blocks the task and schedules no repair worker', async () => {
        const { runId, store } = await verifiedRun('t_stale_f');
        const attemptsBefore = await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_stale_f'`);
        trustedNow = STALE;
        expect((await reverify(runId, 'f1')).status).toBe(200);
        trustedNow = real;
        await verification(store, failing).tick();
        expect(await taskStatus('t_stale_f')).toBe('blocked');
        expect(await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked' AND task_id = 't_stale_f'`)).toMatchObject([{ payload: { reason: 'reverification_failed' } }]);
        expect(await lifecycle(runId)).toBe('running');
        expect(await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_stale_f'`)).toEqual(attemptsBefore);
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).body.error.details).toMatchObject({ reason: 'run_not_ready' });
      });

      it('an infrastructure error ends blocked with no verified record, and the bound holds', async () => {
        const { runId, sha, store } = await verifiedRun('t_stale_e');
        trustedNow = STALE;
        expect((await reverify(runId, 'e1')).status).toBe(200);
        await verification(store, async () => ({ exitCode: null, result: null, log: 'docker daemon restarting' })).tick();
        expect(await taskStatus('t_stale_e')).toBe('blocked');
        expect(await loadValidRecord(t.db, store, { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: real })).toBeNull();
      });

      const spend = (taskId: string, trusted: { checkManifestSha256: string; verifierSha256: string }, attemptId = 'spent') => t.db.insert(schema.taskCommands).values([1, 2, 3].map((n) => ({ tenantId: TENANT, projectId: PROJECT, operationId: `op_${taskId}_${trusted.verifierSha256.slice(0, 4)}_${n}`, taskId, revision: 1, command: 'reverify', state: 'applied', requestedBy: 'owner', requestedAt: new Date(), detail: { attemptId, ...trusted } })));
      const command = async (taskId: string, key: string) => {
        const [row] = await t.db.execute(sql`SELECT row_revision FROM task_status WHERE task_id = ${taskId}`);
        return post(evApp, `/v1/tasks/${taskId}/commands`, { command: 'cancel', expectedRevision: Number(row!['row_revision']), idempotencyKey: key });
      };
      const replanOf = async (runId: string, taskId: string) => post(evApp, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 1, tasks: [{ ...task(runId, taskId), revision: 2 }] });

      it('a replan that adds work to a ready run takes it out of review, and no pull request can be opened on it', async () => {
        const { runId } = await verifiedRun('t_ready_add');
        const res = await post(evApp, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 1, tasks: [task(runId, 't_ready_more')] });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await lifecycle(runId)).toBe('running');
        expect(await t.db.execute(sql`SELECT actor_kind, payload FROM events WHERE type = 'run.reverted' AND run_id = ${runId}`)).toMatchObject([{ actor_kind: 'system', payload: { reason: 'owner_replanned', taskIds: ['t_ready_more'] } }]);
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).body.error.details).toMatchObject({ reason: 'run_not_ready' });
        const snap = (await evApp.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json() as { runs: { runId: string; lifecycle: string }[] };
        expect(snap.runs.find((r) => r.runId === runId)?.lifecycle).toBe('running');
        // The verified task keeps its record; only the run's readiness went.
        expect(await taskStatus('t_ready_add')).toBe('verified');
      });

      it('an open pull request is out of date once a replan gives the run new work, through the rebuild and after the run is ready again', async () => {
        type Cr = { runId: string; prNumber: number; status: string; candidateSha: string; outOfDate: { reason: string; at: string; rebuiltSha: string | null; rebuild: string } | null };
        const crOf = async (runId: string) => ((await app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json() as { changeRequests: Cr[] }).changeRequests.find((c) => c.runId === runId);
        const { runId, sha: shaA, store } = await verifiedRun('t_pr_a');
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).status).toBe(200);
        expect((await crOf(runId))?.outOfDate).toBeNull();

        expect((await post(evApp, `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 1, tasks: [task(runId, 't_pr_b')] })).status).toBe(201);
        // Candidate A is still the latest built, but it no longer holds the run's plan.
        expect(await crOf(runId)).toMatchObject({ status: 'open', candidateSha: shaA, outOfDate: { reason: 'superseded', rebuiltSha: null, rebuild: 'building' } });

        const { report } = await runWorker(await claim(), ({ write }) => { write('src/t_pr_b.ts', 'export const b = 1;\n'); });
        expect(report.outcome).toBe('completed');
        const { assembled } = await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick();
        const shaB = assembled[0]!;
        expect(shaB).not.toBe(shaA);
        expect(await crOf(runId)).toMatchObject({ outOfDate: { reason: 'superseded', rebuiltSha: shaB, rebuild: 'verifying' } });

        expect((await verification(store, verifierRunner).tick()).verified).toBe(shaB);
        expect(await lifecycle(runId)).toBe('ready_for_review');
        // Ready again, on B: the pull request still holds A, so it must never read as ready.
        expect(await crOf(runId)).toMatchObject({ status: 'open', candidateSha: shaA, outOfDate: { reason: 'superseded', rebuiltSha: shaB, rebuild: 'verified' } });
        // The existing rule: close it to open one for B.
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).body.error.details).toMatchObject({ reason: 'candidate_changed', prNumber: expect.any(Number) });
      });

      it('leaves a valid record alone: no re-verify, no cancel, no replan', async () => {
        const { runId, sha } = await verifiedRun('t_valid');
        const valid = await reverify(runId, 'b1');
        expect(valid.status).toBe(403);
        expect(valid.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
        expect((await command('t_valid', 'c1')).status).toBe(403);
        expect((await replanOf(runId, 't_valid')).body.error.code).toBe('task_not_replannable');
        expect(await taskStatus('t_valid')).toBe('verified');
        expect(await lifecycle(runId)).toBe('ready_for_review');
        expect(await t.db.execute(sql`SELECT 1 FROM check_runs WHERE candidate_sha = ${sha} AND result = 'invalidated'`)).toHaveLength(0);
      });

      it('the bound belongs to one verifier: a new one resets it, the same one refuses', async () => {
        const { runId } = await verifiedRun('t_hash');
        trustedNow = STALE;
        await spend('t_hash', STALE);
        const over = await reverify(runId, 'h1');
        expect(over.status).toBe(403);
        expect(over.body.error.details).toMatchObject({ reason: 'reverify_limit_reached', taskId: 't_hash' });
        expect(await taskStatus('t_hash')).toBe('verified');
        expect(await lifecycle(runId)).toBe('ready_for_review');

        // A dependency bump changes the verifier hash. The three spent under the old one do not count.
        trustedNow = { ...STALE, verifierSha256: 'a'.repeat(64) };
        const reset = await reverify(runId, 'h2');
        expect(reset.status).toBe(200);
        expect(await taskStatus('t_hash')).toBe('verifying');
        expect(await t.db.execute(sql`SELECT detail ->> 'verifierSha256' AS v FROM task_commands WHERE command = 'reverify' AND detail ->> 'verifierSha256' = ${'a'.repeat(64)}`)).toHaveLength(1);
      });

      it('at the limit the owner can still cancel: the evidence is retired and the run leaves review', async () => {
        const { runId, sha, store } = await verifiedRun('t_exit_c');
        trustedNow = STALE;
        await spend('t_exit_c', STALE);
        expect((await reverify(runId, 'x1')).body.error.details).toMatchObject({ reason: 'reverify_limit_reached' });
        const res = await command('t_exit_c', 'x2');
        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({ command: 'cancel', state: 'applied', taskStatus: 'cancelled' });
        expect(await taskStatus('t_exit_c')).toBe('cancelled');
        expect(await lifecycle(runId)).toBe('running');
        expect(await t.db.execute(sql`SELECT status, reason FROM candidates WHERE sha = ${sha}`)).toMatchObject([{ status: 'invalidated', reason: 'owner_cancelled_stale_record' }]);
        // Even with the old verifier back, nothing here can read as valid or reach a pull request.
        trustedNow = real;
        expect(await loadValidRecord(t.db, store, { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: real })).toBeNull();
        expect((await post(app, `/v1/runs/${runId}/pull-request`, {})).status).toBe(409);
      });

      it('a store read that fails is not a stale record: the exit stays shut and the candidate lives', async () => {
        const { runId, sha, store } = await verifiedRun('t_exit_io');
        const sick = new Proxy(store, { get: (o, k) => (k === 'get' ? async () => { throw Object.assign(new Error('EIO: read failed'), { code: 'EIO' }); } : Reflect.get(o, k)) });
        const now = () => new Date();
        const sickApp = buildApp({
          config: testConfig({ allowedOrigins: [] }), db: t.db, verifier: fakeVerifier, now, scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now, policy }), policy,
          evidence: { trusted: () => trustedNow, artifacts: sick, loadRecord: (key) => loadValidRecord(t.db, sick, key, { trusted: trustedNow }) },
        });
        await sickApp.ready();
        try {
          const [row] = await t.db.execute(sql`SELECT row_revision FROM task_status WHERE task_id = 't_exit_io'`);
          const res = await post(sickApp, '/v1/tasks/t_exit_io/commands', { command: 'cancel', expectedRevision: Number(row!['row_revision']), idempotencyKey: 'io1' });
          expect(res.status).toBe(503);
          expect(res.body.error.code).toBe('record_store_unavailable');
          expect(await taskStatus('t_exit_io')).toBe('verified');
          expect(await t.db.execute(sql`SELECT status FROM candidates WHERE sha = ${sha}`)).toMatchObject([{ status: 'assembled' }]);
          expect(await lifecycle(runId)).toBe('ready_for_review');
        } finally {
          await sickApp.close();
        }
      });

      it('at the limit the owner can still replan, and the task starts again on a new revision', async () => {
        const { runId, sha } = await verifiedRun('t_exit_r');
        trustedNow = STALE;
        await spend('t_exit_r', STALE);
        const res = await replanOf(runId, 't_exit_r');
        expect(res.status).toBe(201);
        expect(await taskStatus('t_exit_r')).toBe('planned');
        expect(await lifecycle(runId)).toBe('running');
        expect(await t.db.execute(sql`SELECT status FROM candidates WHERE sha = ${sha}`)).toMatchObject([{ status: 'invalidated' }]);
      });

      it('cancelling one stale part sends the other back for a verdict on a candidate without it', async () => {
        const runId = await newRun();
        await planOf(runId, [task(runId, 't_pair_a'), task(runId, 't_pair_b')]);
        for (const id of ['t_pair_a', 't_pair_b']) await runWorker(await claim(), ({ write }) => { write(`src/${id}.ts`, 'export const v = 1;\n'); });
        const store = new LocalDiskArtifactStore(artifactDir);
        const assembly = () => createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick();
        const first = (await assembly()).assembled[0]!;
        await verification(store, verifierRunner).tick();
        expect(await taskStatus('t_pair_a')).toBe('verified');
        trustedNow = STALE;
        expect((await command('t_pair_a', 'p1')).status).toBe(202);
        expect(await taskStatus('t_pair_b')).toBe('verifying');
        trustedNow = real;
        const second = (await assembly()).assembled[0]!;
        expect(second).not.toBe(first);
        expect((await verification(store, verifierRunner).tick()).verified).toBe(second);
        expect(await taskStatus('t_pair_b')).toBe('verified');
        expect(await taskStatus('t_pair_a')).toBe('cancelled');
      });

      it('writes nothing when a later part cannot be re-verified', async () => {
        const runId = await newRun();
        await planOf(runId, [task(runId, 't_part_a'), task(runId, 't_part_b')]);
        for (const id of ['t_part_a', 't_part_b']) await runWorker(await claim(), ({ write }) => { write(`src/${id}.ts`, 'export const v = 1;\n'); });
        const store = new LocalDiskArtifactStore(artifactDir);
        const sha = (await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick()).assembled[0]!;
        await verification(store, verifierRunner).tick();
        await t.db.execute(sql`UPDATE task_status SET status = 'merged' WHERE task_id = 't_part_b'`);
        trustedNow = STALE;
        const refused = await reverify(runId, 'pw1');
        expect(refused.status).toBe(403);
        expect(refused.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
        // Called directly, committing whatever it wrote: a refusal must have written nothing, not rely on the route to roll back.
        const direct = await withTx(t.db, (tx) => reopenStaleVerification({ now: () => new Date() }, tx, { tenantId: TENANT, projectId: PROJECT, runId }, 'owner', 'op_direct', sha, STALE));
        expect(direct).toMatchObject({ ok: false, reason: 'nothing_to_reverify' });
        expect(await taskStatus('t_part_a')).toBe('verified');
        expect(await t.db.execute(sql`SELECT 1 FROM task_commands WHERE command = 'reverify'`)).toHaveLength(0);
        expect(await t.db.execute(sql`SELECT 1 FROM check_runs WHERE candidate_sha = ${sha} AND result = 'invalidated'`)).toHaveLength(0);
      });

      it('an error, then a re-verify, then a failed verdict starts no worker', async () => {
        const { runId, store } = await verifiedRun('t_lineage');
        const attemptsBefore = await t.db.execute(sql`SELECT attempt_id, attempt_number FROM attempts WHERE task_id = 't_lineage'`);
        trustedNow = STALE;
        expect((await reverify(runId, 'l1')).status).toBe(200);
        trustedNow = real;
        await verification(store, async () => ({ exitCode: null, result: null, log: 'docker daemon restarting' })).tick();
        expect(await taskStatus('t_lineage')).toBe('blocked');
        expect((await reverify(runId, 'l2')).status).toBe(200);
        expect(await taskStatus('t_lineage')).toBe('verifying');
        expect((await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick()).assembled).toHaveLength(1);
        await verification(store, failing).tick();
        expect(await taskStatus('t_lineage')).toBe('blocked');
        expect(await t.db.execute(sql`SELECT payload ->> 'reason' AS reason FROM events WHERE type = 'task.blocked' AND task_id = 't_lineage' ORDER BY sequence DESC LIMIT 1`)).toMatchObject([{ reason: 'reverification_failed' }]);
        expect(await t.db.execute(sql`SELECT attempt_id, attempt_number FROM attempts WHERE task_id = 't_lineage'`)).toEqual(attemptsBefore);
      });

      it('a re-assembly during a stale re-verify keeps the no-repair rule', async () => {
        const { runId, sha, store } = await verifiedRun('t_rebuilt');
        const attemptsBefore = await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_rebuilt'`);
        trustedNow = STALE;
        expect((await reverify(runId, 'r1')).status).toBe(200);
        trustedNow = real;
        // The candidate row is rebuilt from scratch: nothing kept on it can survive this.
        await t.db.execute(sql`UPDATE candidates SET status = 'invalidated', reason = 'test_rebuild' WHERE sha = ${sha}`);
        expect((await createAssemblyDriver({ db: t.db, artifacts: store, tenantId: TENANT, repoPath: repo, workRoot: join(root, 'integrate') }).tick()).assembled).toEqual([sha]);
        expect((await t.db.execute(sql`SELECT detail FROM candidates WHERE sha = ${sha}`))[0]!['detail']).not.toHaveProperty('reverification');
        await verification(store, failing).tick();
        expect(await taskStatus('t_rebuilt')).toBe('blocked');
        expect(await t.db.execute(sql`SELECT attempt_id FROM attempts WHERE task_id = 't_rebuilt'`)).toEqual(attemptsBefore);
      });

      it('a later attempt the owner asked for is repaired as usual: the rule follows the re-verified attempt', async () => {
        const { store } = await verifiedRun('t_later');
        await t.db.insert(schema.taskCommands).values({ tenantId: TENANT, projectId: PROJECT, operationId: 'op_other', taskId: 't_later', revision: 1, command: 'reverify', state: 'applied', requestedBy: 'owner', requestedAt: new Date(), detail: { attemptId: 'an_earlier_attempt' } });
        await t.db.execute(sql`UPDATE task_status SET status = 'verifying' WHERE task_id = 't_later'`);
        await t.db.execute(sql`UPDATE attempts SET outcome = 'running' WHERE task_id = 't_later'`);
        await t.db.execute(sql`UPDATE check_runs SET result = 'invalidated'`);
        await verification(store, failing).tick();
        expect(await taskStatus('t_later')).toBe('ready');
      });

      it('a stale record is refused to anyone but the owner and under a policy that withholds it', async () => {
        const { runId } = await verifiedRun('t_stale_a');
        trustedNow = STALE;
        expect((await post(evApp, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: 'a1' }, { authorization: `Bearer ${INTRUDER_TOKEN}` })).status).toBe(403);
        const denied = buildApp({ config: testConfig({ allowedOrigins: [] }), db: t.db, verifier: fakeVerifier, now: () => new Date(), scheduler: createScheduler({ catalog: TEST_CATALOG, db: t.db, now: () => new Date(), policy }), policy: { ...policy, operations: { ...policy.operations, assign_replan_tasks: 'deny' } }, evidence: { trusted: () => trustedNow, artifacts: new LocalDiskArtifactStore(artifactDir), loadRecord: async () => null } });
        await denied.ready();
        const r = await post(denied, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: 'a2' });
        await denied.close();
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('policy_denied');
        expect(await taskStatus('t_stale_a')).toBe('verified');
      });
    });

    it('is bounded, needs the owner, and refuses a run with nothing blocked on the verifier', async () => {
      const { runId } = await blockedOnVerifier('t_lim');
      expect((await post(app, `/v1/runs/${runId}/reverify`, { expectedPlanRevision: 1, idempotencyKey: 'a1' }, { authorization: `Bearer ${INTRUDER_TOKEN}` })).status).toBe(403);
      expect((await reverify(runId, 'a2', { expectedPlanRevision: 7 })).status).toBe(409);
      await t.db.insert(schema.taskCommands).values([1, 2, 3].map((n) => ({ tenantId: TENANT, projectId: PROJECT, operationId: `op_prev_${n}`, taskId: 't_lim', revision: 1, command: 'reverify', state: 'applied', requestedBy: 'owner', requestedAt: new Date() })));
      const over = await reverify(runId, 'a3');
      expect(over.status).toBe(403);
      expect(over.body.error.details).toMatchObject({ reason: 'reverify_limit_reached', taskId: 't_lim' });
      expect(await taskStatus('t_lim')).toBe('blocked');

      const other = await newRun();
      await planOf(other, [task(other, 't_other')]);
      const none = await reverify(other, 'a4');
      expect(none.status).toBe(403);
      expect(none.body.error.details).toMatchObject({ reason: 'nothing_to_reverify' });
    });
  });
});
