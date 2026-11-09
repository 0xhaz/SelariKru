import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEventAuthority } from '@selarikru/domain';
import {
  ProjectViewEventSchema, ProjectViewSnapshotSchema, applyEvents, approvalStateAt, effectiveWorkerHealth, isEmptyProject, projectionFromSnapshot, startProjection, usageFor,
  type ProjectViewSnapshot,
} from '@selarikru/view-protocol';
import { FIXTURE_IDS, buildAllFixtures, buildFixture, createMockDataSource, createSeededClock, fixtureTime, type FixtureId } from '../src/index.ts';

const make = () => createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
const snap = async (id: FixtureId, advanceSec = 0): Promise<{ s: ProjectViewSnapshot; nowMs: number }> => {
  const ds = make();
  if (advanceSec > 0) ds.clock.advance(advanceSec * 1000);
  const f = buildFixture(id);
  return { s: await ds.getSnapshot(f.projectId), nowMs: ds.clockFor(f.projectId).nowMs() };
};
const worker = (s: ProjectViewSnapshot, id: string) => s.workers[id]!;

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

  it.each(FIXTURE_IDS)('%s: events are valid domain events from permitted actors, and the snapshot is valid', async (id) => {
    const f = buildFixture(id);
    f.events.forEach((e, i) => {
      expect(ProjectViewEventSchema.safeParse(e).success, `${id} #${i}`).toBe(true);
      expect(checkEventAuthority(e).ok, `${id} ${e.type} by ${e.actor.kind}`).toBe(true);
      expect(e.sequence).toBe(i + 1);
      expect(e.provenance).toBe('simulated');
    });
    const { s } = await snap(id);
    expect(ProjectViewSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.meta.provenance).toBe('simulated');
    // The whole stream folds without a gap or a conflict.
    expect(applyEvents(projectionFromSnapshot({ ...s, meta: { ...s.meta, cursor: '0' }, runs: {}, tasks: {}, attempts: {}, workers: {}, approvals: {}, checks: {} }), f.events).outcome).not.toBe('resync');
  });

  it('healthy parallel work: two workers on two execution axes, both calling cloud models', async () => {
    const { s, nowMs } = await snap('healthy-parallel-work');
    expect(worker(s, 'runner_local_1')).toMatchObject({ execution: 'local', modelRoute: 'cloud', availability: 'assigned' });
    expect(worker(s, 'runner_cloud_1')).toMatchObject({ execution: 'cloud', modelRoute: 'cloud' });
    expect(s.assistant).toEqual({ mode: 'PREFER_ON_DEVICE', observedSource: 'on_device' });
    for (const w of Object.values(s.workers)) expect(effectiveWorkerHealth(w, nowMs).health).toBe('healthy');
    expect(Object.values(s.tasks).filter((t) => t.status === 'running')).toHaveLength(2); // the limit is 2 concurrent
  });

  it('human wait: the worker waits for a person and the approval is pending', async () => {
    const { s, nowMs } = await snap('human-wait');
    expect(worker(s, 'runner_local_1')).toMatchObject({ activity: 'waiting_human', blockedByApprovalId: 'apr_docs_domain' });
    expect(s.tasks['migrate']!.status).toBe('awaiting_approval');
    expect(approvalStateAt(s.approvals['apr_docs_domain']!, nowMs)).toBe('pending');
    expect(effectiveWorkerHealth(worker(s, 'runner_cloud_1'), nowMs).health).toBe('healthy');
  });

  it('policy block: tasks carry a placement reason and no worker', async () => {
    const { s } = await snap('policy-block');
    expect(s.tasks['export']).toMatchObject({ status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' });
    expect(s.tasks['report']!.placementBlock).toMatch(/^approval_required:/);
    expect(Object.values(s.attempts).some((a) => a.taskId === 'export')).toBe(false);
  });

  it('runner loss: disconnected, last activity kept, not idle and not finished', async () => {
    const { s, nowMs } = await snap('runner-loss');
    const w = worker(s, 'runner_local_1');
    expect(w).toMatchObject({ activity: 'coding', availability: 'assigned', leaseHeld: true });
    expect(effectiveWorkerHealth(w, nowMs).health).toBe('disconnected');
    expect(s.tasks['api']!.status).toBe('running');
    // After the reaper acts, the stream shows the loss and a new attempt, never a silent replacement.
    const after = await snap('runner-loss', 20);
    expect(after.s.attempts['att_api_1']).toMatchObject({ outcome: 'interrupted', exitReason: 'lease_expired' });
    expect(after.s.attempts['att_api_2']!.outcome).toBe('running');
    expect(worker(after.s, 'runner_local_1')).toMatchObject({ availability: 'offline', health: 'disconnected' });
  });

  it('long-build stall: a suspected stall is neither a lost connection nor a failure', async () => {
    const { s, nowMs } = await snap('long-build-stall');
    const w = worker(s, 'runner_local_1');
    expect(effectiveWorkerHealth(w, nowMs)).toMatchObject({ health: 'suspected_stall', derived: true });
    expect(w.latestAction).toMatchObject({ tool: 'pnpm -r build', longRunning: true });
    expect(s.tasks['web']!.status).toBe('running');
    const later = await snap('long-build-stall', 10);
    expect(effectiveWorkerHealth(worker(later.s, 'runner_local_1'), later.nowMs).health).toBe('healthy');
  });

  it('contract change: the old revision is superseded and the new one waits', async () => {
    const { s, nowMs } = await snap('contract-change');
    expect(s.runs['run_demo']!.planRevision).toBe(2);
    expect(s.tasks['web']).toMatchObject({ revision: 2, status: 'ready', title: 'Feedback list UI (contract v2)' });
    expect(s.attempts['att_web_1']).toMatchObject({ outcome: 'failed', exitReason: 'superseded_by_plan' }); // history of revision 1 is kept
    expect(s.approvals['apr_contract_v2']).toMatchObject({ reason: 'approve_contract_v2', state: 'pending' });
    expect(approvalStateAt(s.approvals['apr_contract_v2']!, nowMs)).toBe('pending');
  });

  it('failed CI: the failed check stays as evidence', async () => {
    const { s } = await snap('failed-ci');
    expect(s.checks['ci:unit']).toMatchObject({ state: 'failed', summary: '3 of 41 tests failed' });
    expect(s.checks['ci:lint']!.state).toBe('passed');
    expect(s.tasks['api']).toMatchObject({ status: 'failed', statusReason: 'required_check_failed' });
    expect(s.attempts['att_api_1']!.outcome).toBe('succeeded');
  });

  it('expired approval: reads as expired, and the task still waits', async () => {
    const { s, nowMs } = await snap('expired-approval');
    expect(s.approvals['apr_vendor_docs']!.state).toBe('pending');
    expect(approvalStateAt(s.approvals['apr_vendor_docs']!, nowMs)).toBe('expired');
    expect(s.tasks['deploy-docs']!.status).toBe('awaiting_approval');
  });

  it('unknown costs: unavailable stays unknown and is never summed as zero', async () => {
    const { s } = await snap('unknown-costs');
    const cost = usageFor(s.usage, 'cost_usd', { runId: 'run_demo' });
    expect(cost.total).toBeNull();
    expect(cost.provenance).toBe('unavailable');
    expect(cost.knownSubtotal).toBe('3.74');
    expect(cost.unavailableCount).toBe(1);
    expect(usageFor(s.usage, 'cost_usd', { taskId: 'web' })).toMatchObject({ total: null, knownSubtotal: null });
    expect(usageFor(s.usage, 'cost_usd', { taskId: 'api' })).toMatchObject({ total: '1.24', provenance: 'estimated' });
    expect(usageFor(s.usage, 'input_tokens', { taskId: 'api' })).toMatchObject({ total: '120400', provenance: 'observed' });
    expect(s.usage.filter((u) => u.figure.provenance === 'unavailable').every((u) => u.figure.quantity === null)).toBe(true);
    expect(worker(s, 'runner_cloud_1').modelRoute).toBe('unknown');
    expect(s.assistant).toEqual({ mode: null, observedSource: 'unknown' });
    expect(s.tasks['batch']).toMatchObject({ status: 'cancelled', cancelReason: 'budget_exhausted' });
  });

  it('no data: an empty project is empty, not zero', async () => {
    const { s } = await snap('no-data');
    expect(isEmptyProject(s)).toBe(true);
    expect(s.meta.cursor).toBe('0');
    expect(s.usage).toEqual([]);
    expect(usageFor(s.usage, 'cost_usd').total).toBeNull();
  });

  it('streams the rest of a scenario as the virtual clock advances, through the projection session', async () => {
    const ds = make();
    const f = buildFixture('human-wait');
    const states: string[] = [];
    const session = startProjection(ds, f.projectId, { onState: (st) => states.push(st.snapshot.tasks['migrate']?.status ?? ''), onError: () => { throw new Error('unexpected'); } });
    await new Promise((r) => setTimeout(r, 0));
    ds.clock.advance(70_000); // approval granted at 150 s, task ready again at 152 s
    expect(session.state()!.snapshot.tasks['migrate']!.status).toBe('ready');
    expect(session.resyncCount()).toBe(0);
    session.stop();
    ds.disconnect();
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
