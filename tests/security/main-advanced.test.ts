/**
 * Architecture section 6 rule 8: if main advances, rebuild the candidate and rerun affected gates. Real assembly and verification drivers against real git commits on the source repository's main.
 * An open pull request does not stop it: the old one is left for a person to close, and the screens say it is out of date.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRun } from '@selarikru/integrations-github';
import { failingOn, passing, post, PROJECT, sql, TENANT, World } from './world.ts';
import { loadValidRecord } from '../../services/verifier/src/service.ts';
import { toViewSnapshot } from '../../packages/data-source-live/src/snapshot.ts';
import { buildDecisions } from '../../apps/control-web/src/features/decisions/model.ts';
import { buildEvidence } from '../../apps/control-web/src/features/evidence/model.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const valid = (sha: string) => loadValidRecord(w.t.db, w.store(), { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: w.trusted() });
const pr = (runId: string) => post(w.app, `/v1/runs/${runId}/pull-request`, {});
const live = () => w.t.db.execute(sql`SELECT sha, base_sha, detail FROM candidates WHERE status = 'assembled' AND sha IS NOT NULL`);
const attempts = () => w.t.db.execute(sql`SELECT attempt_id, attempt_number FROM attempts ORDER BY attempt_number`);
let landings = 0;
const landOnMain = () => w.gitCommit('src/landed.ts', `export const landed = ${++landings};\n`);
/** What a person actually reads: the live snapshot through the real conversion, into the real Decisions and Evidence models. */
async function views(runId: string) {
  const snapshot = toViewSnapshot(await w.snapshot());
  const card = buildDecisions(snapshot, Date.now(), { mode: 'live', connection: 'live' }).cards.find((c) => c.id === `review:${runId}`)!;
  const report = buildEvidence(snapshot, runId)!;
  return { card, merged: report.states.find((x) => x.key === 'merged')! };
}

describe('main moves past a run that has no open pull request', () => {
  it('at ready_for_review: rebuilt on the new tip, re-verified with no worker redone, one live candidate throughout', async () => {
    const { runId, sha: old } = await w.verifiedRun(['t_a']);
    const before = await attempts();
    const tip = landOnMain();

    const tick = await w.assembly().tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    const fresh = tick.assembled[0]!;
    expect(fresh).not.toBe(old);
    expect(await live()).toMatchObject([{ sha: fresh, base_sha: tip }]);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_a')).status).toBe('verifying');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await attempts()).toEqual(before);
    expect((await pr(runId)).body.error.details.reason).toBe('run_not_ready');

    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await attempts()).toEqual(before);
    const opened = await pr(runId);
    expect(opened.status).toBe(200);
    expect(opened.body.candidateSha).toBe(fresh);

    // The next pass finds it current and does nothing.
    const eventsNow = await w.count('events');
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect(await w.count('events')).toBe(eventsNow);
  });

  it('a failed verdict on the rebuild blocks the task and starts no worker', async () => {
    const { runId } = await w.verifiedRun(['t_f']);
    const before = await attempts();
    landOnMain();
    await w.assembly().tick();
    await w.verification(failingOn(['FB-01'])).tick();
    expect((await w.status('t_f')).status).toBe('blocked');
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('reverification_failed');
    expect((await w.api().claim()).lease).toBeNull();
    expect(await attempts()).toEqual(before);
    expect(await w.lifecycle(runId)).toBe('running');
  });

  it('a rebuild that conflicts goes to a targeted resolution proposal, once, and leaves no live candidate', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_c')]);
    await w.claimAndComplete('t_c');
    const old = (await w.assembly().tick()).assembled[0]!;
    await w.verification(passing).tick();
    expect(await valid(old)).not.toBeNull();
    w.gitCommit('src/t_c.ts', 'export const v = "main wrote this";\n');

    const tick = await w.assembly().tick();
    expect(tick.assembled).toEqual([]);
    expect(tick.failed).toEqual([{ runId, reason: 'conflict' }]);
    expect(await live()).toHaveLength(0);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_c')).status).toBe('verifying');
    const proposals = await w.t.db.execute(sql`SELECT status, source FROM plan_proposals`);
    expect(proposals).toMatchObject([{ status: 'proposed', source: 'integration' }]);

    for (let i = 0; i < 3; i++) await w.assembly().tick();
    expect(await w.count('events', `type = 'candidate.failed'`)).toBe(1);
    expect(await w.count('plan_proposals')).toBe(1);
    expect(await w.count('candidates', `status = 'conflicted'`)).toBe(1);
  });
});

describe('main moves past a run with an open pull request', () => {
  it('rebuilds and re-verifies with no worker, says the pull request is out of date, refuses a new one by name, and opens one after the old closes', async () => {
    const { runId, sha: old } = await w.verifiedRun(['t_o'], () => ({ requirementIds: ['FB-01'] }));
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    const before = await attempts();
    const callsBefore = [...w.gh.calls];
    const tip = landOnMain();

    const tick = await w.assembly().tick();
    expect(tick.failed).toEqual([]);
    expect(tick.assembled).toHaveLength(1);
    const fresh = tick.assembled[0]!;
    expect(fresh).not.toBe(old);
    expect(await live()).toMatchObject([{ sha: fresh, base_sha: tip }]);
    expect(await valid(old)).toBeNull();
    expect((await w.status('t_o')).status).toBe('verifying');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await attempts()).toEqual(before);

    // As soon as the rebuild has started, before any verdict.
    const during = await views(runId);
    expect(during.card).toMatchObject({ kind: 'reconciliation', chip: 'Pull request out of date' });
    expect(during.card.title).toBe(`Pull request #${number} no longer holds the verified code`);
    expect(during.card.summary).toContain('The rebuilt code has not passed verification yet.');
    expect(during.card.note).toContain('open the new one once verification passes');
    expect(during.merged).toMatchObject({ value: 'Pull request out of date', tone: 'warning' });

    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await attempts()).toEqual(before);

    // Back in review, the old pull request still must not read as ready.
    const after = await views(runId);
    expect(after.card).toMatchObject({ kind: 'reconciliation', chip: 'Pull request out of date' });
    expect(after.card.summary).toContain('The rebuilt code has passed verification.');
    expect(after.card.title).not.toMatch(/ready for your review/i);
    expect(after.merged.detail).toContain(`Pull request #${number} no longer holds the verified code`);

    const refused = await pr(runId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ reason: 'candidate_changed', prNumber: number });
    expect(w.gh.prs).toHaveLength(1);
    // Nothing closed or touched the old one for the owner.
    expect(w.gh.calls.slice(callsBefore.length).filter((c) => c !== 'findPullRequest' && c !== 'branchHead')).toEqual([]);
    expect(w.gh.prs[0]).toMatchObject({ number, state: 'open' });

    w.gh.humanCloses(number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'closed' });
    const opened = await pr(runId);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ status: 'opened', candidateSha: fresh, adopted: false });
    expect(w.gh.prs).toHaveLength(2);
    expect((await views(runId)).card.chip).not.toBe('Pull request out of date');
  });

  it('a person merging the old pull request is recorded as stale and counts for nothing', async () => {
    const { runId } = await w.verifiedRun(['t_s']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    landOnMain();
    const fresh = (await w.assembly().tick()).assembled[0]!;
    expect((await w.verification(passing).tick()).verified).toBe(fresh);

    w.gh.humanMerges(number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'stale' });
    expect(await w.count('change_requests', `status = 'stale_candidate'`)).toBe(1);
    expect(await w.count('events', `type = 'change.merged'`)).toBe(0);
    expect((await w.status('t_s')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
  });

  it('a pull request main has not left behind is not called out of date', async () => {
    const { runId } = await w.verifiedRun(['t_k']);
    expect((await pr(runId)).status).toBe(200);
    expect((await w.assembly().tick()).assembled).toEqual([]);
    const { card, merged } = await views(runId);
    expect(card).toMatchObject({ kind: 'merge_review', chip: 'Merge readiness' });
    expect(merged.value).toBe('Awaiting a human merge');
  });
});

describe('what never moves', () => {
  it('a merged run is not rebuilt, whatever main does', async () => {
    const { runId, sha } = await w.verifiedRun(['t_m']);
    expect((await pr(runId)).status).toBe(200);
    w.gh.humanMerges(w.gh.prs[0]!.number);
    expect(await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).toEqual({ status: 'merged' });
    const events = await w.count('events');
    landOnMain();
    for (let i = 0; i < 2; i++) expect((await w.assembly().tick()).assembled).toEqual([]);
    expect(await w.lifecycle(runId)).toBe('merged');
    expect((await w.status('t_m')).status).toBe('merged');
    expect(await w.count('events')).toBe(events);
    expect(await w.count('candidates', `sha <> '${sha}'`)).toBe(0);
  });

  it('a merge a person made of something else stops the driver: only they can say what it means', async () => {
    const { runId } = await w.verifiedRun(['t_x']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    w.gh.humanPushes(number, 'f'.repeat(40));
    w.gh.humanMerges(number);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now })).status).toBe('sha_mismatch');
    landOnMain();
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect((await w.status('t_x')).status).toBe('verified');
  });

  it('a tip that cannot be read leaves everything alone and records nothing', async () => {
    const { runId, sha } = await w.verifiedRun(['t_u']);
    const events = await w.count('events');
    const candidatesBefore = await w.t.db.execute(sql`SELECT candidate_id, status, detail FROM candidates ORDER BY candidate_id`);
    w.git('update-ref', '-d', 'refs/heads/main');
    try {
      for (let i = 0; i < 3; i++) expect(await w.assembly().tick()).toEqual({ assembled: [], failed: [] });
      expect(await w.t.db.execute(sql`SELECT candidate_id, status, detail FROM candidates ORDER BY candidate_id`)).toEqual(candidatesBefore);
      expect(await w.count('events')).toBe(events);
      expect((await w.status('t_u')).status).toBe('verified');
      expect(await w.lifecycle(runId)).toBe('ready_for_review');
      expect(await valid(sha)).not.toBeNull();
    } finally {
      w.git('update-ref', 'refs/heads/main', w.baseSha);
    }
  });
});
