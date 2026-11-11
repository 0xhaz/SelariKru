import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APPLY_HARNESS_REPORT, APPLY_MODEL, APPLY_PROVIDER, sha256Hex, type AcceptedProposal } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import { acceptProposal, appliedProposalFor, createScheduler, fetchProposalForLease, type Scheduler } from './index.ts';
import { CAPS, POLICY, TEST_CATALOG, countRows, eventTypes, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb } from '../test/helpers.ts';

let t: TestDb;
let clock: TestClock;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
});

const BASE = 'c'.repeat(40);
const CONTENT = 'export const x = 1;\n';
const proposal = (over: Partial<AcceptedProposal> = {}): AcceptedProposal => ({
  proposalId: 'req_1', taskId: 't1', taskRevision: 1, baseSha: BASE, routeRecordId: 'rr_1',
  diff: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n',
  results: [{ path: 'src/new.ts', sha256: sha256Hex(CONTENT), content: CONTENT }],
  ...over,
});
const spec = () => specFor('t1', { baseSha: BASE, allowedPaths: ['src'] });
const sched = (codingWorkers?: 'off' | 'claude_code'): Scheduler => createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG, ...(codingWorkers ? { codingWorkers } : {}) });
const ctx = () => ({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG });
const key = { tenantId: 'tenant_a', projectId: 'proj_a', taskId: 't1' };
const applyRunner = (id: string) => ({ ...runner(id), harnesses: [...(runner(id).harnesses ?? []), APPLY_HARNESS_REPORT] });

describe('accepting a patch proposal', () => {
  it('records the proposal and an owner event with ids and hashes only', async () => {
    await seedTask(t.db, spec());
    const r = await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'owner_1' });
    expect(r).toMatchObject({ ok: true, value: { proposalId: 'req_1', state: 'accepted', fileCount: 1 } });
    expect(await eventTypes(t.db)).toEqual(['proposal.accepted']);
    const [ev] = await t.db.execute(sql`SELECT payload::text AS p, actor_kind AS a FROM events`);
    expect(String(ev!['p'])).not.toContain(CONTENT.trim());
    expect(String(ev!['a'])).toContain('human');
  });

  it('re-checks the proposal against the stored task: a mismatched base, a stale revision and an outside path are refused', async () => {
    await seedTask(t.db, spec());
    expect(await acceptProposal(ctx(), key, { proposal: proposal({ baseSha: 'd'.repeat(40) }), acceptedBy: 'o' })).toMatchObject({ ok: false, error: { reason: 'base_mismatch' } });
    expect(await acceptProposal(ctx(), key, { proposal: proposal({ taskRevision: 2 }), acceptedBy: 'o' })).toMatchObject({ ok: false, error: { reason: 'stale_revision' } });
    const outside = proposal({ diff: '--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1 @@\n+x\n', results: [{ path: 'docs/x.md', sha256: sha256Hex('x\n'), content: 'x\n' }] });
    expect(await acceptProposal(ctx(), key, { proposal: outside, acceptedBy: 'o' })).toMatchObject({ ok: false, error: { reason: 'path_outside_allowed' } });
    expect(await countRows(t.db, 'accepted_proposals')).toBe(0);
    expect(await eventTypes(t.db)).toEqual([]);
  });

  it('refuses a task that is not waiting to start', async () => {
    await seedTask(t.db, spec(), 'verified');
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o' })).toMatchObject({ ok: false, error: { reason: 'task_not_applicable' } });
  });

  it('a later accept replaces one still waiting', async () => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o' });
    await acceptProposal(ctx(), key, { proposal: proposal({ proposalId: 'req_2' }), acceptedBy: 'o' });
    const rows = await t.db.execute(sql`SELECT proposal_id, state FROM accepted_proposals ORDER BY proposal_id`);
    expect(rows.map((r) => [r['proposal_id'], r['state']])).toEqual([['req_1', 'superseded'], ['req_2', 'accepted']]);
  });
});

describe('claiming an apply attempt', () => {
  it('with coding workers off, a ready task with no accepted proposal waits, visibly, and no model worker is assigned', async () => {
    await seedTask(t.db, spec());
    const out = await sched('off').tryClaim(runner('r1'), CAPS);
    expect(out).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'awaiting_accepted_proposal' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
  });

  it('an accepted proposal is claimed by the apply worker: no model, route none, the proposal named on the lease', async () => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o' });
    const out = await sched('off').tryClaim(applyRunner('r1'), CAPS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lease.assignment).toEqual({ provider: APPLY_PROVIDER, model: APPLY_MODEL, source: 'proposal', route: 'none' });
    expect(out.lease.proposal).toMatchObject({ proposalId: 'req_1', baseSha: BASE, fileCount: 1 });
    expect(out.lease.skills).toEqual([]);
    const [row] = await t.db.execute(sql`SELECT state, attempt_id FROM accepted_proposals`);
    expect(row).toMatchObject({ state: 'applying', attempt_id: out.lease.attemptId });
    expect((await statusOf(t.db, 't1')).status).toBe('running');
    // The runner fetches it with its lease.
    const fetched = await fetchProposalForLease(ctx(), out.lease);
    expect(fetched).toMatchObject({ ok: true, value: { proposalId: 'req_1', results: [{ path: 'src/new.ts', content: CONTENT }] } });
    expect(await appliedProposalFor(t.db, key, 1)).toMatchObject({ proposalId: 'req_1', diff: proposal().diff });
  });

  it('a runner that cannot apply proposals is not given one, and nothing is recorded about the task', async () => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o' });
    const out = await sched('off').tryClaim(runner('r1'), CAPS);
    expect(out).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'apply_runner_update_required' }] });
    expect(await eventTypes(t.db)).toEqual(['proposal.accepted']);
  });

  it('with Claude Code workers on, a task with no proposal still goes to its assigned model', async () => {
    await seedTask(t.db, spec());
    const out = await sched('claude_code').tryClaim(runner('r1'), CAPS);
    expect(out.ok && out.lease.assignment?.provider).toBe('anthropic');
  });
});
