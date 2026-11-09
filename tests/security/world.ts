/**
 * One whole deployment for a negative case: the real control API on a real socket, the real scheduler, real Compose Postgres in a throwaway schema, the real local runner
 * (`runAttempt`) with its real bundle and diff gate, and the real assembly and verification drivers. The only fakes are the things that would be external:
 * the `sbx` binary (scripted agent output), the verifier's Docker run (scripted result), and GitHub. The clock is the wall clock plus an offset, so a test can age a lease or an approval.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDiskArtifactStore } from '@selarikru/artifacts';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, PROJECT, TENANT, enrolRunner, fakeVerifier, owner, post, resetDb, setupTestDb, specFor, testConfig, type TestDb } from '@selarikru/control-api/test-helpers';
import { initEvent } from '@selarikru/harness-claude/fixtures';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { createDb } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { FakeSbx, type FakeStream } from '@selarikru/runtime-docker-local/fake-sbx';
import { SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { createScheduler, type Scheduler } from '@selarikru/workflow';
import { CAPS, TEST_CATALOG, TEST_DATABASE_URL, TEST_RUNNER_REPORT } from '@selarikru/workflow/test-helpers';
import { sql } from 'drizzle-orm';
import { HttpRunnerApi, type ClaimedLease } from '../../apps/local-runner/src/api.ts';
import { APPROVAL_SIGNAL_RELATIVE_PATH, runAttempt, type AttemptReport } from '../../apps/local-runner/src/attempt.ts';
import { createAssemblyDriver } from '../../services/verifier/src/assembly-driver.ts';
import { createVerificationDriver } from '../../services/verifier/src/driver.ts';
import { verifierHashes } from '../../services/verifier/src/hashing.ts';
import { candidateContentHash, currentTrusted, loadValidRecord, type RunnerInput, type RunnerOutput } from '../../services/verifier/src/service.ts';

export { PROJECT, TENANT, owner, post, specFor, TEST_RUNNER_REPORT, CAPS, APPROVAL_SIGNAL_RELATIVE_PATH };
export { sql };
export type { ClaimedLease, FakeStream, RunnerInput, RunnerOutput };

const verifierRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../services/verifier');
export const manifest = JSON.parse(readFileSync(join(verifierRoot, 'suites/feedback-board/manifest.json'), 'utf8')) as { suiteId: string; version: string; tools: { playwrightImage: string }; criteria: { id: string; tests: { runner: string; title: string }[] }[] };
export const CRITERIA = manifest.criteria.map((c) => c.id);

type Criterion = { id: string; status: string; evidenceReferences: unknown[]; failures: { test: string; status: string; message: string }[]; tests: { runner: string; title: string; status: string }[] };
type Result = { protocolVersion: string; verifier: Record<string, unknown>; candidate: { treeSha256: string }; quality: { allRequiredChecksPassed: boolean; criteria: Criterion[] }; [k: string]: unknown };

export function passingResult(input: RunnerInput): Result {
  const hashes = verifierHashes(verifierRoot, resolve(verifierRoot, '../..'));
  return {
    protocolVersion: '0.1', verifier: { suiteId: manifest.suiteId, suiteVersion: manifest.version, ...hashes, image: manifest.tools.playwrightImage, tools: { node: 'v24.0.0', vitest: '5.1.0', playwright: '1.65.0' } },
    candidate: { treeSha256: candidateContentHash(input.candidateDir) }, startedAtUtc: '2026-11-09T01:00:00.000Z', endedAtUtc: '2026-11-09T01:01:00.000Z', setup: {},
    quality: { allRequiredChecksPassed: true, criteria: manifest.criteria.map((c) => ({ id: c.id, status: 'passed', evidenceReferences: [], failures: [], tests: c.tests.map((x) => ({ runner: x.runner, title: x.title, status: 'passed' })) })) },
  };
}
export const passing = async (input: RunnerInput): Promise<RunnerOutput> => ({ exitCode: 0, result: passingResult(input), log: 'ran' });
export const failingOn = (ids: readonly string[], message = 'expected 201, got 500', log = 'ran') => async (input: RunnerInput): Promise<RunnerOutput> => {
  const r = passingResult(input);
  for (const c of r.quality.criteria) if (ids.includes(c.id)) { c.status = 'failed'; c.failures = [{ test: `${c.id} check`, status: 'failed', message }]; c.tests = c.tests.map((x) => ({ ...x, status: 'failed' })); }
  r.quality.allRequiredChecksPassed = false;
  return { exitCode: 1, result: r, log };
};
export const skippingOn = (ids: readonly string[]) => async (input: RunnerInput): Promise<RunnerOutput> => {
  const r = passingResult(input);
  for (const c of r.quality.criteria) if (ids.includes(c.id)) { c.status = 'skipped'; c.tests = c.tests.map((x) => ({ ...x, status: 'skipped' })); }
  r.quality.allRequiredChecksPassed = false;
  return { exitCode: 1, result: r, log: 'ran' };
};

export const toolUse = (name: string, input: Record<string, unknown>, id = 'tu1') => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
export const toolWrite = (filePath: string, content: string) => toolUse('Write', { file_path: filePath, content });
export const toolResult = (content: string, id = 'tu1') => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
export const assistantText = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.05, terminal_reason: 'completed', usage: { input_tokens: 6, output_tokens: 20 } });
export const signalPath = (cwd: string) => join(cwd, APPROVAL_SIGNAL_RELATIVE_PATH);

/** What the scripted agent can do: push harness JSON lines, write files in its workspace. Returning false leaves the agent running. */
export interface AgentContext { readonly stream: FakeStream; readonly cwd: string; write(rel: string, body: string): void }
export type Script = (ctx: AgentContext) => void | false;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export const POLICY_OPS = { assign_replan_tasks: 'allow', assign_model: 'allow', create_draft_pr: 'allow', destructive_data_migration: 'require_approval', new_domain: 'require_approval', new_connector: 'require_approval', scope_change: 'require_approval', broader_scope: 'require_approval', breaking_api_change: 'require_approval' } as const;

export interface WorldOptions { readonly policy?: Policy; readonly maxConcurrent?: number; readonly dbMax?: number }

export class World {
  readonly gh = new FakeGitHub();
  readonly logs: string[] = [];
  private offsetMs = 0;
  /** Stands in for a verifier build that has moved on, as `chain.test.ts` does: the hashes evidence is held to right now. */
  trustOverride: ReturnType<typeof currentTrusted> | null = null;
  readonly trusted = (): ReturnType<typeof currentTrusted> => this.trustOverride ?? currentTrusted();
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  private constructor(
    readonly t: TestDb, readonly root: string, readonly repo: string, readonly artifactDir: string, readonly baseSha: string, readonly policy: Policy, private readonly caps: typeof CAPS,
  ) {}
  app!: ReturnType<typeof buildApp>;
  scheduler!: Scheduler;
  port = 0;
  token = '';
  /** `close` of a pool opened for a restart; closed last. */
  private pools: (() => Promise<void>)[] = [];

  static async create(opts: WorldOptions = {}): Promise<World> {
    const t = await setupTestDb(opts.dbMax ?? 12);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sec-')));
    const artifactDir = join(root, 'artifacts');
    const repo = join(root, 'source');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'contract'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, 'src/base.ts'), 'export const base = 1;\n');
    writeFileSync(join(repo, 'contract/runtime.md'), '# contract\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], { cwd: repo, env: gitEnv });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();
    const policy = opts.policy ?? ({ ...API_POLICY, operations: POLICY_OPS } as Policy);
    const w = new World(t, root, repo, artifactDir, baseSha, policy, { ...CAPS, maxConcurrentTotal: opts.maxConcurrent ?? CAPS.maxConcurrentTotal });
    await w.boot(t.db);
    return w;
  }

  private build(db: TestDb['db']) {
    const store = new LocalDiskArtifactStore(this.artifactDir);
    this.scheduler = createScheduler({ catalog: TEST_CATALOG, db, now: this.now, policy: this.policy });
    return buildApp({
      config: testConfig({ allowedOrigins: [], caps: this.caps }), db, verifier: fakeVerifier, now: this.now, scheduler: this.scheduler, policy: this.policy, catalog: TEST_CATALOG,
      evidence: { trusted: this.trusted, artifacts: store, loadRecord: (key) => loadValidRecord(db, store, key, { trusted: this.trusted() }) },
      github: { webhookSecret: WEBHOOK_SECRET, pullRequests: { port: this.gh, repoPath: this.repo, loadRecord: (key) => loadValidRecord(db, store, key, { trusted: this.trusted() }) } },
    });
  }

  /** A second controller on the same database, as during a rolling restart. Inject-only; closed with the world. */
  async secondController(): Promise<ReturnType<typeof buildApp>> {
    const { db, close } = createDb(TEST_DATABASE_URL, { max: 8, searchPath: this.t.schema });
    const app = this.build(db);
    await app.ready();
    this.pools.push(async () => { await app.close(); await close(); });
    return app;
  }

  private async boot(db: TestDb['db']): Promise<void> {
    this.app = this.build(db);
    await this.app.listen({ host: '127.0.0.1', port: this.port });
    const a = this.app.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
  }

  /**
   * The controller process dies and a new one starts on the same port: everything in memory (terminal hub, control sessions, scheduler instance, pool) is gone. Only Postgres, the artifact
   * store, GitHub and the runner's enrolment survive.
   */
  async restartController(): Promise<void> {
    await this.app.close();
    const { db, close } = createDb(TEST_DATABASE_URL, { max: 8, searchPath: this.t.schema });
    this.pools.push(close);
    await this.boot(db);
  }

  async destroy(): Promise<void> {
    await this.app?.close();
    for (const c of this.pools) await c();
    await this.t.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  async reset(): Promise<void> {
    await resetDb(this.t.db);
    await this.t.db.execute(sql`TRUNCATE integration_leases, candidates, plan_proposals, change_requests, runners, runner_pairing_codes CASCADE`);
    await this.t.db.execute(sql`UPDATE projects SET repository = 'acme/feedback-board'`);
    this.gh.calls.length = 0; this.gh.prs.length = 0; this.gh.pushes.length = 0; this.gh.branches.clear(); this.gh.fastForwards.clear();
    this.logs.length = 0;
    this.offsetMs = 0;
    this.trustOverride = null;
    this.git('reset', '-q', '--hard', this.baseSha);
    this.git('clean', '-qfdx');
    this.token = (await enrolRunner(this.app, 'local')).token;
  }

  advance(seconds: number): void { this.offsetMs += seconds * 1000; }
  git(...a: string[]): string { return execFileSync('git', a, { cwd: this.repo, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  gitCommit(file: string, body: string): string {
    mkdirSync(dirname(join(this.repo, file)), { recursive: true });
    writeFileSync(join(this.repo, file), body);
    this.git('add', '-A');
    this.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `commit ${file}`);
    return this.git('rev-parse', 'HEAD');
  }

  api(token = this.token): HttpRunnerApi { return new HttpRunnerApi(`http://127.0.0.1:${this.port}`, token); }
  enrol(location: 'local' | 'cloud' = 'local'): Promise<{ runnerId: string; token: string }> { return enrolRunner(this.app, location); }

  async newRun(over: Record<string, unknown> = {}): Promise<string> {
    const res = await post(this.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: `run-${randomBytes(6).toString('hex')}`, title: 'sec', budgetLimitUsd: 100, ...over });
    if (res.status !== 201) throw new Error(`run not created: ${JSON.stringify(res.body)}`);
    return res.body.runId as string;
  }
  task(runId: string, taskId: string, over: Parameters<typeof specFor>[1] = {}): ReturnType<typeof specFor> { return specFor(taskId, { runId, baseSha: this.baseSha, allowedPaths: ['src'], execution: 'local', timeoutSeconds: 600, ...over }); }
  plan(runId: string, tasks: readonly unknown[], expectedRevision = 0): ReturnType<typeof post> { return post(this.app, `/v1/runs/${runId}/plan-revisions`, { expectedRevision, tasks }); }

  async claim(token = this.token): Promise<ClaimedLease> {
    const c = await this.api(token).claim();
    if (c.lease === null) throw new Error(`no lease: ${c.reason ?? ''}`);
    return c.lease;
  }

  /** The real `runAttempt` against the real API, with a scripted agent inside a fake `sbx`. */
  async runWorker(lease: ClaimedLease, script: Script, opts: { token?: string; heartbeatMs?: number; sbx?: FakeSbx } = {}): Promise<{ report: AttemptReport; sbx: FakeSbx }> {
    const sbx = opts.sbx ?? new FakeSbx({
      onStream: (stream, args) => {
        const cwd = args[2]!;
        const write = (rel: string, body: string) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), body); };
        stream.push(`${initEvent}\n`);
        if (script({ stream, cwd, write }) === false) return;
        stream.push(`${resultLine}\n`);
        stream.end(0);
      },
    });
    const runtime = new SbxRuntimeAdapter(sbx, { home: '/Users/nobody', forbidden: ['/repo/selarikru'], attemptsRoot: join(this.root, 'work', 'attempts'), timeouts: { signalMs: 100, graceMs: 150, stopMs: 150, lsMs: 100, createMs: 1000, rmMs: 100 } });
    const report = await runAttempt({
      api: this.api(opts.token), runtime, artifacts: new LocalDiskArtifactStore(this.artifactDir), workRoot: join(this.root, 'work'),
      repos: { [PROJECT]: this.repo }, heartbeatMs: opts.heartbeatMs ?? 40, maxMissedHeartbeats: 3, maxTurns: 4, cpus: 2, memoryMiB: 4096, log: (l) => this.logs.push(l),
    }, lease);
    return { report, sbx };
  }

  store(): LocalDiskArtifactStore { return new LocalDiskArtifactStore(this.artifactDir); }
  assembly() { return createAssemblyDriver({ db: this.t.db, artifacts: this.store(), tenantId: TENANT, repoPath: this.repo, workRoot: join(this.root, 'integrate'), now: this.now }); }
  verification(runner: (i: RunnerInput) => Promise<RunnerOutput>, maxVerificationRetries = 0) {
    return createVerificationDriver({ db: this.t.db, artifacts: this.store(), runner, verifier: { kind: 'verifier', id: 'verifier-local-1' }, host: 'local-docker', tenantId: TENANT, repoPath: this.repo, workRoot: join(this.root, 'verify'), maxVerificationRetries, now: this.now });
  }

  async claimAndComplete(taskId: string, file = `src/${taskId}.ts`): Promise<AttemptReport> {
    const lease = await this.claim();
    if (lease.taskId !== taskId) throw new Error(`claimed ${lease.taskId}, wanted ${taskId}`);
    const { report } = await this.runWorker(lease, ({ write }) => { write(file, 'export const v = 1;\n'); });
    if (report.outcome !== 'completed') throw new Error(`attempt ${report.outcome}: ${report.reason ?? ''}\n${this.logs.join('\n')}`);
    return report;
  }

  /** A verified run through every real driver: plan, claim, worker, assembly, verification. */
  async verifiedRun(taskIds: readonly string[], over: (taskId: string) => Parameters<typeof specFor>[1] = () => ({})): Promise<{ runId: string; sha: string }> {
    const runId = await this.newRun();
    const res = await this.plan(runId, taskIds.map((id) => this.task(runId, id, over(id))));
    if (res.status !== 201) throw new Error(`plan refused: ${JSON.stringify(res.body)}`);
    for (const id of taskIds) await this.claimAndComplete(id);
    const assembled = await this.assembly().tick();
    if (assembled.failed.length > 0 || assembled.assembled.length !== 1) throw new Error(`assembly: ${JSON.stringify(assembled)}`);
    const sha = assembled.assembled[0]!;
    const verified = await this.verification(passing).tick();
    if (verified.verified !== sha) throw new Error(`verification: ${JSON.stringify(verified)}`);
    return { runId, sha };
  }

  async snapshot(): Promise<any> {
    const res = await this.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() });
    if (res.statusCode !== 200) throw new Error(`snapshot ${res.statusCode}: ${res.body}`);
    return res.json();
  }
  async status(taskId: string): Promise<{ status: string; rowRevision: number; placementBlock: string | null }> {
    const [r] = await this.t.db.execute(sql`SELECT status, row_revision, placement_block FROM task_status WHERE task_id = ${taskId}`);
    return { status: String(r!['status']), rowRevision: Number(r!['row_revision']), placementBlock: (r!['placement_block'] as string | null) ?? null };
  }
  async lifecycle(runId: string): Promise<string> { return String((await this.t.db.execute(sql`SELECT lifecycle FROM runs WHERE run_id = ${runId}`))[0]!['lifecycle']); }
  async count(table: string, where = 'true'): Promise<number> { return Number((await this.t.db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(where)}`))[0]!['n']); }
  command(taskId: string, expectedRevision: number, key: string, command = 'cancel'): ReturnType<typeof post> { return post(this.app, `/v1/tasks/${taskId}/commands`, { command, expectedRevision, idempotencyKey: key }); }

  /** Every row of every table in this test's schema, as text. The widest possible "was it stored anywhere" check. */
  async dumpAllTables(): Promise<Record<string, string>> {
    const tables = await this.t.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${this.t.schema} AND table_type = 'BASE TABLE'`);
    const out: Record<string, string> = {};
    for (const row of tables) {
      const name = String(row['table_name']);
      out[name] = JSON.stringify(await this.t.db.execute(sql`SELECT * FROM ${sql.raw(`"${name}"`)}`), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    }
    return out;
  }
}

export const WEBHOOK_SECRET = 'whsec_security_suite_shared';
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Every regular file under `dir`, relative path to text. Follows no symlink. `.git` is read too, so a remote or credential recorded there shows up. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(dir, p)] = readFileSync(p).toString('utf8');
    }
  };
  walk(dir);
  return out;
}

/** Everything the agent was launched with: every sbx argument and everything written to its stdin. */
export const launchPayload = (sbx: FakeSbx): string => JSON.stringify({ calls: sbx.calls, stdin: sbx.streams.map((s) => s.written) });

/** Frames from a terminal SSE stream until `until` holds or `ms` passes. */
export async function readTerminal(w: World, attemptId: string, until: (text: string) => boolean, ms = 3000): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${w.port}/v1/projects/${PROJECT}/attempts/${attemptId}/terminal`, { headers: { authorization: 'Bearer firebase-owner-token' }, signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`terminal ${res.status}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (!until(buf) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
  }
  ctrl.abort();
  await reader.cancel().catch(() => undefined);
  return buf;
}
