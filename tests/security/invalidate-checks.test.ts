/** Case: invalidate checks after a contract or candidate change. Real assembly and verification drivers against real git commits in the source repository. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRun } from '@selarikru/integrations-github';
import { passing, post, PROJECT, sha256, sql, TENANT, World } from './world.ts';
import { loadValidRecord } from '../../services/verifier/src/service.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const valid = (sha: string) => loadValidRecord(w.t.db, w.store(), { tenantId: TENANT, projectId: PROJECT, sha }, { trusted: w.trusted() });
const liveChecks = (sha: string) => w.count('check_runs', `candidate_sha = '${sha}' AND result <> 'invalidated'`);
const pr = (runId: string) => post(w.app, `/v1/runs/${runId}/pull-request`, {});

describe('candidate change', () => {
  it('a new candidate supersedes the verified one: every check on the old commit is retired and the earlier task must be verified again', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_1'), w.task(runId, 't_2', { dependencies: [{ taskId: 't_1', revision: 1, condition: 'artifact_verified' }] })]);
    await w.claimAndComplete('t_1');
    const first = await w.assembly().tick();
    expect(first.assembled).toHaveLength(1);
    const old = first.assembled[0]!;
    expect((await w.verification(passing).tick()).verified).toBe(old);
    expect((await w.status('t_1')).status).toBe('verified');
    expect(await valid(old)).not.toBeNull();
    expect(await liveChecks(old)).toBeGreaterThan(0);

    await w.claimAndComplete('t_2');
    const rebuilt = await w.assembly().tick();
    expect(rebuilt.failed).toEqual([]);
    expect(rebuilt.assembled).toHaveLength(1);
    const fresh = rebuilt.assembled[0]!;
    expect(fresh).not.toBe(old);

    expect(await valid(old)).toBeNull();
    expect(await liveChecks(old)).toBe(0);
    expect((await w.status('t_1')).status).toBe('verifying');
    expect(await w.lifecycle(runId)).toBe('running');
    expect((await pr(runId)).status).toBe(409);
    expect(w.gh.prs).toHaveLength(0);

    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    const opened = await pr(runId);
    expect(opened.status).toBe(200);
    expect(opened.body.candidateSha).toBe(fresh);
    expect(w.gh.pushes.map((p) => p.sha)).toEqual([fresh]);
  });

  // BLOCKED(T7.2): a safety failure this suite found and did not fix. `assess` in services/verifier/src/assembly-driver.ts returns idle as soon as every verifying part is in a live candidate,
  // and when nothing is verifying, so a live candidate is never rebuilt when main advances. docs/architecture.md section 6 rule 8 requires it ("If main advances, rebuild the candidate and
  // rerun affected gates"). `assembleCandidate` can already do the rebuild (integrate.test.ts:198); the driver never asks it to. `it.fails` so this turns red the moment the driver is fixed.
  it.fails('BLOCKED(T7.2) the default branch moves after assembly: the candidate must be rebuilt and only the rebuilt commit judged', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_base')]);
    await w.claimAndComplete('t_base');
    const old = (await w.assembly().tick()).assembled[0]!;

    w.gitCommit('src/landed.ts', 'export const landed = 1;\n');
    const rebuilt = await w.assembly().tick();
    expect(rebuilt.assembled).toHaveLength(1);
    const fresh = rebuilt.assembled[0]!;
    expect(fresh).not.toBe(old);
    expect(await w.t.db.execute(sql`SELECT status FROM candidates WHERE sha = ${old}`)).toMatchObject([{ status: 'invalidated' }]);
    expect((await w.verification(passing).tick()).verified).toBe(fresh);
    expect(await valid(old)).toBeNull();
    expect(w.git('ls-tree', '-r', '--name-only', fresh)).toContain('src/landed.ts');
  });

  it('a commit pushed onto the PR after verification means a merge is not recorded as this run’s', async () => {
    const { runId, sha } = await w.verifiedRun(['t_push']);
    expect((await pr(runId)).status).toBe(200);
    const number = w.gh.prs[0]!.number;
    w.gh.humanPushes(number, 'f'.repeat(40));
    w.gh.humanMerges(number);
    const outcome = await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId }, { db: w.t.db, port: w.gh, now: w.now });
    expect(outcome.status).toBe('sha_mismatch');
    expect((await w.status('t_push')).status).toBe('verified');
    expect(await w.lifecycle(runId)).toBe('ready_for_review');
    expect(await w.count('events', `type = 'change.merged'`)).toBe(0);
    expect(sha).toBeTruthy();
  });

  it('a task cancelled while the suite runs: the verdict is born invalid and promotes nothing', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_mid')]);
    await w.claimAndComplete('t_mid');
    const sha = (await w.assembly().tick()).assembled[0]!;

    const mid = async (input: Parameters<typeof passing>[0]) => {
      const row = await w.status('t_mid');
      expect((await w.command('t_mid', row.rowRevision, 'mid-cancel')).status).toBe(202);
      return passing(input);
    };
    await w.verification(mid).tick();

    expect((await w.status('t_mid')).status).toBe('cancelled');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await valid(sha)).toBeNull();
    expect(await w.count('check_runs', `candidate_sha = '${sha}' AND result = 'passed'`)).toBe(0);
    expect((await pr(runId)).status).toBe(409);
  });
});

describe('contract change', () => {
  const contract = async (id: string, text: string) => {
    const hash = sha256(text);
    await w.t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator) VALUES (${TENANT}, ${PROJECT}, ${id}, NULL, 'contract', ${hash}, 'c1', 'internal', '{}'::jsonb)`);
    return { artifactId: id, sha256: hash };
  };

  it('the record names the contract it was judged against; a changed contract cannot be slipped in under valid evidence', async () => {
    const v1 = await contract('art_v1', 'contract one');
    const { runId, sha } = await w.verifiedRun(['t_c'], () => ({ contractRefs: [v1] }));
    const record = (await valid(sha))!;
    expect(record.contractRevisions).toEqual([`art_v1@${v1.sha256}`]);

    const v2 = await contract('art_v2', 'contract two');
    const refused = await w.plan(runId, [w.task(runId, 't_c', { revision: 2, contractRefs: [v2] })], 1);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('task_not_replannable');
    expect((await w.status('t_c')).status).toBe('verified');
    expect((await valid(sha))?.contractRevisions).toEqual([`art_v1@${v1.sha256}`]);
  });

  it('a contract replan when the record no longer stands retires the candidate and its checks for good', async () => {
    const v1 = await contract('art_a', 'first');
    const { runId, sha } = await w.verifiedRun(['t_d'], () => ({ contractRefs: [v1] }));
    const real = w.trusted();
    w.trustOverride = { ...real, verifierSha256: 'f'.repeat(64) };
    expect(await valid(sha)).toBeNull();

    const v2 = await contract('art_b', 'second');
    const replanned = await w.plan(runId, [w.task(runId, 't_d', { revision: 2, contractRefs: [v2] })], 1);
    expect(replanned.status, JSON.stringify(replanned.body)).toBe(201);
    expect((await w.status('t_d')).status).toBe('planned');
    expect(await w.lifecycle(runId)).toBe('running');
    expect(await w.t.db.execute(sql`SELECT status FROM candidates WHERE sha = ${sha}`)).toMatchObject([{ status: 'invalidated' }]);
    expect(await liveChecks(sha)).toBe(0);

    // Even with the old verifier back, the evidence stays dead and nothing can review it.
    w.trustOverride = null;
    expect(await valid(sha)).toBeNull();
    expect((await pr(runId)).status).toBe(409);
    expect(w.gh.calls).toEqual([]);
  });
});
