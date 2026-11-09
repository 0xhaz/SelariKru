/** Case: recover after a controller restart with no duplicate pull request. The restart is a real one: app, scheduler, pool and every in-memory structure are replaced; only Postgres, the artifact store, the fake GitHub and the runner survive. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { World, post, resultLine, sql, type FakeStream } from '../security/world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const pr = (runId: string) => post(w.app, `/v1/runs/${runId}/pull-request`, {});
const proposed = () => w.count('events', `type = 'change.proposed'`);

describe('controller restart and the pull request', () => {
  it('the create succeeded on GitHub but the response was lost and the controller died: the new controller adopts that PR and opens no second one', async () => {
    const { runId, sha } = await w.verifiedRun(['t_a']);

    w.gh.loseNextCreateResponse = true;
    const crashed = await pr(runId);
    expect(crashed.status).toBe(500);
    expect(w.gh.prs).toHaveLength(1);
    // The response was lost mid-transaction, so nothing of it was recorded. Only GitHub knows.
    expect(await w.count('change_requests')).toBe(0);
    expect(await proposed()).toBe(0);

    await w.restartController();
    const retried = await pr(runId);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'opened', number: w.gh.prs[0]!.number, candidateSha: sha, adopted: true });

    expect(w.gh.prs).toHaveLength(1);
    expect(w.gh.calls.filter((c) => c === 'createDraftPullRequest')).toHaveLength(1);
    expect(new Set(w.gh.pushes.map((p) => p.sha))).toEqual(new Set([sha]));
    expect(await w.count('change_requests')).toBe(1);
    expect(await proposed()).toBe(1);
  });

  it('after a finished open, a restart replays the receipt and does not touch GitHub', async () => {
    const { runId } = await w.verifiedRun(['t_a']);
    const first = await pr(runId);
    expect(first.status).toBe(200);
    expect(first.body.adopted).toBe(false);
    const callsBefore = [...w.gh.calls];

    await w.restartController();
    const again = await pr(runId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(w.gh.calls).toEqual(callsBefore);
    expect(w.gh.prs).toHaveLength(1);
    expect(await proposed()).toBe(1);
  });

  it('two controllers racing the same open produce one pull request', async () => {
    const { runId } = await w.verifiedRun(['t_a']);
    const other = await w.secondController();
    const results = await Promise.all([pr(runId), post(other, `/v1/runs/${runId}/pull-request`, {})]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(w.gh.prs).toHaveLength(1);
    expect(w.gh.calls.filter((c) => c === 'createDraftPullRequest')).toHaveLength(1);
    expect(await proposed()).toBe(1);
  });

  it('a stranger’s PR on the same branch name is not adopted across a restart', async () => {
    const { runId, sha } = await w.verifiedRun(['t_a']);
    w.gh.foreignPr({ headRef: `selarikru/${runId}/${sha.slice(0, 12)}`, headSha: 'e'.repeat(40) });
    await w.restartController();
    const res = await pr(runId);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('foreign_pr');
    expect(w.gh.calls).not.toContain('createDraftPullRequest');
  });

  it('a worker running across the restart keeps its one attempt: no duplicate launch, and its result lands on the new controller', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_live')]);
    const lease = await w.claim();

    let stream!: FakeStream;
    let onStart: () => void;
    const ready = new Promise<void>((res) => { onStart = res; });
    const running = w.runWorker(lease, ({ stream: s, write }) => { stream = s; write('src/live.ts', 'export const live = 1;\n'); onStart(); return false; }, { heartbeatMs: 500 });
    await ready;

    await w.restartController();
    expect((await w.api().claim()).lease).toBeNull();
    expect(await w.count('attempts')).toBe(1);

    stream.push(`${resultLine}\n`);
    stream.end(0);
    const { report } = await running;
    expect(report.outcome).toBe('completed');
    expect((await w.status('t_live')).status).toBe('verifying');
    expect(await w.count('attempts')).toBe(1);
    const [attempt] = await w.t.db.execute(sql`SELECT lease_fence FROM attempts`);
    expect(Number(attempt!['lease_fence'])).toBe(1);
  });
});

