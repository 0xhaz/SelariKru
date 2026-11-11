import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLY_HARNESS_REPORT, APPLY_LIMITS, RESTRICTED_APPLY_REFUSAL, sha256Hex, type AcceptedProposal } from '@selarikru/domain';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { FileRelay } from '../src/apply.ts';
import { PROJECT, TENANT, TEST_RUNNER_REPORT, bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await h?.app.close();
  h = makeHarness(t, { codingWorkers: 'off' }, undefined, { fileRelay: new FileRelay(3_000) });
});

const BASE = 'e'.repeat(40);
const CONTENT = 'export const posts = [];\n';
const DIFF = '--- /dev/null\n+++ b/src/posts.ts\n@@ -0,0 +1 @@\n+export const posts = [];\n';
const proposal = (over: Partial<AcceptedProposal> = {}): AcceptedProposal => ({
  proposalId: 'req_1', taskId: 't1', taskRevision: 1, baseSha: BASE, routeRecordId: 'req_1', diff: DIFF,
  results: [{ path: 'src/posts.ts', sha256: sha256Hex(CONTENT), content: CONTENT }], ...over,
});
const URL = `/v1/projects/${PROJECT}/tasks/t1/proposals/accept`;
const accept = (p: unknown, key = `k-${Math.random()}`) => post(h.app, URL, { idempotencyKey: key, proposal: p });
let rid = 0;
const routeRecord = (requestId = 'req_1', over: Record<string, unknown> = {}, diff = DIFF) => t.db.insert(schema.clientReports).values({
  tenantId: TENANT, projectId: PROJECT, reportId: `rpt_${(rid += 1)}`, subjectKind: 'task', subjectId: 't1', kind: 'route', trust: 'untrusted',
  payload: { requestId, stepKind: 'patch', status: 'ok', outputSha256: sha256Hex(diff), ...over }, reportedBy: 'owner_uid_1',
});

describe('accepting a patch proposal (H5)', () => {
  beforeEach(async () => {
    await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'] }));
    await routeRecord();
  });

  it('records it, with an owner event of ids and hashes, and an apply runner claims it with the proposal on its lease', async () => {
    const res = await accept(proposal());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ proposalId: 'req_1', taskId: 't1', revision: 1, fileCount: 1, state: 'accepted', round: 1, lastFailure: null });
    const events = await t.db.execute(sql`SELECT type, actor_kind, payload::text AS p FROM events`);
    expect(events.map((e) => [e['type'], e['actor_kind']])).toEqual([['proposal.accepted', 'human']]);
    expect(String(events[0]!['p'])).not.toContain('posts = []');

    const { token } = await enrolRunner(h.app, 'local', [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT]);
    const claim = await post(h.app, '/v1/runners/claim', { harnesses: [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT], projects: [PROJECT] }, bearer(token));
    expect(claim.body.lease).toMatchObject({ taskId: 't1', assignment: { provider: 'selarikru', model: 'apply-proposal', route: 'none', source: 'proposal' }, proposal: { proposalId: 'req_1', fileCount: 1 } });
    const lease = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };
    const fetched = await post(h.app, '/v1/runners/proposal/fetch', { lease }, bearer(token));
    expect(fetched.status).toBe(200);
    expect(fetched.body.proposal).toMatchObject({ proposalId: 'req_1', results: [{ path: 'src/posts.ts', content: CONTENT }] });
    expect((await post(h.app, '/v1/runners/proposal/fetch', { lease: { ...lease, leaseToken: 'wrong' } }, bearer(token))).status).toBe(409);
  });

  it('with coding workers off, a runner that only has Claude gets nothing: no model worker is launched for the task', async () => {
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: [PROJECT] }, bearer(token));
    expect(claim.body.lease).toBeNull();
    expect(claim.body.skipped).toEqual([{ taskId: 't1', reason: 'awaiting_accepted_proposal' }]);
  });

  it('re-validates on the server: a tampered hash, an outside path, a reserved path, an oversize result and a mismatched base are refused', async () => {
    const tampered = await accept(proposal({ results: [{ path: 'src/posts.ts', sha256: sha256Hex('other'), content: CONTENT }] }));
    expect([tampered.status, tampered.body.error.details.reason]).toEqual([422, 'hash_mismatch']);
    const at = (path: string) => proposal({ diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`, results: [{ path, sha256: sha256Hex('x\n'), content: 'x\n' }] });
    expect((await accept(at('docs/x.md'))).body.error.details.reason).toBe('path_outside_allowed');
    expect((await accept(at('src/.env.local'))).body.error.details.reason).toBe('path_reserved');
    const big = 'x'.repeat(APPLY_LIMITS.fileChars + 1);
    const oversize = await accept(proposal({ results: [{ path: 'src/posts.ts', sha256: sha256Hex(big), content: big }] }));
    expect(oversize.status).toBe(422);
    expect(oversize.body.error.details.reason).toBe('result_too_large');
    const base = await accept(proposal({ baseSha: 'f'.repeat(40) }));
    expect([base.status, base.body.error.details.reason]).toEqual([409, 'base_mismatch']);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM accepted_proposals`))[0]!['n'])).toBe(0);
  });

  it('needs the route record of the very call that produced it: the same request, an ok patch, and the hash of this diff', async () => {
    const other = await accept(proposal({ routeRecordId: 'req_other' }));
    expect([other.status, other.body.error.code, other.body.error.details.reason]).toEqual([409, 'route_record_missing', 'route_record_mismatch']);
    expect((await accept(proposal({ proposalId: 'req_none', routeRecordId: 'req_none' }))).body.error.code).toBe('route_record_missing');
    await routeRecord('req_blocked', { status: 'blocked' });
    expect((await accept(proposal({ proposalId: 'req_blocked', routeRecordId: 'req_blocked' }))).body.error.code).toBe('route_record_missing');
    // A recorded call whose output was another diff.
    await routeRecord('req_swap', {}, 'some other diff');
    const swapped = await accept(proposal({ proposalId: 'req_swap', routeRecordId: 'req_swap' }));
    expect(swapped.body.error.details.reason).toBe('route_record_output_mismatch');
  });

  it('the same key reads the proposal as it is now; a proposal still waiting is not queued twice', async () => {
    const first = await accept(proposal(), 'same');
    expect((await accept(proposal(), 'same')).body).toEqual(first.body);
    const again = await accept(proposal(), 'other');
    expect([again.body.error.code, again.body.error.details.state]).toEqual(['proposal_already_accepted', 'accepted']);
  });

  it('after a failed apply, the same key says why, and accepting again queues a new apply (I1)', async () => {
    expect((await accept(proposal(), 'k1')).status).toBe(201);
    const { token } = await enrolRunner(h.app, 'local', [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT]);
    const claim = async () => (await post(h.app, '/v1/runners/claim', { harnesses: [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT], projects: [PROJECT] }, bearer(token))).body.lease;
    const first = await claim();
    const lease = { attemptId: first.attemptId, fence: first.fence, leaseToken: first.leaseToken };
    expect((await post(h.app, '/v1/runners/result', { lease, result: { outcome: 'failed', reason: 'tests_failed: pnpm run test exited with code 1' } }, bearer(token))).status).toBe(200);
    const read = await accept(proposal(), 'k1');
    expect([read.status, read.body.state, read.body.lastFailure]).toEqual([200, 'failed', 'tests_failed: pnpm run test exited with code 1']);
    const queued = await accept(proposal(), 'k2');
    expect([queued.status, queued.body.state, queued.body.round]).toEqual([201, 'accepted', 2]);
    const second = await claim();
    expect(second).toMatchObject({ proposal: { proposalId: 'req_1' } });
    expect(second.attemptId).not.toBe(first.attemptId);
  });
});

describe('restricted proposals never reach the server (H5)', () => {
  it('refuses before the body is read: nothing is validated, stored or put in an event', async () => {
    await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'], classification: 'restricted' }));
    await routeRecord();
    const res = await accept(proposal());
    expect([res.status, res.body.error.code, res.body.error.message]).toEqual([403, 'proposal_restricted', RESTRICTED_APPLY_REFUSAL]);
    // A body that would fail every check gets the same answer: it was never parsed.
    expect((await post(h.app, URL, { garbage: true })).body.error.code).toBe('proposal_restricted');
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM accepted_proposals`))[0]!['n'])).toBe(0);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM events`))[0]!['n'])).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('posts = []');
  });

  it('never serves a restricted task\'s base files', async () => {
    await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'], classification: 'restricted' }));
    const res = await post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, {});
    expect([res.status, res.body.error.code]).toEqual([403, 'files_restricted']);
  });
});

describe('the change a review and a PR description read (H5)', () => {
  it('is the applied proposal once its apply attempt published a change set', async () => {
    await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'] }));
    await routeRecord();
    await accept(proposal());
    const ctx = () => get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context?destination=local`);
    const size = () => get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context-size?destination=local`);
    expect((await ctx()).body.change).toBeNull();
    const { token } = await enrolRunner(h.app, 'local', [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT]);
    const claim = await post(h.app, '/v1/runners/claim', { harnesses: [...TEST_RUNNER_REPORT, APPLY_HARNESS_REPORT], projects: [PROJECT] }, bearer(token));
    const lease = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };
    // Running: no change yet.
    expect((await size()).body.hasChange).toBe(false);
    const done = await post(h.app, '/v1/runners/result', { lease, result: { outcome: 'completed', changeManifestSha256: 'a'.repeat(64) } }, bearer(token));
    expect(done.status).toBe(200);
    expect((await ctx()).body.change).toEqual({ diff: DIFF, files: [{ path: 'src/posts.ts', classification: 'internal' }] });
    expect((await size()).body.hasChange).toBe(true);
  });
});

describe('base files for the patch agent, relayed from the runner (H5)', () => {
  beforeEach(async () => { await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'] })); });

  it('a runner with the project answers the waiting read; the answer is screened again and nothing is kept', async () => {
    const { token } = await enrolRunner(h.app);
    await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: [PROJECT] }, bearer(token));
    const read = post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, { paths: ['src'] });
    let requests: { requestId: string; baseSha: string; paths: string[]; allowedPaths: string[] }[] = [];
    await vi.waitFor(async () => {
      requests = (await post(h.app, '/v1/runners/files/poll', {}, bearer(token))).body.requests;
      expect(requests).toHaveLength(1);
    }, { timeout: 2_500, interval: 20 });
    expect(requests[0]).toMatchObject({ baseSha: BASE, paths: ['src'], allowedPaths: ['src'] });
    const answered = await post(h.app, '/v1/runners/files/answer', {
      requestId: requests[0]!.requestId,
      files: [{ path: 'src/a.ts', content: 'a\n' }, { path: 'src/.env', content: 'X=1\n' }, { path: 'docs/x.md', content: 'x\n' }],
      omitted: [{ path: 'src/big.ts', reason: 'too_large' }],
    }, bearer(token));
    expect(answered.status).toBe(200);
    const res = await read;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: 't1', revision: 1, baseSha: BASE, files: [{ path: 'src/a.ts', content: 'a\n' }], omitted: [{ path: 'src/big.ts', reason: 'too_large' }] });
    // Taken once: a second answer finds nothing waiting.
    expect((await post(h.app, '/v1/runners/files/answer', { requestId: requests[0]!.requestId, files: [], omitted: [] }, bearer(token))).status).toBe(404);
  });

  it('a path outside the task is refused, and no runner answering is a timeout that says so', async () => {
    expect((await post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, { paths: ['docs'] })).status).toBe(422);
    const res = await post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, { paths: ['src/a.ts'] });
    expect([res.status, res.body.error.code]).toEqual([504, 'files_unavailable']);
  });

  it('a runner without the project is never asked', async () => {
    const { token } = await enrolRunner(h.app);
    await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: ['other_project'] }, bearer(token));
    const read = post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, { paths: ['src/a.ts'] });
    await vi.waitFor(async () => { expect((await post(h.app, '/v1/runners/files/poll', {}, bearer(token))).body.requests).toEqual([]); }, { timeout: 1_000, interval: 50 });
    expect((await read).status).toBe(504);
  });
});

describe('fix round 1: the relay (I4, M3)', () => {
  const owner = () => ({ authorization: 'Bearer firebase-owner-token' });
  const allowed = Array.from({ length: 12 }, (_, i) => `src/m${i}`);
  beforeEach(async () => { await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: allowed })); });
  const takeOne = async (token: string) => {
    let requests: { requestId: string; mode: string; paths: string[] }[] = [];
    await vi.waitFor(async () => { requests = (await post(h.app, '/v1/runners/files/poll', {}, bearer(token))).body.requests; expect(requests).toHaveLength(1); }, { timeout: 2_500, interval: 20 });
    return requests[0]!;
  };

  it('lists the files under more than 8 allowed paths, paths and sizes only, screened again', async () => {
    const { token } = await enrolRunner(h.app);
    await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: [PROJECT] }, bearer(token));
    const listing = post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files/list`, {});
    const req = await takeOne(token);
    expect(req).toMatchObject({ mode: 'list', paths: allowed });
    await post(h.app, '/v1/runners/files/answer', { requestId: req.requestId, files: [], omitted: [], entries: [{ path: 'src/m11/a.ts', size: 3 }, { path: 'src/m1/.env', size: 1 }, { path: 'docs/x.md', size: 1 }], truncated: false }, bearer(token));
    const res = await listing;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: 't1', revision: 1, baseSha: BASE, entries: [{ path: 'src/m11/a.ts', size: 3 }], truncated: false });
    void owner;
  });

  it('only the runner that took a read may answer it', async () => {
    const a = await enrolRunner(h.app);
    const b = await enrolRunner(h.app);
    for (const r of [a, b]) await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: [PROJECT] }, bearer(r.token));
    const read = post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files`, { paths: ['src/m1/a.ts'] });
    const req = await takeOne(a.token);
    expect((await post(h.app, '/v1/runners/files/answer', { requestId: req.requestId, files: [{ path: 'src/m1/a.ts', content: 'forged' }], omitted: [] }, bearer(b.token))).status).toBe(404);
    await post(h.app, '/v1/runners/files/answer', { requestId: req.requestId, files: [{ path: 'src/m1/a.ts', content: 'a' }], omitted: [] }, bearer(a.token));
    expect((await read).body.files).toEqual([{ path: 'src/m1/a.ts', content: 'a' }]);
  });

  it('a runner with no copy of the project says so, in the words the browser shows', async () => {
    const { token } = await enrolRunner(h.app);
    await post(h.app, '/v1/runners/claim', { harnesses: TEST_RUNNER_REPORT, projects: [PROJECT] }, bearer(token));
    const read = post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files/list`, {});
    const req = await takeOne(token);
    await post(h.app, '/v1/runners/files/answer', { requestId: req.requestId, files: [], omitted: [], noCheckout: true }, bearer(token));
    const res = await read;
    expect([res.status, res.body.error.code, res.body.error.message]).toEqual([409, 'no_checkout', 'This runner has no copy of the project; the proposal can only add new files']);
  });

  it('caps the reads waiting per owner', async () => {
    await h.app.close();
    h = makeHarness(t, { codingWorkers: 'off' }, undefined, { fileRelay: new FileRelay(400, 2) });
    const waiting = [post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files/list`, {}), post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files/list`, {})];
    await vi.waitFor(async () => {
      const third = await post(h.app, `/v1/projects/${PROJECT}/tasks/t1/files/list`, {});
      expect([third.status, third.body.error.code]).toEqual([429, 'too_many_file_requests']);
    }, { timeout: 300, interval: 20 });
    await Promise.all(waiting);
  });
});
