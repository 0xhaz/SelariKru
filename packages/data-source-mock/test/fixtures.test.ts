import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEventAuthority, newTaskState, transition, type TaskEvent, type TaskState } from '@selarikru/domain';
import {
  ProjectViewEventSchema, ProjectViewSnapshotSchema, approvalStateAt, effectiveWorkerHealth, isEmptyProject, startProjection, usageFor,
  type ProjectViewSnapshot,
} from '@selarikru/view-protocol';
import { FIXTURE_IDS, buildAllFixtures, buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped, type Fixture, type FixtureId } from '../src/index.ts';

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

describe('fixtures', () => {
  it('has all ten named fixtures', () => {
    expect([...FIXTURE_IDS]).toEqual([
      'healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data',
    ]);
    expect(buildAllFixtures().map((f) => f.id)).toEqual([...FIXTURE_IDS]);
  });

  it('are deterministic: two builds, and two sources on separate clocks, are deeply equal', async () => {
    expect(buildAllFixtures()).toEqual(buildAllFixtures());
    for (const id of FIXTURE_IDS) expect((await snap(id)).s).toEqual((await snap(id)).s);
  });

  it('ids are namespaced per fixture: no task, attempt or approval id appears in two projects', () => {
    const seen = new Map<string, string>();
    for (const f of buildAllFixtures()) {
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

  it.each(FIXTURE_IDS)('%s: events are valid domain events from permitted actors, and the snapshot is valid', async (id) => {
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

  it.each(FIXTURE_IDS)('%s: every task follows the domain state machine, within 2 concurrent attempts, and the projection agrees', async (id) => {
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
    for (const w of Object.values(s.workers)) expect(effectiveWorkerHealth(w, nowMs).health).toBe('healthy');
    expect(Object.values(s.tasks).filter((t) => t.status === 'running')).toHaveLength(2);
    expect(s.tasks[sc('healthy-parallel-work', 'api')]!.dependsOn).toEqual([]); // the snapshot knows; events never said
  });

  it('human wait: the worker waits for a person and the approval is pending, with the id from the server', async () => {
    const { s, nowMs } = await snap('human-wait');
    const apr = sc('human-wait', 'apr_docs_domain');
    expect(worker(s, 'runner_local_1')).toMatchObject({ activity: 'waiting_human', blockedByApprovalId: apr });
    expect(s.tasks[sc('human-wait', 'migrate')]!.status).toBe('awaiting_approval');
    expect(approvalStateAt(s.approvals[apr]!, nowMs)).toBe('pending');
    expect(effectiveWorkerHealth(worker(s, 'runner_cloud_1'), nowMs).health).toBe('healthy');
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
    expect(effectiveWorkerHealth(w, nowMs).health).toBe('disconnected');
    expect(s.tasks[sc('runner-loss', 'api')]!.status).toBe('running');
    const after = await snap('runner-loss', 20);
    expect(after.s.attempts[sc('runner-loss', 'att_api_1')]).toMatchObject({ outcome: 'interrupted', exitReason: 'lease_expired' });
    expect(after.s.attempts[sc('runner-loss', 'att_api_2')]!.outcome).toBe('running');
    expect(worker(after.s, 'runner_local_1')).toMatchObject({ availability: 'offline', health: 'disconnected' });
  });

  it('long-build stall: a suspected stall is neither a lost connection nor a failure, and it recovers', async () => {
    const { s, nowMs } = await snap('long-build-stall');
    const w = worker(s, 'runner_local_1');
    expect(effectiveWorkerHealth(w, nowMs)).toMatchObject({ health: 'suspected_stall', derived: true });
    expect(s.tasks[sc('long-build-stall', 'web')]!.status).toBe('running');
    const later = await snap('long-build-stall', 10);
    expect(effectiveWorkerHealth(worker(later.s, 'runner_local_1'), later.nowMs).health).toBe('healthy');
  });

  it('contract change: the plan is revised by one event, the replanned task is revision 2, and the approval waits', async () => {
    const { s, nowMs } = await snap('contract-change');
    const web = sc('contract-change', 'web');
    expect(s.runs[sc('contract-change', 'run')]!.planRevision).toBe(2);
    expect(s.tasks[web]).toMatchObject({ revision: 2, status: 'planned', title: 'Feedback list UI (contract v2)', dependsOn: [sc('contract-change', 'contract')] });
    expect(s.tasks[sc('contract-change', 'api')]).toMatchObject({ revision: 1, status: 'running' });
    expect(s.tasks[sc('contract-change', 'contract')]!.status).toBe('awaiting_approval');
    const apr = s.approvals[sc('contract-change', 'apr_contract_v2')]!;
    expect(apr).toMatchObject({ reason: 'approve_contract_v2', state: 'pending' });
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

describe('liveness through the session', () => {
  it('with only real events, a healthy attempt stays healthy across refreshes and a dead one goes stale', async () => {
    const ds = make();
    const manual: Array<() => void> = [];
    const alive = buildFixture('healthy-parallel-work');
    const dead = buildFixture('runner-loss');
    const run = async (f: Fixture, until: number) => {
      const session = startProjection(ds, f.projectId, { onState: () => {}, onError: (e) => { throw new Error(e.message); } }, { refreshMs: 10_000, every: (fn) => { manual.push(fn); return () => {}; } });
      await settle();
      const out: string[] = [];
      const cursor0 = session.state()!.snapshot.meta.cursor;
      for (let i = 0; i < until; i += 1) {
        ds.clock.advance(5_000);
        await session.refresh();
        const st = session.state()!.snapshot;
        out.push(Object.values(st.workers).map((w) => `${w.workerId}:${effectiveWorkerHealth(w, ds.clockFor(f.projectId).nowMs()).health}`).join(','));
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
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => {} }, { refreshMs: 0 });
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

describe('streaming and resync', () => {
  it('streams the rest of a scenario as the virtual clock advances, with no resync when the snapshot already knows everything', async () => {
    const ds = make();
    const f = buildFixture('human-wait');
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0 });
    await settle();
    ds.clock.advance(70_000); // grant at 150 s, claimed again at 155 s
    expect(session.state()!.snapshot.tasks[sc('human-wait', 'migrate')]!.status).toBe('running');
    expect(session.state()!.snapshot.approvals[sc('human-wait', 'apr_docs_domain')]!.state).toBe('granted');
    expect(session.resyncCount()).toBe(0);
    session.stop();
  });

  it('an approval.requested without an approval id makes the session resync, and then it knows the approval', async () => {
    const f = { ...buildFixture('human-wait'), startSec: 30 };
    const ds = make([f]);
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0 });
    await settle();
    expect(Object.keys(session.state()!.snapshot.approvals)).toEqual([]);
    ds.clock.advance(15_000); // the request is at 40 s
    await settle();
    expect(session.resyncCount()).toBe(1);
    expect(session.state()!.snapshot.approvals[sc('human-wait', 'apr_docs_domain')]).toMatchObject({ state: 'pending', reason: 'allow_documentation_domain' });
    expect(session.state()!.snapshot.tasks[sc('human-wait', 'migrate')]!.status).toBe('awaiting_approval');
    session.stop();
  });

  it('a revised plan makes the session resync to the new task revision', async () => {
    const f = { ...buildFixture('contract-change'), startSec: 50 };
    const ds = make([f]);
    const session = startProjection(ds, f.projectId, { onState: () => {}, onError: () => { throw new Error('unexpected'); } }, { refreshMs: 0 });
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
    expect({ ...(await ds.getSnapshot(b.projectId)), meta: before.meta, attempts: before.attempts, workers: before.workers }).toEqual({ ...before, attempts: before.attempts, workers: before.workers });
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
});
