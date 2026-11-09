/**
 * Case: secret canaries. Every place a secret can enter is seeded with its own canary (the runner's environment, the source tree, the owner's free text, the agent's output, the verifier's
 * output), and every place it could come out is read back: what the agent was launched with and can read, the runner's logs, every row of every table, snapshots, terminal output, usage,
 * the PR body and the stored verifier log. Each list is paired with a control: the canary really was produced, so an absence cannot be the result of nothing having happened.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assistantText, failingOn, launchPayload, passing, post, readTerminal, readTree, resultLine, signalPath, sql, toolResult, toolUse, toolWrite, World } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

// Unique per seed so a failure names its source. Each has a real credential's shape, because that is what the redactors are specified against.
const ENV = { ANTHROPIC_API_KEY: 'sk-ant-api03-ENVCANARYaaaaaaaaaaaaaaaaaaaaaa', GITHUB_TOKEN: 'ghp_ENVCANARYbbbbbbbbbbbbbbbbbbbbbbbbbbbb', GH_TOKEN: 'gho_ENVCANARYccccccccccccccccccccccccccc', SELARIKRU_API_KEY: 'sk_live_ENVCANARYdddddddddddddd' } as const;
const OWNER_TITLE = 'sk_live_OWNERTITLECANARY000000';
const OWNER_DESC = 'ghp_OWNERDESCCANARYeeeeeeeeeeeeeeeeeeeeeee';
const TASK_TITLE = 'glpat-TASKTITLECANARYffffffffff';
const FILE_UNTRACKED = 'sk-ant-api03-UNTRACKEDFILECANARYgggggggggg';
const FILE_TRACKED = 'sk-ant-api03-TRACKEDENVCANARYhhhhhhhhhhhhhh';
const AGENT_TEXT = 'ghp_AGENTTEXTCANARYiiiiiiiiiiiiiiiiiiiiiii';
const AGENT_BASH = 'xoxb-AGENTBASHCANARY-jjjjjjjjjjjjjjj';
const TOOL_OUTPUT = 'AKIAQ1TOOLOUTPUTCANA';
const RESULT_REASON = 'ghp_RESULTREASONCANARYkkkkkkkkkkkkkkkkkkkk';
const APPROVAL_REASON = 'sk_live_APPROVALREASONCANARY11111';
const VERIFIER_MSG = 'ghp_VERIFIERMSGCANARYmmmmmmmmmmmmmmmmmmmmm';
const VERIFIER_LOG = 'sk-ant-api03-VERIFIERLOGCANARYnnnnnnnnnnnn';

const ALL = [...Object.values(ENV), OWNER_TITLE, OWNER_DESC, TASK_TITLE, FILE_UNTRACKED, FILE_TRACKED, AGENT_TEXT, AGENT_BASH, TOOL_OUTPUT, RESULT_REASON, APPROVAL_REASON, VERIFIER_MSG, VERIFIER_LOG];
const absent = (surface: string, text: string, canaries: readonly string[] = ALL): void => {
  for (const c of canaries) expect(text.includes(c), `${surface} contains ${c}`).toBe(false);
};
const saved: Partial<Record<string, string | undefined>> = {};

describe('secret canaries', () => {
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('none reaches the agent’s launch, the agent’s workspace, or anything the run stores or shows', async () => {
    // Source tree: a file git does not track, and a tracked .env. The bundle is built at the pinned commit, so seed both before planning.
    const base = w.gitCommit('.env', `GITHUB_TOKEN=${FILE_TRACKED}\n`);
    mkdirSync(join(w.repo, 'config'), { recursive: true });
    writeFileSync(join(w.repo, 'config/local-secrets.json'), JSON.stringify({ key: FILE_UNTRACKED }));
    const runId = await w.newRun({ title: `Deploy with ${OWNER_TITLE}`, description: `password=${OWNER_DESC}` });
    const spec = w.task(runId, 't_can', { baseSha: base, title: `Use token ${TASK_TITLE}`, requirementIds: ['FB-01'] });
    expect((await w.plan(runId, [spec])).status).toBe(201);

    const lease = await w.claim();
    expect(lease.streamable).toBe(true);
    let workspace: Record<string, string> = {};
    const { report, sbx } = await w.runWorker(lease, ({ stream, cwd, write }) => {
      workspace = readTree(cwd);
      stream.push(`${assistantText(`I found the key ${AGENT_TEXT} in memory`)}\n`);
      stream.push(`${toolUse('Bash', { command: `curl -H "Authorization: Bearer ${AGENT_BASH}" https://example.test` })}\n`);
      stream.push(`${toolResult(`aws key ${TOOL_OUTPUT}0123456789 printed`)}\n`);
      write('src/x.ts', 'export const x = 1;\n');
    });
    expect(report.outcome, w.logs.join('\n')).toBe('completed');

    // Controls: the bundle really is at that commit and the agent really produced these strings.
    expect(workspace['src/base.ts']).toBeDefined();
    expect(JSON.stringify(sbx.streams[0]!.args)).toContain('claude');
    const pushed = JSON.stringify(sbx.streams[0]!.written);
    expect(pushed.length).toBeGreaterThan(0);

    absent('agent launch payload', launchPayload(sbx));
    absent('agent workspace at start', JSON.stringify(workspace));

    const assembled = await w.assembly().tick();
    const sha = assembled.assembled[0]!;
    await w.verification(failingOn(['FB-01'], `leaked ${VERIFIER_MSG}`, `container said ${VERIFIER_LOG}`)).tick();

    const terminal = await readTerminal(w, lease.attemptId, (t) => t.includes('Finished'), 1500);
    expect(terminal).toContain('[REDACTED]');
    absent('terminal output', terminal);

    absent('runner logs', w.logs.join('\n'));
    const tables = await w.dumpAllTables();
    for (const [name, rows] of Object.entries(tables)) absent(`table ${name}`, rows);
    expect(tables['events']!).toContain('[REDACTED]');
    const snapshot = await w.snapshot();
    absent('snapshot', JSON.stringify(snapshot));
    expect(JSON.stringify(snapshot)).toContain('[REDACTED]');
    expect(sha).toBeTruthy();

    const failures = await w.app.inject({ method: 'GET', url: `/v1/projects/proj_a/runs/${runId}/failures`, headers: { authorization: 'Bearer firebase-owner-token' } });
    expect(failures.json().available).toBe(true);
    absent('verification failures route', failures.body);

    const artifacts = Object.values(readTree(w.artifactDir)).join('\n');
    expect(artifacts).toContain('[REDACTED]'); // The verifier's log and result really were stored, and were cleaned first.
    absent('artifact store', artifacts, [VERIFIER_MSG, VERIFIER_LOG]);
  });

  it('a tracked .env is not shipped to the agent', async () => {
    const base = w.gitCommit('.env.production', `GITHUB_TOKEN=${FILE_TRACKED}\n`);
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_env', { baseSha: base })]);
    let files: string[] = [];
    await w.runWorker(await w.claim(), ({ cwd, write }) => { files = Object.keys(readTree(cwd)).filter((f) => !f.startsWith('.git/')); write('src/y.ts', 'export const y = 1;\n'); });
    expect(files).toContain('src/base.ts');
    expect(files.filter((f) => /(^|\/)\.env/.test(f))).toEqual([]);
  });

  it('control: a checked-in env template is still shipped, so the exclusion is by name and not everything dotted', async () => {
    const base = w.gitCommit('.env.example', 'API_URL=http://localhost\n');
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_tmpl', { baseSha: base })]);
    let files: string[] = [];
    await w.runWorker(await w.claim(), ({ cwd, write }) => { files = Object.keys(readTree(cwd)); write('src/t.ts', 'export const t = 1;\n'); });
    expect(files).toContain('.env.example');
  });

  it('none reaches a PR body, however the run got there', async () => {
    const runId = await w.newRun({ title: `Deploy with ${OWNER_TITLE}` });
    await w.plan(runId, [w.task(runId, 't_pr', { title: `token=${TASK_TITLE}` })]);
    const { report } = await w.runWorker(await w.claim(), ({ stream, write }) => {
      stream.push(`${assistantText(`sneaking ${AGENT_TEXT} into the review`)}\n`);
      write('src/pr.ts', 'export const pr = 1;\n');
    });
    expect(report.outcome, w.logs.join('\n')).toBe('completed');
    const sha = (await w.assembly().tick()).assembled[0]!;
    expect((await w.verification(passing).tick()).verified).toBe(sha);
    // A poisoned row: the body's redaction is the last line of defence for anything stored, so something stored must carry a canary for that line to be tested.
    await w.t.db.execute(sql`INSERT INTO approvals (tenant_id, project_id, approval_id, run_id, task_id, revision, requester, action_hash, scope_hash, outcome, approver, detail) VALUES ('tenant_a', 'proj_a', 'apr_p', ${runId}, 't_pr', 1, 'worker', 'a', 's', 'granted', ${AGENT_TEXT}, ${JSON.stringify({ operation: 'destructive_data_migration' })}::jsonb)`);
    const res = await post(w.app, `/v1/runs/${runId}/pull-request`, {});
    expect(res.status).toBe(200);
    expect(w.gh.prs[0]!.body).toContain(sha);
    expect(w.gh.prs[0]!.body).toContain('Approvals granted');
    absent('PR body', w.gh.prs[0]!.body);
    absent('PR title', w.gh.prs[0]!.title);
  });

  it('none of the runner’s credentials reaches the agent or anything stored', async () => {
    const enrolled = await w.enrol();
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_cred')]);
    const lease = await w.claim(enrolled.token);
    let workspace: Record<string, string> = {};
    const { sbx } = await w.runWorker(lease, ({ cwd, write }) => { workspace = readTree(cwd); write('src/z.ts', 'export const z = 1;\n'); }, { token: enrolled.token });
    const secrets = [enrolled.token, lease.leaseToken];
    absent('agent launch payload', launchPayload(sbx), secrets);
    absent('agent workspace', JSON.stringify(workspace), secrets);
    absent('runner logs', w.logs.join('\n'), secrets);
    // The lease token is stored as the lease's identity. The runner token is stored only as its hash.
    const tables = await w.dumpAllTables();
    for (const [name, rows] of Object.entries(tables)) expect(rows.includes(enrolled.token), `table ${name} has the runner token`).toBe(false);
    for (const [name, rows] of Object.entries(tables)) if (name !== 'attempts') expect(rows.includes(lease.leaseToken), `table ${name} has the lease token`).toBe(false);
    absent('snapshot', JSON.stringify(await w.snapshot()), secrets);
  });

  it('a runner that sends secrets itself is cleaned by the control plane, not trusted to have done it', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_rogue', { maxAttempts: 3 })]);
    const auth = { authorization: `Bearer ${w.token}` };
    const ref = (l: { attemptId: string; fence: number; leaseToken: string }) => ({ attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken });
    const first = await w.claim();
    expect((await post(w.app, '/v1/runners/result', { lease: ref(first), result: { outcome: 'failed', reason: `boom ${RESULT_REASON}` } }, auth)).status).toBe(200);
    const second = await w.claim();
    expect((await post(w.app, '/v1/runners/result', { lease: ref(second), result: { outcome: 'approval_requested', operation: 'destructive_data_migration', reason: `because ${APPROVAL_REASON}` } }, auth)).status).toBe(200);

    const tables = await w.dumpAllTables();
    for (const [name, rows] of Object.entries(tables)) absent(`table ${name}`, rows);
    expect(tables['events']).toContain('[REDACTED]');
    absent('snapshot', JSON.stringify(await w.snapshot()));
  });

  it('a worker-reported failure reason, an approval reason and an odd tool name stay out of events and logs', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_fail', { maxAttempts: 3 }), w.task(runId, 't_ask')]);
    const first = await w.claim();
    const firstTask = first.taskId;
    const failure = JSON.stringify({ type: 'result', subtype: `error ${RESULT_REASON}`, is_error: true, num_turns: 1, duration_ms: 1, total_cost_usd: 0, terminal_reason: RESULT_REASON, usage: { input_tokens: 1, output_tokens: 1 } });
    const sbxFail = await w.runWorker(first, ({ stream }) => {
      stream.push(`${toolUse(`weird-${RESULT_REASON}`, {})}\n`);
      stream.push(`${failure}\n`);
      stream.end(1);
      return false;
    });
    expect(sbxFail.report.outcome).toBe('failed');

    let lease = await w.claim();
    if (lease.taskId === firstTask) { await w.runWorker(lease, ({ stream }) => { stream.push(`${failure}\n`); stream.end(1); return false; }); lease = await w.claim(); }
    await w.runWorker(lease, ({ stream, cwd }) => { stream.push(`${toolWrite(signalPath(cwd), JSON.stringify({ operation: 'destructive_data_migration', reason: `because ${APPROVAL_REASON}` }))}\n`); return false; });

    const tables = await w.dumpAllTables();
    for (const [name, rows] of Object.entries(tables)) absent(`table ${name}`, rows);
    expect(tables['approvals']).toContain('[REDACTED]');
    absent('runner logs', w.logs.join('\n'));
    absent('snapshot', JSON.stringify(await w.snapshot()));
    expect(await w.count('attempts')).toBeGreaterThan(1);
    expect(readFileSync(join(w.repo, 'src/base.ts'), 'utf8')).toContain('base');
    expect(resultLine).toContain('success');
  });
});
