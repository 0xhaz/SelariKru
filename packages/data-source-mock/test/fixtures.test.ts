import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEventAuthority, newTaskState, transition, type TaskEvent, type TaskState } from '@selarikru/domain';
import {
  ProjectViewEventSchema, ProjectViewSnapshotSchema, approvalStateAt, effectiveWorkerHealth, isEmptyProject, startProjection, usageFor,
  type ProjectViewSnapshot,
} from '@selarikru/view-protocol';
import { EXTRA_FIXTURE_IDS, FIXTURE_IDS, FIXTURE_T0_MS, buildAllFixtures, buildDemoFixtures, buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped, type Fixture, type FixtureId } from '../src/index.ts';

const make = (fixtures?: Fixture[]) => createMockDataSource({ clock: createSeededClock(fixtureTime(0)), ...(fixtures ? { fixtures } : {}) });
const snap = async (id: FixtureId, advanceSec = 0): Promise<{ s: ProjectViewSnapshot; nowMs: number }> => {
  const ds = make();
  if (advanceSec > 0) ds.clock.advance(advanceSec * 1000);
  const f = buildFixture(id);
  return { s: await ds.getSnapshot(f.projectId), nowMs: ds.clockFor(f.projectId).nowMs() };
};
const worker = (s: ProjectViewSnapshot, id: string) => s.workers[id]!;
const settle = () => new Promise((r) => setTimeout(r, 0));
const sc = scoped;
const noTimers = (): (() => void) => () => {};

const ALL_IDS = [...FIXTURE_IDS, ...EXTRA_FIXTURE_IDS] as const;

describe('fixtures', () => {
  it('has all ten named fixtures', () => {
    expect([...FIXTURE_IDS]).toEqual([
      'healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data',
    ]);
    expect(buildAllFixtures().map((f) => f.id)).toEqual([...FIXTURE_IDS]);
  });

  it('are deterministic: two builds, and two sources on separate clocks, are deeply equal', async () => {
    expect(buildAllFixtures()).toEqual(buildAllFixtures());
    for (const id of ALL_IDS) expect((await snap(id)).s).toEqual((await snap(id)).s);
  });

  it('ids are namespaced per fixture: no task, attempt or approval id appears in two projects', () => {
    const seen = new Map<string, string>();
    for (const f of buildDemoFixtures()) {
      const ids = new Set<string>();
      for (const e of f.events) {
        ids.add(e.taskId);
        if (e.attemptId) ids.add(e.attemptId);
      }
      for (const a of f.approvals) ids.add(a.approvalId);
      for (const id of ids) {
        expect(seen.get(id), `${id} is in ${f.id} and ${seen.get(id)}`).toBeUndefined();
        seen.set(id, f.id);
      }
    }
  });

  it.each(ALL_IDS)('%s: events are valid domain events from permitted actors, and the snapshot is valid', async (id) => {
    const f = buildFixture(id);
    f.events.forEach((e, i) => {
      expect(ProjectViewEventSchema.safeParse(e).success, `${id} #${i}`).toBe(true);
      expect(checkEventAuthority(e).ok, `${id} ${e.type} by ${e.actor.kind}`).toBe(true);
      expect(e.sequence).toBe(i + 1);
      expect(e.provenance).toBe('simulated');
      // Liveness is not an event.
      expect(e.type, id).not.toBe('attempt.heartbeat');
      expect(e.payload, id).not.toHaveProperty('activity');
    });
    expect(ProjectViewSnapshotSchema.safeParse((await snap(id)).s).success).toBe(true);
    expect((await snap(id)).s.meta.provenance).toBe('simulated');
  });

  it.each(ALL_IDS)('%s: every task follows the domain state machine, within 2 concurrent attempts, and the projection agrees', async (id) => {
    const f = buildFixture(id);
    const machines = new Map<string, TaskState>();
    const running = new Set<string>();
    let max = 0;
    const move = (taskId: string, event: TaskEvent, at: string): void => {
      const st = machines.get(taskId);
      expect(st, `${at}: task ${taskId} is in a plan`).toBeDefined();
      const r = transition(st!, event);
      expect(r.ok, `${at}: ${event.type} from ${st!.status}`).toBe(true);
      if (r.ok) machines.set(taskId, r.value);
    };
    for (const e of f.events) {
      const at = `${f.id} #${e.sequence} ${e.type}`;
      const status = machines.get(e.taskId)?.status;
      switch (e.type) {
        case 'plan.accepted': {
          const rev = Number(e.payload['planRevision']);
          for (const taskId of e.payload['taskIds'] as string[]) {
            const seed = f.tasks.filter((t) => t.taskId === taskId && t.planRevision <= rev).sort((a, b) => b.revision - a.revision)[0]!;
            machines.set(taskId, newTaskState({ taskId, revision: seed.revision, kind: 'repository', maxAttempts: 3 }));
            running.delete(taskId);
          }
          break;
        }
        case 'task.ready':
          if (status === 'planned') move(e.taskId, { type: 'dependencies_satisfied' }, at);
          else if (status === 'blocked') move(e.taskId, { type: 'unblocked' }, at);
          else if (status === 'failed') move(e.taskId, { type: 'retry_requested' }, at);
          else expect(status, `${at}: ready only follows a state that can be ready`).toBe('ready');
          break;
        case 'attempt.started':
          move(e.taskId, { type: 'attempt_started', attemptId: e.attemptId! }, at);
          running.add(e.taskId);
          max = Math.max(max, running.size);
          break;
        case 'attempt.completed': move(e.taskId, { type: 'attempt_completed' }, at); running.delete(e.taskId); break;
        case 'attempt.failed':
          if (e.payload['outcome'] === 'interrupted') {
            move(e.taskId, { type: 'blocked', reason: String(e.payload['reason']) }, at);
            move(e.taskId, { type: 'unblocked' }, at); // an interrupted attempt returns the task to ready, in the same transaction
          } else move(e.taskId, { type: 'attempt_failed', reason: String(e.payload['reason']) }, at);
          running.delete(e.taskId);
          break;
        case 'approval.requested': move(e.taskId, { type: 'approval_requested' }, at); running.delete(e.taskId); break;
        case 'approval.granted': move(e.taskId, { type: 'approval_granted' }, at); break;
        case 'verification.passed': move(e.taskId, { type: 'verification_passed' }, at); break;
        case 'verification.failed': move(e.taskId, { type: 'verification_failed', reason: 'verification_failed' }, at); break;
        case 'task.cancelled': move(e.taskId, { type: 'cancel' }, at); running.delete(e.taskId); break;
        case 'task.blocked': move(e.taskId, status === 'verifying' ? { type: 'verification_unavailable', reason: String(e.payload['reason']) } : { type: 'blocked', reason: String(e.payload['reason']) }, at); running.delete(e.taskId); break;
        case 'change.merged': if (e.taskId !== e.runId) move(e.taskId, { type: 'change_merged' }, at); break; // the run-level event has no task
        default: break;
      }
    }
    expect(max).toBeLessThanOrEqual(2);
    // Nothing is left in `failed`: a real verdict writes ready or blocked in the same transaction.
    for (const [taskId, st] of machines) expect(st.status, taskId).not.toBe('failed');
    // The projection, played to the end, lands on the same status as the domain machine for every task.
    const ds = make();
    ds.clock.advance(3_600_000);
    const final = await ds.getSnapshot(f.projectId);
    for (const [taskId, st] of machines) expect(final.tasks[taskId]?.status, taskId).toBe(st.status);
  });

  it('healthy parallel work: two workers on two execution axes, both calling cloud models', async () => {
    const { s, nowMs } = await snap('healthy-parallel-work');
    expect(worker(s, 'runner_local_1')).toMatchObject({ execution: 'local', modelRoute: 'cloud', availability: 'assigned', activity: null });
    expect(worker(s, 'runner_cloud_1')).toMatchObject({ execution: 'cloud', modelRoute: 'cloud', activity: null });
    expect(s.assistant).toEqual({ mode: 'PREFER_ON_DEVICE', observedSource: 'on_device' });
    for (const w of Object.values(s.workers)) expect(effectiveWorkerHealth(w, nowMs, nowMs).health).toBe('healthy');
    expect(Object.values(s.tasks).filter((t) => t.status === 'running')).toHaveLength(2);
    expect(s.tasks[sc('healthy-parallel-work', 'api')]!.dependsOn).toEqual([]); // the snapshot knows; events never said
  });

  it('human wait: the worker waits for a person and the approval is pending, with the id from the server', async () => {
    const { s, nowMs } = await snap('human-wait');
    const apr = sc('human-wait', 'apr_docs_domain');
    expect(worker(s, 'runner_local_1')).toMatchObject({ activity: 'waiting_human', blockedByApprovalId: apr });
    expect(s.tasks[sc('human-wait', 'migrate')]!.status).toBe('awaiting_approval');
    expect(approvalStateAt(s.approvals[apr]!, nowMs)).toBe('pending');
    expect(effectiveWorkerHealth(worker(s, 'runner_cloud_1'), nowMs, nowMs).health).toBe('healthy');
  });

  it('policy block: tasks carry a placement reason and no worker', async () => {
    const { s } = await snap('policy-block');
    expect(s.tasks[sc('policy-block', 'export')]).toMatchObject({ status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' });
    expect(s.tasks[sc('policy-block', 'report')]!.placementBlock).toMatch(/^approval_required:/);
    expect(Object.values(s.attempts).some((a) => a.taskId === sc('policy-block', 'export'))).toBe(false);
  });

  it('runner loss: disconnected with no invented activity, not idle and not finished; then interrupted, not failed', async () => {
    const { s, nowMs } = await snap('runner-loss');
    const w = worker(s, 'runner_local_1');
    expect(w).toMatchObject({ activity: null, availability: 'assigned', leaseHeld: true });
    expect(effectiveWorkerHealth(w, nowMs, nowMs).health).toBe('disconnected');
    expect(s.tasks[sc('runner-loss', 'api')]!.status).toBe('running');
    const after = await snap('runner-loss', 20);
    expect(after.s.attempts[sc('runner-loss', 'att_api_1')]).toMatchObject({ outcome: 'interrupted', exitReason: 'lease_expired' });
    expect(after.s.attempts[sc('runner-loss', 'att_api_2')]!.outcome).toBe('running');
    expect(worker(after.s, 'runner_local_1')).toMatchObject({ availability: 'offline', health: 'disconnected' });
  });

  it('long-build stall: a suspected stall is neither a lost connection nor a failure, and it recovers', async () => {
    const { s, nowMs } = await snap('long-build-stall');
    const w = worker(s, 'runner_local_1');
    expect(effectiveWorkerHealth(w, nowMs, nowMs)).toMatchObject({ health: 'suspected_stall', derived: true });
    expect(s.tasks[sc('long-build-stall', 'web')]!.status).toBe('running');
    const later = await snap('long-build-stall', 10);
    expect(effectiveWorkerHealth(worker(later.s, 'runner_local_1'), later.nowMs, later.nowMs).health).toBe('healthy');
  });

  it('contract change: the plan is revised by one event, the replanned task is revision 2, and the approval waits', async () => {
    const { s, nowMs } = await snap('contract-change');
    const web = sc('contract-change', 'web');
    expect(s.runs[sc('contract-change', 'run')]!.planRevision).toBe(2);
    expect(s.tasks[web]).toMatchObject({ revision: 2, status: 'planned', title: 'Feedback list UI (contract v2)', dependsOn: [sc('contract-change', 'contract')] });
    expect(s.tasks[sc('contract-change', 'api')]).toMatchObject({ revision: 1, status: 'running' });
    expect(s.tasks[sc('contract-change', 'contract')]!.status).toBe('awaiting_approval');
    const apr = s.approvals[sc('contract-change', 'apr_contract_v2')]!;
    expect(apr).toMatchObject({ reason: 'The contract renames a field that clients depend on.', state: 'pending' });
    expect(approvalStateAt(apr, nowMs)).toBe('pending');
    expect(buildFixture('contract-change').events.some((e) => e.type === 'task.superseded')).toBe(false);
  });

  it('failed CI: the failed check stays as evidence, the attempt is failed, and policy scheduled a repair', async () => {
    const { s } = await snap('failed-ci');
    expect(s.checks['ci:unit']).toMatchObject({ state: 'failed', summary: '3 of 41 tests failed' });
    expect(s.attempts[sc('failed-ci', 'att_api_1')]!.outcome).toBe('failed');
    expect(s.tasks[sc('failed-ci', 'api')]).toMatchObject({ status: 'ready', statusReason: 'repair_scheduled' });
  });

  it('expired approval: reads as expired, and the task still waits', async () => {
    const { s, nowMs } = await snap('expired-approval');
    const a = s.approvals[sc('expired-approval', 'apr_vendor_docs')]!;
    expect(a.state).toBe('pending');
    expect(approvalStateAt(a, nowMs)).toBe('expired');
    expect(s.tasks[sc('expired-approval', 'docs')]!.status).toBe('awaiting_approval');
  });

  it('unknown costs: unavailable stays unknown and is never summed as zero', async () => {
    const { s } = await snap('unknown-costs');
    const run = sc('unknown-costs', 'run');
    const cost = usageFor(s.usage, 'cost_usd', { runId: run });
    expect(cost.total).toBeNull();
    expect(cost.provenance).toBe('unavailable');
    expect(cost.knownSubtotal).toBe('3.74');
    expect(cost.unavailableCount).toBe(1);
    expect(usageFor(s.usage, 'cost_usd', { taskId: sc('unknown-costs', 'web') })).toMatchObject({ total: null, knownSubtotal: null });
    expect(usageFor(s.usage, 'cost_usd', { taskId: sc('unknown-costs', 'api') })).toMatchObject({ total: '1.24', provenance: 'estimated' });
    expect(usageFor(s.usage, 'input_tokens', { taskId: sc('unknown-costs', 'api') })).toMatchObject({ total: '120400', provenance: 'observed' });
    expect(s.usage.filter((u) => u.figure.provenance === 'unavailable').every((u) => u.figure.quantity === null)).toBe(true);
    expect(worker(s, 'runner_cloud_1').modelRoute).toBe('unknown');
    expect(s.assistant).toEqual({ mode: null, observedSource: 'unknown' });
    expect(s.tasks[sc('unknown-costs', 'batch')]).toMatchObject({ status: 'cancelled', cancelReason: 'budget_exhausted' });
  });

  it('no data: an empty project is empty, not zero', async () => {
    const { s } = await snap('no-data');
    expect(isEmptyProject(s)).toBe(true);
    expect(s.meta.cursor).toBe('0');
    expect(s.usage).toEqual([]);
    expect(usageFor(s.usage, 'cost_usd').total).toBeNull();
  });
});

describe('criteria', () => {
  const runOf = async (id: Parameters<typeof buildFixture>[0], advanceMs = 0) => {
    const fixture = buildFixture(id);
    const clock = createSeededClock(new Date(FIXTURE_T0_MS).toISOString());
    const source = createMockDataSource({ clock, fixtures: [fixture] });
    if (advanceMs > 0) clock.advance(advanceMs);
    const snapshot = await source.getSnapshot(fixture.projectId);
    source.disconnect();
    return Object.values(snapshot.runs)[0]!;
  };

  it('counts verified criteria from verdicts, and moves only when a verdict lands', async () => {
    expect((await runOf('healthy-parallel-work')).criteria).toEqual({ verified: 0, total: 5 });
    expect((await runOf('healthy-parallel-work', 20_000)).criteria).toEqual({ verified: 0, total: 5 }); // completed and heartbeating, not verified
    expect((await runOf('healthy-parallel-work', 40_000)).criteria).toEqual({ verified: 3, total: 5 });
  });

  it('keeps budget-cancelled work in the denominator: those criteria are still unmet', async () => {
    expect((await runOf('unknown-costs')).criteria).toEqual({ verified: 2, total: 7 });
  });

  it('reports null where a scene has no per-criterion evidence', async () => {
    expect((await runOf('long-build-stall')).criteria).toBeNull();
  });
});

describe('liveness through the session', () => {
  it('with only real events, a healthy attempt stays healthy across refreshes and a dead one goes stale', async () => {
    const ds = make();
    const manual: Array<() => void> = [];
    const alive = buildFixture('healthy-parallel-work');
    const dead = buildFixture('runner-loss');
    const run = async (f: Fixture, until: number) => {
      const session = startProjection(ds, f.projectId, { onState: () => {}, onError: (e) => { throw new Error(e.message); } }, { refreshMs: 10_000, clock: ds.clockFor(f.projectId), every: (fn) => { manual.push(fn); return () => {}; } });
      await settle();
      const out: string[] = [];
      const cursor0 = session.state()!.snapshot.meta.cursor;
      for (let i = 0; i < until; i += 1) {
        ds.clock.advance(5_000);
        await session.refresh();
        const st = session.state()!.snapshot;
        out.push(Object.values(st.workers).map((w) => `${w.workerId}:${effectiveWorkerHealth(w, ds.clockFor(f.projectId).nowMs(), session.livenessAsOfMs()).health}`).join(','));
      }
      return { session, out, cursor0 };
    };
    // healthy-parallel-work: events up to 125 s, then api completes at 135 and is verified at 160. The cloud worker holds its lease the whole time.
    const a = await run(alive, 10); // 125 s to 175 s
    expect(a.out.every((x) => x.includes('runner_cloud_1:healthy'))).toBe(true);
    expect(a.out.some((x) => /suspected|disconnected/.test(x))).toBe(false);
    a.session.stop();
    // runner-loss: 108 s on, 54 s of silence at the start. Disconnected before the reaper acts at 112 s, and the later events do not hide it.
    const b = await run(dead, 1);
    expect(b.out[0]).toContain('runner_local_1:disconnected');
    b.session.stop();
  });

  it('a snapshot refresh moves heartbeats only: the cursor and event-derived state are untouched', async () => {
    const ds = make();
    const f = buildFixture('long-build-stall');
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => {} }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    const before = session.state()!.snapshot;
    ds.clock.advance(1_000);
    await session.refresh();
    const after = session.state()!.snapshot;
    expect(after.meta.cursor).toBe(before.meta.cursor);
    expect(after.tasks).toEqual(before.tasks);
    session.stop();
  });
});

describe('run lifecycle', () => {
  it('reaches ready_for_review and then merged through the real event sequence, once a refresh carries it', async () => {
    const f = { ...buildFixture('merge-flow'), startSec: 50 };
    const ds = make([f]);
    const run = sc('merge-flow', 'run');
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: (e) => { throw new Error(e.message); } }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    const life = () => session.state()!.snapshot.runs[run]!.lifecycle;
    expect(life()).toBe('running');

    ds.clock.advance(6_000); // both verdicts are in (55 s)
    await settle();
    const tasks = () => Object.values(session.state()!.snapshot.tasks).map((t) => t.status);
    expect(tasks()).toEqual(['verified', 'verified']);
    expect(life()).toBe('running'); // no event says otherwise
    await session.refresh();
    expect(life()).toBe('ready_for_review');

    ds.clock.advance(50_000); // the merge is seen at 100 s
    await settle();
    expect(tasks()).toEqual(['merged', 'merged']);
    expect(life()).toBe('ready_for_review');
    await session.refresh();
    expect(life()).toBe('merged');
    expect(session.state()!.snapshot.runs[run]!.latestEvidence).toMatchObject({ kind: 'change.merged' });
    expect(Object.keys(session.state()!.snapshot.tasks)).toHaveLength(2); // run-level events made no tasks
    session.stop();
  });

  it('the first snapshot of a ready run already says ready_for_review', async () => {
    const { s } = await snap('merge-flow');
    expect(s.runs[sc('merge-flow', 'run')]!.lifecycle).toBe('ready_for_review');
  });
});

describe('streaming and resync', () => {
  it('streams the rest of a scenario as the virtual clock advances, with no resync when the snapshot already knows everything', async () => {
    const ds = make();
    const f = buildFixture('human-wait');
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    ds.clock.advance(70_000); // grant at 150 s, claimed again at 155 s
    expect(session.state()!.snapshot.tasks[sc('human-wait', 'migrate')]!.status).toBe('running');
    expect(session.state()!.snapshot.approvals[sc('human-wait', 'apr_docs_domain')]!.state).toBe('granted');
    expect(session.resyncCount()).toBe(0);
    session.stop();
  });

  it('a session that starts before the first plan.accepted gets the board when it arrives', async () => {
    const f = { ...buildFixture('healthy-parallel-work'), startSec: 0 };
    const ds = make([f]);
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    expect(Object.keys(session.state()!.snapshot.tasks)).toEqual([]);
    ds.clock.advance(8_000); // plan at 1 s, claims at 6 s and 7 s
    await settle();
    expect(session.resyncCount()).toBeGreaterThanOrEqual(1);
    const st = session.state()!.snapshot;
    expect(Object.values(st.tasks).map((t) => t.title).sort()).toEqual(['Feedback API', 'Feedback list UI']);
    expect(Object.values(st.tasks).every((t) => t.status === 'running')).toBe(true);
    session.stop();
  });

  it('an approval.requested without an approval id makes the session resync, and then it knows the approval', async () => {
    const f = { ...buildFixture('human-wait'), startSec: 30 };
    const ds = make([f]);
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    expect(Object.keys(session.state()!.snapshot.approvals)).toEqual([]);
    ds.clock.advance(15_000); // the request is at 40 s
    await settle();
    expect(session.resyncCount()).toBe(1);
    expect(session.state()!.snapshot.approvals[sc('human-wait', 'apr_docs_domain')]).toMatchObject({ state: 'pending', reason: 'Backfilling rewrites every row of the feedback table.' });
    expect(session.state()!.snapshot.tasks[sc('human-wait', 'migrate')]!.status).toBe('awaiting_approval');
    session.stop();
  });

  it('a revised plan makes the session resync to the new task revision', async () => {
    const f = { ...buildFixture('contract-change'), startSec: 50 };
    const ds = make([f]);
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0, every: noTimers, clock: ds.clockFor(f.projectId) });
    await settle();
    expect(session.state()!.snapshot.tasks[sc('contract-change', 'web')]!.revision).toBe(1);
    ds.clock.advance(15_000); // plan.accepted revision 2 at 60 s
    await settle();
    expect(session.resyncCount()).toBe(1);
    expect(session.state()!.snapshot.tasks[sc('contract-change', 'web')]).toMatchObject({ revision: 2, status: 'planned' });
    session.stop();
  });
});

describe('commands target one project and follow the real cancel rules', () => {
  it('run.start_new opens a fresh run in planning in that project only, and replays by key', async () => {
    const ds = make();
    const a = buildFixture('runner-loss');
    const b = buildFixture('healthy-parallel-work');
    const beforeB = Object.keys((await ds.getSnapshot(b.projectId)).runs);
    const before = Object.keys((await ds.getSnapshot(a.projectId)).runs);
    const start = { command: 'run.start_new' as const, expectedRevision: 0, idempotencyKey: 'new-run-1', args: { projectId: a.projectId, title: 'Follow-up run' } };
    const first = await ds.execute(start);
    expect(first).toMatchObject({ accepted: true, execution: 'applied', simulated: true, replayed: false });
    ds.clock.advance(5_000);
    const after = await ds.getSnapshot(a.projectId);
    const added = Object.values(after.runs).filter((r) => !before.includes(r.runId));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ lifecycle: 'planning', planRevision: 0 });
    expect(await ds.execute(start)).toMatchObject({ accepted: true, replayed: true });
    expect(Object.keys((await ds.getSnapshot(a.projectId)).runs)).toHaveLength(before.length + 1);
    expect(Object.keys((await ds.getSnapshot(b.projectId)).runs)).toEqual(beforeB);
    expect(await ds.execute({ ...start, idempotencyKey: 'x', args: { projectId: 'nope', title: 'T' } })).toMatchObject({ accepted: false, rejection: 'unknown_target' });
  });

  const cancel = (taskId: string, rev: number, key: string) => ({ command: 'task.cancel' as const, expectedRevision: rev, idempotencyKey: key, args: { taskId } });

  it('cancelling a task in one fixture changes that fixture only', async () => {
    const ds = make();
    const a = buildFixture('runner-loss');
    const b = buildFixture('healthy-parallel-work');
    const before = await ds.getSnapshot(b.projectId);
    const t = (await ds.getSnapshot(a.projectId)).tasks[sc('runner-loss', 'api')]!;
    const r = await ds.execute(cancel(t.taskId, t.aggregateRevision, 'k1'));
    expect(r.accepted).toBe(true);
    ds.clock.advance(5_000);
    const after = await ds.getSnapshot(a.projectId);
    expect(after.tasks[t.taskId]!.status).toBe('cancelled');
    expect({ ...(await ds.getSnapshot(b.projectId)), meta: before.meta, attempts: before.attempts, workers: before.workers, runners: before.runners }).toEqual({ ...before, attempts: before.attempts, workers: before.workers, runners: before.runners });
    expect((await ds.getSnapshot(b.projectId)).meta.cursor).toBe(before.meta.cursor);
    // A terminal for another project's attempt cannot be opened with this task.
    await expect(ds.openTerminal({ taskId: t.taskId, attemptId: sc('healthy-parallel-work', 'att_api_1'), expectedRevision: 0 })).rejects.toBeInstanceOf(Error);
  });

  it('a running task gets cancel_requested then cancelled; a waiting task cancels at once; a failed or finished one is refused', async () => {
    const ds = make();
    const run = (await ds.getSnapshot(buildFixture('unknown-costs').projectId)).tasks[sc('unknown-costs', 'api')]!;
    expect(run.status).toBe('running');
    const requested = await ds.execute(cancel(run.taskId, run.aggregateRevision, 'k-run'));
    expect(requested).toMatchObject({ accepted: true, execution: 'cancel_requested' });

    const waiting = (await ds.getSnapshot(buildFixture('human-wait').projectId)).tasks[sc('human-wait', 'migrate')]!;
    expect(waiting.status).toBe('awaiting_approval');
    const at = await ds.execute(cancel(waiting.taskId, waiting.aggregateRevision, 'k-wait'));
    expect(at).toMatchObject({ accepted: true, execution: 'applied' });
    expect((await ds.getSnapshot(buildFixture('human-wait').projectId)).tasks[waiting.taskId]!.status).toBe('cancelled');

    const cancelled = (await ds.getSnapshot(buildFixture('unknown-costs').projectId)).tasks[sc('unknown-costs', 'batch')]!;
    expect(await ds.execute(cancel(cancelled.taskId, cancelled.aggregateRevision, 'k-done'))).toMatchObject({ accepted: false, rejection: 'not_allowed' });
  });

  it('a cancelled task has its pending fixture events dropped', async () => {
    const ds = make();
    const f = buildFixture('human-wait'); // grant at 150 s and a new attempt at 155 s are still to come
    const t = (await ds.getSnapshot(f.projectId)).tasks[sc('human-wait', 'migrate')]!;
    await ds.execute(cancel(t.taskId, t.aggregateRevision, 'k-drop'));
    ds.clock.advance(120_000);
    const s = await ds.getSnapshot(f.projectId);
    expect(s.tasks[t.taskId]).toMatchObject({ status: 'cancelled' });
    expect(s.attempts[sc('human-wait', 'att_mig_2')]).toBeUndefined();
  });
});

describe('purity of reducers and fixtures', () => {
  it('no wall clock or random source in view-protocol or data-source-mock sources', () => {
    const dirs = [join(import.meta.dirname, '../src'), join(import.meta.dirname, '../../view-protocol/src')];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
        const text = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(text, `${dir}/${file}`).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(\)|performance\.now\(|crypto\.randomUUID/);
      }
    }
  });

  describe('decision routes', () => {
    const source = (f: Fixture) => {
      const clock = createSeededClock(fixtureTime(0));
      return { clock, ds: createMockDataSource({ clock, fixtures: [f] }) };
    };

    it('a stop arriving between render and accept is refused; a stop still in flight is cancel_pending', async () => {
      const f = { ...buildFixture('budget-stop'), startSec: 78 };
      const { clock, ds } = source(f);
      const run = Object.values((await ds.getSnapshot(f.projectId)).runs)[0]!;
      expect(run.scopeAssessment!.stoppingTaskIds).toEqual([scoped('budget-stop', 'docs')]);
      const args = { runId: run.runId, notDeliveredHash: run.scopeAssessment!.notDeliveredHash };
      expect(await ds.execute({ command: 'run.accept_reduced_scope', expectedRevision: run.planRevision, idempotencyKey: 'a', args })).toMatchObject({ rejection: 'cancel_pending' });
      clock.advance(10_000); // the docs task is now cancelled, so the list the person read is out of date
      const res = await ds.execute({ command: 'run.accept_reduced_scope', expectedRevision: run.planRevision, idempotencyKey: 'b', args });
      expect(res).toMatchObject({ accepted: false, rejection: 'reduced_scope_changed' });
      const fresh = Object.values((await ds.getSnapshot(f.projectId)).runs)[0]!;
      expect(fresh.reducedScope).toBeNull();
      expect(await ds.execute({ command: 'run.accept_reduced_scope', expectedRevision: run.planRevision, idempotencyKey: 'c', args: { runId: run.runId, notDeliveredHash: fresh.scopeAssessment!.notDeliveredHash } })).toMatchObject({ accepted: true });
    });

    it('a request for an operation that cannot take effect is refused a grant', async () => {
      const base = buildFixture('expired-approval');
      const f = { ...base, startSec: 100, approvals: base.approvals.map((a) => ({ ...a, operation: 'new_domain', destination: 'docs.example.com' })) };
      const { ds } = source(f);
      const snap = await ds.getSnapshot(f.projectId);
      const a = Object.values(snap.approvals)[0]!;
      expect(await ds.execute({ command: 'approval.grant', expectedRevision: snap.tasks[a.taskId!]!.aggregateRevision, idempotencyKey: 'g', args: { approvalId: a.approvalId, scopeHash: a.scopeHash! } })).toMatchObject({ rejection: 'policy_denied' });
    });
  });
});

describe('model assignment commands', () => {
  const setup = async (id: Parameters<typeof buildFixture>[0] = 'healthy-parallel-work') => {
    const fixture = buildFixture(id);
    const source = createMockDataSource({ clock: createSeededClock(new Date(FIXTURE_T0_MS).toISOString()), fixtures: [fixture] });
    const snap = await source.getSnapshot(fixture.projectId);
    return { source, snap, projectId: fixture.projectId };
  };
  const set = (projectId: string, over: Record<string, unknown> = {}, expectedRevision = 0, key = 'k1') => ({ command: 'assignment.set' as const, expectedRevision, idempotencyKey: key, args: { projectId, scope: 'role' as const, key: 'backend', selection: { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...over } });

  it('matches the real route: applied, replayed, stale, refused', async () => {
    const { source, projectId } = await setup();
    const ok = await source.execute(set(projectId));
    expect(ok).toMatchObject({ accepted: true, execution: 'applied', rejection: null, simulated: true });
    expect((await source.getSnapshot(projectId)).modelAssignments).toMatchObject([{ scope: 'role', key: 'backend', model: 'claude-haiku-5-5', revision: 1 }]);
    expect(await source.execute(set(projectId))).toMatchObject({ accepted: true, replayed: true });
    expect(await source.execute(set(projectId, {}, 0, 'k2'))).toMatchObject({ accepted: false, rejection: 'stale_revision' });
    expect(await source.execute(set(projectId, { selection: { provider: 'codex', model: 'gpt-x' } }, 1, 'k3'))).toMatchObject({ rejection: 'unsupported_provider' });
    expect(await source.execute(set(projectId, { selection: { provider: 'anthropic', model: 'claude-made-up' } }, 1, 'k4'))).toMatchObject({ rejection: 'unsupported_model' });
    expect(await source.execute(set(projectId, { selection: { provider: 'anthropic', model: 'claude-opus-5-5' } }, 1, 'k5'))).toMatchObject({ rejection: 'model_not_allowed' });
    expect(await source.execute(set(projectId, { selection: null }, 1, 'k6'))).toMatchObject({ accepted: true });
    expect((await source.getSnapshot(projectId)).modelAssignments[0]).toMatchObject({ provider: null, model: null, revision: 2 });
  });

  it('a task override: unknown or closed tasks refuse, and a trial is pinned', async () => {
    const { source, projectId, snap } = await setup('merge-flow');
    const closed = Object.values(snap.tasks).find((t) => ['merged', 'verified', 'cancelled', 'superseded'].includes(t.status));
    expect(await source.execute(set(projectId, { scope: 'task', key: 'nope' }))).toMatchObject({ rejection: 'unknown_target' });
    if (closed) expect(await source.execute(set(projectId, { scope: 'task', key: closed.taskId }, 0, 'k2'))).toMatchObject({ rejection: 'not_allowed' });
    const trial = await setup('benchmark-trial');
    const taskId = Object.keys(trial.snap.tasks)[0]!;
    expect(trial.snap.runs[Object.keys(trial.snap.runs)[0]!]!.pinnedModel).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(await trial.source.execute(set(trial.projectId, { scope: 'task', key: taskId, selection: { provider: 'anthropic', model: 'claude-haiku-5-5' } }))).toMatchObject({ rejection: 'trial_model_pinned' });
  });

  it('lists only Claude, and reports nothing detected when told to', async () => {
    const { snap } = await setup();
    expect(snap.modelCatalog.providers.map((p) => p.provider)).toEqual(['anthropic']);
    expect(JSON.stringify(snap.modelCatalog)).not.toMatch(/codex|gpt/i);
  });
});

describe('per-criterion evidence and activity', () => {
  it('the fold of a verified fixture has one evidence row per counted criterion, each tied to its check and candidate', async () => {
    const ds = make();
    const snap = await ds.getSnapshot('demo-merge-review');
    const run = Object.values(snap.runs)[0]!;
    expect(run.criteria).toEqual({ verified: 5, total: 5 });
    expect(run.evidence?.criteria.map((c) => c.criterionId)).toEqual(['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-05']);
    for (const c of run.evidence!.criteria) expect(c).toMatchObject({ state: 'passed', verified: true, candidateSha: run.evidence!.candidate!.sha, check: { checkId: c.criterionId } });
  });

  it('a scene with no per-criterion data reports null criteria and null evidence', async () => {
    const ds = make();
    const run = Object.values((await ds.getSnapshot('demo-feature-delivery')).runs)[0]!;
    expect(run.criteria).toBeNull();
    expect(run.evidence).toBeNull();
  });

  it('every running worker reports the tool it is using, and a fixture that does not stays null', async () => {
    const ds = make();
    const busy = await ds.getSnapshot('demo-healthy-parallel-work');
    for (const w of Object.values(busy.workers).filter((x) => x.leaseHeld)) expect(w.latestAction?.tool).toMatch(/^[A-Z]/);
    const quiet = await ds.getSnapshot('demo-long-build-stall');
    expect(Object.values(quiet.workers).find((x) => x.leaseHeld)?.latestAction).toBeNull();
  });

  it('the merge-flow candidate is assembled before any verdict', () => {
    const types = buildFixture('merge-flow').events.map((e) => e.type);
    expect(types.indexOf('candidate.assembled')).toBeLessThan(types.indexOf('verification.passed'));
  });
});
