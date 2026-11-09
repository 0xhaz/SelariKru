/** Case: preserve history on cancel. Every row the run wrote before the cancel is compared after it: the record may grow, and nothing already written may change meaning or disappear. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { World, sql, type FakeStream } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const allEvents = () => w.t.db.execute(sql`SELECT event_id, sequence, type, task_id, attempt_id, actor_kind, payload FROM events ORDER BY sequence`);
const history = async () => ({
  events: await allEvents(),
  attempts: await w.t.db.execute(sql`SELECT attempt_id, attempt_number, runner, revision, base_sha, outcome, exit_reason, started_at, ended_at, detail FROM attempts ORDER BY attempt_number`),
  revisions: await w.t.db.execute(sql`SELECT task_id, revision, spec FROM task_revisions ORDER BY task_id, revision`),
  usage: await w.t.db.execute(sql`SELECT * FROM usage_entries ORDER BY recorded_at, entry_id`),
  reservations: await w.t.db.execute(sql`SELECT reservation_id FROM budget_reservations ORDER BY reservation_id`),
});
const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 1, duration_ms: 1, total_cost_usd: 0.01, terminal_reason: 'x', usage: { input_tokens: 3, output_tokens: 4 } });

function expectPreserved(before: Awaited<ReturnType<typeof history>>, after: Awaited<ReturnType<typeof history>>): void {
  // Every earlier event is exactly as it was, and all new ones come after it.
  expect(after.events.slice(0, before.events.length)).toEqual(before.events);
  expect(new Set(after.events.map((e) => e['event_id'])).size).toBe(after.events.length);
  for (const b of before.attempts) {
    const a = after.attempts.find((x) => x['attempt_id'] === b['attempt_id']);
    expect(a, `attempt ${String(b['attempt_id'])}`).toBeDefined();
    expect(a).toMatchObject({ attempt_number: b['attempt_number'], runner: b['runner'], revision: b['revision'], base_sha: b['base_sha'], started_at: b['started_at'] });
    if (b['ended_at'] !== null) expect(a).toEqual(b);
  }
  expect(after.revisions).toEqual(before.revisions);
  expect(after.usage.length).toBeGreaterThanOrEqual(before.usage.length);
  for (const u of before.usage) expect(after.usage).toContainEqual(u);
  expect(after.reservations.map((r) => r['reservation_id'])).toEqual(expect.arrayContaining(before.reservations.map((r) => r['reservation_id'])));
}

describe('cancelling work keeps its history', () => {
  it('a running attempt cancelled through the real stop path: earlier attempts, events, spec and usage all survive, and the snapshot still shows them', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_keep', { maxAttempts: 3 })]);

    const first = await w.claim();
    const failedRun = await w.runWorker(first, ({ stream }) => { stream.push(`${failed}\n`); stream.end(1); return false; });
    expect(failedRun.report.outcome).toBe('failed');
    expect((await w.status('t_keep')).status).toBe('ready');

    const second = await w.claim();
    expect(second.attemptNumber).toBe(2);
    let onStart: () => void;
    const started = new Promise<void>((res) => { onStart = res; });
    let stream!: FakeStream;
    const running = w.runWorker(second, ({ stream: s, write }) => { stream = s; write('src/half.ts', 'export const half = 1;\n'); onStart(); return false; });
    await started;

    const before = await history();
    const { rowRevision } = await w.status('t_keep');
    const cancelled = await w.command('t_keep', rowRevision, 'c1');
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.state).toBe('cancel_requested');

    const { report } = await running;
    expect(report.outcome).toBe('failed');
    expect(report.reason).toContain('cancelled');
    expect(stream.isEnded).toBe(true);
    expect((await w.status('t_keep')).status).toBe('cancelled');

    expectPreserved(before, await history());
    const after = await allEvents();
    expect(after.map((e) => e['type'])).toEqual(expect.arrayContaining(['task.cancel_requested', 'task.cancelled']));

    const snap = await w.snapshot();
    const task = snap.tasks.find((x: { taskId: string }) => x.taskId === 't_keep');
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts[0]).toMatchObject({ attemptId: first.attemptId, outcome: 'failed' });
    expect(task.attempts[1]).toMatchObject({ attemptId: second.attemptId });
    expect(task.attempts[1].endedAt).not.toBeNull();
    expect(await w.lifecycle(runId)).not.toBe('merged');
  });

  it('cancelling verifying work keeps the attempt, its stored change set and its events, and the change stays out of any new candidate', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_v')]);
    const report = await w.claimAndComplete('t_v');
    const manifest = report.changeManifest!;
    const before = await history();

    const { rowRevision } = await w.status('t_v');
    const res = await w.command('t_v', rowRevision, 'c2');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'applied', taskStatus: 'cancelled' });

    expectPreserved(before, await history());
    expect(await w.store().get(manifest)).not.toBeNull();
    expect((await w.assembly().tick()).assembled).toEqual([]);
    expect(await w.count('candidates')).toBe(0);
  });

  it('a retried or replayed cancel does not rewrite history', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_r')]);
    const { rowRevision } = await w.status('t_r');
    const first = await w.command('t_r', rowRevision, 'dup');
    expect(first.status).toBe(202);
    const before = await history();
    expect((await w.command('t_r', rowRevision, 'dup')).body).toEqual(first.body);
    expectPreserved(before, await history());
    expect(await w.count('events', `type = 'task.cancelled'`)).toBe(1);
  });
});
