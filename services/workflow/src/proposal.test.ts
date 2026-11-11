import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APPLY_HARNESS_REPORT, APPLY_MODEL, APPLY_PROVIDER, sha256Hex, type AcceptedProposal } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import { withTx } from '@selarikru/persistence';
import { acceptProposal, appliedProposalFor, applyVerification, createScheduler, fetchProposalForLease, proposalStateFor, type Scheduler } from './index.ts';
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
const sched = (codingWorkers?: 'off' | 'claude_code'): Scheduler => createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG, codingWorkers: codingWorkers ?? 'claude_code' });
const ctx = () => ({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG, codingWorkers: 'off' as const });
const key = { tenantId: 'tenant_a', projectId: 'proj_a', taskId: 't1' };
const applyRunner = (id: string) => ({ ...runner(id), harnesses: [...(runner(id).harnesses ?? []), APPLY_HARNESS_REPORT] });

describe('accepting a patch proposal', () => {
  it('records the proposal and an owner event with ids and hashes only', async () => {
    await seedTask(t.db, spec());
    const r = await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'owner_1', idempotencyKey: 'k' });
    expect(r).toMatchObject({ ok: true, value: { proposalId: 'req_1', state: 'accepted', fileCount: 1 } });
    expect(await eventTypes(t.db)).toEqual(['proposal.accepted']);
    const [ev] = await t.db.execute(sql`SELECT payload::text AS p, actor_kind AS a FROM events`);
    expect(String(ev!['p'])).not.toContain(CONTENT.trim());
    expect(String(ev!['a'])).toContain('human');
  });

  it('re-checks the proposal against the stored task: a mismatched base, a stale revision and an outside path are refused', async () => {
    await seedTask(t.db, spec());
    expect(await acceptProposal(ctx(), key, { proposal: proposal({ baseSha: 'd'.repeat(40) }), acceptedBy: 'o', idempotencyKey: 'k' })).toMatchObject({ ok: false, error: { reason: 'base_mismatch' } });
    expect(await acceptProposal(ctx(), key, { proposal: proposal({ taskRevision: 2 }), acceptedBy: 'o', idempotencyKey: 'k' })).toMatchObject({ ok: false, error: { reason: 'stale_revision' } });
    const outside = proposal({ diff: '--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1 @@\n+x\n', results: [{ path: 'docs/x.md', sha256: sha256Hex('x\n'), content: 'x\n' }] });
    expect(await acceptProposal(ctx(), key, { proposal: outside, acceptedBy: 'o', idempotencyKey: 'k' })).toMatchObject({ ok: false, error: { reason: 'path_outside_allowed' } });
    expect(await countRows(t.db, 'accepted_proposals')).toBe(0);
    expect(await eventTypes(t.db)).toEqual([]);
  });

  it('refuses a task that is not waiting to start', async () => {
    await seedTask(t.db, spec(), 'verified');
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k' })).toMatchObject({ ok: false, error: { reason: 'task_not_applicable' } });
  });

  it('a later accept replaces one still waiting', async () => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k' });
    await acceptProposal(ctx(), key, { proposal: proposal({ proposalId: 'req_2' }), acceptedBy: 'o', idempotencyKey: 'k' });
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
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k' });
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
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k' });
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

describe('fix round 1: an apply that does not stand, re-accepting, and the hold', () => {
  const claimApply = async (s: Scheduler) => {
    const out = await s.tryClaim(applyRunner('r1'), CAPS);
    if (!out.ok) throw new Error(`no claim: ${out.reason} ${JSON.stringify(out.skipped)}`);
    return out.lease;
  };
  const row = async () => (await t.db.execute(sql`SELECT state, failure_reason, round, attempt_id FROM accepted_proposals WHERE proposal_id = 'req_1'`))[0]!;

  it('a failed apply moves the proposal to failed with its reason; the same key reads that state, a new key queues it again, and the next claim applies it', async () => {
    await seedTask(t.db, spec());
    const s = sched('off');
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' })).toMatchObject({ ok: true, value: { state: 'accepted', round: 1 } });
    const lease = await claimApply(s);
    expect((await s.publishResult(lease, { outcome: 'failed', reason: 'tests_failed: pnpm run test exited with code 1' })).ok).toBe(true);
    expect(await row()).toMatchObject({ state: 'failed', failure_reason: 'tests_failed: pnpm run test exited with code 1' });
    const before = (await eventTypes(t.db)).length;
    // The same key never replays the old receipt: it reads the proposal as it is now.
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' })).toMatchObject({ ok: true, value: { state: 'failed', lastFailure: 'tests_failed: pnpm run test exited with code 1', round: 1 } });
    expect((await eventTypes(t.db)).length).toBe(before);
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k2' })).toMatchObject({ ok: true, value: { state: 'accepted', round: 2, lastFailure: null } });
    const second = await claimApply(s);
    expect(second.attemptId).not.toBe(lease.attemptId);
    expect(await row()).toMatchObject({ state: 'applying', attempt_id: second.attemptId, round: 2 });
  });

  it('a waiting or applying proposal is not queued twice', async () => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k2' })).toMatchObject({ ok: false, error: { reason: 'proposal_already_accepted', state: 'accepted' } });
  });

  it('a completed apply marks the proposal applied', async () => {
    await seedTask(t.db, spec());
    const s = sched('off');
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    const lease = await claimApply(s);
    await s.publishResult(lease, { outcome: 'completed', changeManifestSha256: 'a'.repeat(64) });
    expect(await row()).toMatchObject({ state: 'applied' });
  });

  it('an input error blocks the task with its reason and uses no repair; accepting a new proposal makes it ready and applies it', async () => {
    await seedTask(t.db, spec());
    const s = sched('off');
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    const lease = await claimApply(s);
    await s.publishResult(lease, { outcome: 'blocked', reason: 'proposal_base_mismatch: the diff applied to the base files does not give the accepted results' });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    expect(await row()).toMatchObject({ state: 'failed' });
    expect(await acceptProposal(ctx(), key, { proposal: proposal({ proposalId: 'req_2' }), acceptedBy: 'o', idempotencyKey: 'k3' })).toMatchObject({ ok: true, value: { state: 'accepted' } });
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    expect((await claimApply(s)).proposal?.proposalId).toBe('req_2');
  });

  it('a blocked task whose block is not an apply input error takes no proposal', async () => {
    await seedTask(t.db, spec(), 'blocked');
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' })).toMatchObject({ ok: false, error: { reason: 'task_not_applicable' } });
  });

  it('a no-model apply holds no model budget', async () => {
    await seedTask(t.db, specFor('t1', { baseSha: BASE, allowedPaths: ['src'], maxCostUsd: 5 }));
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    const lease = await claimApply(sched('off'));
    const [r] = await t.db.execute(sql`SELECT amount_usd::float AS amount FROM budget_reservations WHERE detail ->> 'attemptId' = ${lease.attemptId}`);
    expect(Number(r!['amount'])).toBe(0);
  });

  it('with Claude Code on, a task whose last apply failed does not fall through to a model worker: it says why and waits for the owner', async () => {
    await seedTask(t.db, spec());
    const s = sched('claude_code');
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    const lease = await claimApply(s);
    await s.publishResult(lease, { outcome: 'failed', reason: 'build_failed: pnpm run build exited with code 2' });
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    const out = await s.tryClaim(applyRunner('r1'), CAPS);
    expect(out).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'last_apply_failed' }] });
  });
});

describe('fix round 2: an applied change that did not verify (m5)', () => {
  const claimApply = async (s: Scheduler) => {
    const out = await s.tryClaim(applyRunner('r1'), CAPS);
    if (!out.ok) throw new Error(`no claim: ${out.reason} ${JSON.stringify(out.skipped)}`);
    return out.lease;
  };
  const appliedThenFailedVerification = async (s: Scheduler) => {
    await seedTask(t.db, spec());
    await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k1' });
    const lease = await claimApply(s);
    await s.publishResult(lease, { outcome: 'completed', changeManifestSha256: 'a'.repeat(64) });
    const v = await applyVerification({ db: t.db, now: clock.now }, key, { actor: { kind: 'verifier', id: 'v1' }, outcome: 'failed', detail: { failedChecks: ['FB-1'] }, expect: { revision: 1, attemptId: lease.attemptId } });
    expect(v.taskStatus).toBe('ready');
  };

  it('with Claude Code on, the next claim does not go to a model worker: it waits, saying the last apply did not verify', async () => {
    const s = sched('claude_code');
    await appliedThenFailedVerification(s);
    expect(await s.tryClaim(applyRunner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'last_apply_unverified' }] });
  });

  it('the applied proposal reads as failed verification and can be accepted again, as the next round', async () => {
    const s = sched('off');
    await appliedThenFailedVerification(s);
    expect(await proposalStateFor(t.db, key, 1)).toMatchObject({ proposalId: 'req_1', state: 'failed', lastFailure: 'verification_failed', round: 1 });
    expect(await acceptProposal(ctx(), key, { proposal: proposal(), acceptedBy: 'o', idempotencyKey: 'k2' })).toMatchObject({ ok: true, value: { state: 'accepted', round: 2 } });
    expect((await claimApply(s)).proposal?.proposalId).toBe('req_1');
  });
});

describe('fix round 2: one project read judges every task as the claim does (m3)', () => {
  it('the preloaded reader gives the same labels as the claim\'s per-query walk, restricted predecessors included', async () => {
    const { projectSourceReader, resolveSources, resolveSourcesWith } = await import('./index.ts');
    await seedTask(t.db, specFor('a', { classification: 'restricted' }), 'verified');
    await seedTask(t.db, specFor('b', { dependencies: [{ taskId: 'a', revision: 1, condition: 'artifact_verified' }] }), 'verified');
    await seedTask(t.db, specFor('c', { dependencies: [{ taskId: 'b', revision: 1, condition: 'artifact_verified' }] }));
    await seedTask(t.db, specFor('d'));
    const read = await projectSourceReader(t.db, { tenantId: 'tenant_a', projectId: 'proj_a' });
    for (const id of ['a', 'b', 'c', 'd']) {
      const spec = specFor(id, id === 'a' ? { classification: 'restricted' } : id === 'b' ? { dependencies: [{ taskId: 'a', revision: 1, condition: 'artifact_verified' }] } : id === 'c' ? { dependencies: [{ taskId: 'b', revision: 1, condition: 'artifact_verified' }] } : {});
      const viaClaim = await withTx(t.db, (tx) => resolveSources(tx, { tenantId: 'tenant_a', projectId: 'proj_a', taskId: id }, spec));
      expect(await resolveSourcesWith(read, spec), id).toEqual(viaClaim);
    }
    expect((await resolveSourcesWith(read, specFor('c', { dependencies: [{ taskId: 'b', revision: 1, condition: 'artifact_verified' }] }))).routeClassification).toBe('restricted');
  });
});
