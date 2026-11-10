import { describe, expect, it, vi } from 'vitest';
import { checkEventAuthority } from '@selarikru/domain';
import { HandoversViewSchema, type ProjectViewEvent } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';

const setup = (id: string) => {
  const f = buildFixture(id as Parameters<typeof buildFixture>[0]);
  const clock = createSeededClock(fixtureTime(0));
  const ds = createMockDataSource({ clock });
  return { ds, clock, projectId: f.projectId };
};

describe('the demo handover', () => {
  it('fences the local attempt before a cloud attempt starts, through the events the services emit, and never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ds, clock, projectId } = setup('unknown-costs');
    const snap = await ds.getSnapshot(projectId);
    const events: ProjectViewEvent[] = [];
    ds.subscribe(projectId, snap.meta.cursor, (e) => events.push(e), () => undefined);
    let v = HandoversViewSchema.parse(await ds.getHandovers!(projectId));
    const api = v.tasks.find((t) => t.taskId === 'unknown-costs.api')!;
    expect(api.resume.eligible).toBe(true);
    expect(api.estimate.costUsd.provenance).toBe('estimated');
    expect(v.notice).toMatch(/Demo data/);

    v = await ds.handoverAction!(projectId, { kind: 'request', taskId: 'unknown-costs.api', mode: 'resume', idempotencyKey: 'k1' });
    expect(v.tasks.find((t) => t.taskId === 'unknown-costs.api')!.current).toMatchObject({ state: 'stopping', stateLabel: 'Stopping local attempt' });
    clock.advance(2_500);
    const review = (await ds.getHandovers!(projectId)).tasks.find((t) => t.taskId === 'unknown-costs.api')!.current!;
    expect(review).toMatchObject({ state: 'awaiting_review', exclusions: [{ path: '.env', reason: 'secret_file_name' }, { path: 'notes/scratch.md', reason: 'outside_allowed_paths' }] });
    expect(review.patch!.files[0]).toMatchObject({ hasDiff: true, added: 2 });
    expect((await ds.getHandoverDiff!(projectId, 'unknown-costs.api', review.checkpointId, review.patch!.files[0]!.path)).lines!.length).toBeGreaterThan(0);
    // Nothing starts until the owner releases it.
    clock.advance(10_000);
    expect((await ds.getHandovers!(projectId)).records[0]!.state).toBe('awaiting_review');
    await ds.handoverAction!(projectId, { kind: 'decide', taskId: 'unknown-costs.api', checkpointId: review.checkpointId, choice: 'release', idempotencyKey: 'r1' });
    expect((await ds.getHandovers!(projectId)).records[0]!.state).toBe('fenced');
    clock.advance(2_000);
    expect((await ds.getHandovers!(projectId)).tasks.find((t) => t.taskId === 'unknown-costs.api')!.current!.state).toBe('starting');
    clock.advance(2_000);
    expect((await ds.getHandovers!(projectId)).records[0]!).toMatchObject({ state: 'running', contentDropped: { reason: 'successor_running' } });

    const types = events.map((e) => e.type);
    expect(types.indexOf('attempt.fenced')).toBeLessThan(types.indexOf('attempt.started'));
    for (const e of events) expect(checkEventAuthority({ ...e, provenance: undefined } as never).ok, e.type).toBe(true);
    const now = await ds.getSnapshot(projectId);
    const task = now.tasks['unknown-costs.api']!;
    expect(task.status).toBe('running');
    expect(Object.values(now.workers).find((w) => w.attemptId === task.activeAttemptId)!.execution).toBe('cloud');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a checkpoint that cannot be carried whole offers a restart, which the owner may take', async () => {
    const { ds, clock, projectId } = setup('policy-block');
    await ds.handoverAction!(projectId, { kind: 'request', taskId: 'policy-block.lint', mode: 'resume', idempotencyKey: 'k1' });
    clock.advance(2_500);
    let rec = (await ds.getHandovers!(projectId)).records[0]!;
    expect(rec).toMatchObject({ state: 'restart_offered', refusal: { code: 'required_file_excluded' } });
    expect(rec.estimate!.costUsd.provenance).toBe('estimated');
    await expect(ds.handoverAction!(projectId, { kind: 'request', taskId: 'policy-block.lint', mode: 'resume', idempotencyKey: 'k2' })).rejects.toThrow(/already in progress/);
    await ds.handoverAction!(projectId, { kind: 'decide', taskId: 'policy-block.lint', checkpointId: rec.checkpointId, choice: 'restart', idempotencyKey: 'd1' });
    clock.advance(6_000);
    rec = (await ds.getHandovers!(projectId)).records[0]!;
    expect(rec).toMatchObject({ state: 'running', mode: 'restart', patch: null });
  });

  it('a task running on a cloud runner is not offered a move', async () => {
    const { ds, projectId } = setup('unknown-costs');
    const web = (await ds.getHandovers!(projectId)).tasks.find((t) => t.taskId === 'unknown-costs.web');
    expect(web === undefined || !web.resume.eligible).toBe(true);
  });
});
