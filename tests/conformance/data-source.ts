import { afterEach, describe, expect, it } from 'vitest';
import {
  DataSourceException, ProjectViewEventSchema, ProjectViewSnapshotSchema, TERMINAL_MAX_LINES, startProjection,
  type DataSourceError, type EngineeringDataSource, type ProjectViewEvent, type ProjectViewSnapshot,
} from '@selarikru/view-protocol';

export interface DataSourceUnderTest {
  readonly source: EngineeringDataSource;
  /** A project that has history and still has events to come after `advance()`. */
  readonly busyProjectId: string;
  /** A project with nothing in it; optional. */
  readonly emptyProjectId?: string;
  readonly unknownProjectId: string;
  /** A project whose first `plan.accepted` is still to come after `advance()`; optional. */
  readonly prePlanProjectId?: string;
  /** The project's own clock, for a session's liveness stamps. A live source passes `{ nowMs: () => Date.now() }`. */
  clockFor(projectId: string): { nowMs(): number };
  /** Makes the next batch of events available (the mock moves its virtual clock; a live fixture server writes events). */
  advance(): Promise<void>;
  cleanup(): Promise<void>;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/**
 * What both a real snapshot and a fold of events can state. Checked against `GET /v1/projects/:id/snapshot` in apps/control-api/src/routes-owner.ts:
 * it returns, per task, status, revision (currentRevision), aggregateRevision (rowRevision), the attempts of the current revision with their
 * outcome, and `cancel` (a cancel request); per run, lifecycle. It does not return statusReason, latestEvidence, enteredStatusAt, enteredStateAt,
 * run evidence, checks, resolved approvals (only pending ones), workers, an explicit activeAttemptId (derivable as the attempt that has not ended)
 * or a cancel reason. So only these fields are compared, and `activeAttemptId` is taken as the attempt that is running and has not ended.
 */
const comparable = (s: ProjectViewSnapshot) => ({
  runs: Object.fromEntries(Object.entries(s.runs).map(([id, r]) => [id, { lifecycle: r.lifecycle }])),
  tasks: Object.fromEntries(
    Object.entries(s.tasks).map(([id, t]) => [id, {
      status: t.status, revision: t.revision, aggregateRevision: t.aggregateRevision, activeAttemptId: t.activeAttemptId, cancelRequested: t.cancelRequested !== null,
    }]),
  ),
  attempts: Object.fromEntries(Object.entries(s.attempts).map(([id, a]) => [id, { outcome: a.outcome }])),
});

/**
 * EngineeringDataSource conformance: schema-valid snapshots, snapshot and replay agree, ordered gapless events, safe unsubscribe, commands that
 * separate acceptance from execution, idempotency, bounded terminals and a clean disconnect. The mock and the live source both run this unchanged.
 */
export function dataSourceConformance(name: string, make: () => Promise<DataSourceUnderTest>): void {
  describe(`EngineeringDataSource conformance: ${name}`, () => {
    let current: DataSourceUnderTest | null = null;
    afterEach(async () => {
      if (current) {
        current.source.disconnect();
        await current.cleanup();
      }
      current = null;
    });
    const setup = async (): Promise<DataSourceUnderTest> => (current = await make());

    function collect(ds: DataSourceUnderTest, projectId: string, after: string): { events: ProjectViewEvent[]; errors: DataSourceError[]; stop: () => void } {
      const events: ProjectViewEvent[] = [];
      const errors: DataSourceError[] = [];
      const stop = ds.source.subscribe(projectId, after, (e) => events.push(e), (e) => errors.push(e));
      return { events, errors, stop };
    }

    it('states its mode, and a mock labels everything it returns as simulated', async () => {
      const ds = await setup();
      expect(['mock', 'live']).toContain(ds.source.mode);
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      expect(snap.meta.provenance).toBe(ds.source.mode === 'mock' ? 'simulated' : 'observed');
    });

    it('getSnapshot returns a schema-valid snapshot with a numeric cursor and the project id', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      expect(ProjectViewSnapshotSchema.safeParse(snap).success).toBe(true);
      expect(snap.meta.projectId).toBe(ds.busyProjectId);
      expect(snap.meta.cursor).toMatch(/^\d+$/);
      expect(Object.keys(snap.tasks).length).toBeGreaterThan(0);
    });

    it('an unknown project is a typed unknown_project error, not an empty snapshot', async () => {
      const ds = await setup();
      const err = await ds.source.getSnapshot(ds.unknownProjectId).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(DataSourceException);
      expect((err as DataSourceException).detail.code).toBe('unknown_project');
      const c = collect(ds, ds.unknownProjectId, '0');
      await tick();
      expect(c.errors.map((e) => e.code)).toEqual(['unknown_project']);
      c.stop();
    });

    it('replay from cursor 0 is ordered, gapless and valid', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const c = collect(ds, ds.busyProjectId, '0');
      await tick();
      expect(c.errors).toEqual([]);
      expect(c.events.length).toBe(Number(snap.meta.cursor));
      c.events.forEach((e, i) => {
        expect(ProjectViewEventSchema.safeParse(e).success).toBe(true);
        expect(e.sequence).toBe(i + 1);
        expect(e.provenance).toBe(snap.meta.provenance);
        expect(e.type).not.toBe('attempt.heartbeat'); // liveness is carried by snapshots
      });
      c.stop();
    });

    it('a session that follows the stream (resyncing when asked) converges on a fresh snapshot, on event-derived fields', async () => {
      const ds = await setup();
      const session = startProjection(ds.source, ds.busyProjectId, { onState: () => {}, onError: (e) => { throw new Error(e.message); } }, { refreshMs: 0, every: () => () => {}, clock: ds.clockFor(ds.busyProjectId) });
      await tick();
      await ds.advance();
      for (let i = 0; i < 5; i += 1) await tick();
      const fresh = await ds.source.getSnapshot(ds.busyProjectId);
      const mine = session.state()!.snapshot;
      expect(mine.meta.cursor).toBe(fresh.meta.cursor);
      expect(comparable(mine)).toEqual(comparable(fresh));
      session.stop();
    });

    it('subscribing after the snapshot cursor delivers only later events, in order, as they happen', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const c = collect(ds, ds.busyProjectId, snap.meta.cursor);
      await tick();
      expect(c.events).toEqual([]); // nothing is replayed that the snapshot already holds
      await ds.advance();
      await tick();
      expect(c.events.length).toBeGreaterThan(0);
      const first = Number(snap.meta.cursor) + 1;
      c.events.forEach((e, i) => expect(e.sequence).toBe(first + i));
      c.stop();
    });

    it('unsubscribe stops delivery', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const c = collect(ds, ds.busyProjectId, snap.meta.cursor);
      await tick();
      c.stop();
      await ds.advance();
      await tick();
      expect(c.events).toEqual([]);
    });

    it('a cursor that is not in the stream is an invalid_cursor error', async () => {
      const ds = await setup();
      for (const bad of ['not-a-cursor', '999999999']) {
        const c = collect(ds, ds.busyProjectId, bad);
        await tick();
        expect(c.errors.map((e) => e.code), bad).toEqual(['invalid_cursor']);
        expect(c.events).toEqual([]);
        c.stop();
      }
    });

    it('execute separates acceptance from execution, rejects stale revisions and invalid commands, and replays idempotently', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const task = Object.values(snap.tasks).find((t) => t.status === 'running');
      expect(task, 'the busy project has a running task').toBeDefined();
      const t = task!;

      const stale = await ds.source.execute({ command: 'task.cancel', expectedRevision: t.aggregateRevision + 7, idempotencyKey: 'k-stale', args: { taskId: t.taskId } });
      expect(stale).toMatchObject({ accepted: false, execution: 'rejected', rejection: 'stale_revision' });

      const bad = await ds.source.execute({ command: 'task.cancel', idempotencyKey: 'k-bad' } as never);
      expect(bad).toMatchObject({ accepted: false, execution: 'rejected', rejection: 'invalid_command' });

      const first = await ds.source.execute({ command: 'task.cancel', expectedRevision: t.aggregateRevision, idempotencyKey: 'k-cancel', args: { taskId: t.taskId } });
      expect(first.accepted).toBe(true);
      expect(first.execution).not.toBe('applied'); // a cancel is requested, not yet confirmed
      expect(first.replayed).toBe(false);
      const again = await ds.source.execute({ command: 'task.cancel', expectedRevision: t.aggregateRevision, idempotencyKey: 'k-cancel', args: { taskId: t.taskId } });
      expect(again).toMatchObject({ operationId: first.operationId, accepted: true, replayed: true });
    });

    it('an accepted cancel shows up as events: requested first, then confirmed', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const t = Object.values(snap.tasks).find((x) => x.status === 'running')!;
      const c = collect(ds, ds.busyProjectId, snap.meta.cursor);
      await ds.source.execute({ command: 'task.cancel', expectedRevision: t.aggregateRevision, idempotencyKey: 'k-evt', args: { taskId: t.taskId } });
      await ds.advance();
      await tick();
      const types = c.events.filter((e) => e.taskId === t.taskId).map((e) => e.type);
      expect(types.indexOf('task.cancel_requested')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('task.cancelled')).toBeGreaterThan(types.indexOf('task.cancel_requested'));
      c.stop();
    });

    it('openTerminal returns a bounded, closable channel for a known attempt and refuses an unknown one', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const attempt = Object.values(snap.attempts)[0]!;
      const ch = await ds.source.openTerminal({ taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: 0 });
      const lines: string[] = [];
      ch.onLine((l) => lines.push(l));
      await tick();
      expect(lines.length).toBeLessThanOrEqual(TERMINAL_MAX_LINES);
      ch.close();
      await expect(ds.source.openTerminal({ taskId: attempt.taskId, attemptId: 'no-such-attempt', expectedRevision: 0 })).rejects.toBeInstanceOf(DataSourceException);
    });

    it('a session that starts before the first plan fills the board after it, and agrees with a fresh snapshot', async () => {
      const ds = await setup();
      if (!ds.prePlanProjectId) return;
      const pid = ds.prePlanProjectId;
      const session = startProjection(ds.source, pid, { onState: () => {}, onError: (e) => { throw new Error(e.message); } }, { refreshMs: 0, every: () => () => {}, clock: ds.clockFor(pid) });
      await tick();
      expect(Object.keys(session.state()!.snapshot.tasks)).toEqual([]);
      await ds.advance();
      for (let i = 0; i < 5; i += 1) await tick();
      const fresh = await ds.source.getSnapshot(pid);
      expect(Object.keys(fresh.tasks).length).toBeGreaterThan(0);
      expect(comparable(session.state()!.snapshot)).toEqual(comparable(fresh));
      session.stop();
    });

    it('an empty project reads as empty', async () => {
      const ds = await setup();
      if (!ds.emptyProjectId) return;
      const snap = await ds.source.getSnapshot(ds.emptyProjectId);
      expect(ProjectViewSnapshotSchema.safeParse(snap).success).toBe(true);
      expect(snap.meta.cursor).toBe('0');
      expect(Object.keys(snap.tasks)).toEqual([]);
      expect(snap.usage).toEqual([]);
    });

    it('disconnect ends delivery and later calls fail with a typed error', async () => {
      const ds = await setup();
      const snap = await ds.source.getSnapshot(ds.busyProjectId);
      const c = collect(ds, ds.busyProjectId, snap.meta.cursor);
      await tick();
      ds.source.disconnect();
      await ds.advance();
      await tick();
      expect(c.events).toEqual([]);
      const err = await ds.source.getSnapshot(ds.busyProjectId).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(DataSourceException);
      expect((err as DataSourceException).detail.code).toBe('disconnected');
    });
  });
}
