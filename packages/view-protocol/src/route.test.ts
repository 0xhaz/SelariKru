import { describe, expect, it } from 'vitest';
import type { RouteRecord } from '@selarikru/domain';
import {
  AuthorizedViewCommandSchema, ProjectViewSnapshotSchema, REJECTION_REASONS, RunViewSchema, SettingViewSchema, TaskRouteReadSchema, TaskRouteViewSchema, TaskViewSchema, applyEvent, emptySnapshot, projectionFromSnapshot,
  taskRouteLabel, type TaskRouteView, type TaskView,
} from './index.ts';

const AT = '2026-11-11T09:00:00.000Z';
const record = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  recordId: 'rpt_1', taskId: 't1', taskRevision: 1, requestId: 'req-1', stepKind: 'triage', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE',
  policySource: 'run', locked: false, observedSource: 'IN_CLOUD', fellBack: true, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' },
  timing: { totalMs: 900, firstOutputMs: null }, validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: AT, ...over,
});
const route = (over: Partial<TaskRouteView> = {}): TaskRouteView => ({
  effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null,
  suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'Local first: a patch step is short and bounded.', locked: false }, lastObserved: null, ...over,
});
const task = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1', runId: 'r1', revision: 1, aggregateRevision: 1, title: 't1', role: null, dependsOn: [], status: 'ready', statusReason: null, placementBlock: null,
  cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: AT, latestEvidence: null, ...over,
});

describe('task route view', () => {
  it('states the effective policy, its source, the lock, the suggestion and the last observed source', () => {
    expect(TaskViewSchema.safeParse(task({ route: route() })).success).toBe(true);
    expect(TaskViewSchema.safeParse(task()).success).toBe(true); // a source that does not report routes leaves it absent
    const locked = route({ effective: 'ONLY_ON_DEVICE', source: 'lock', override: 'ONLY_IN_CLOUD', lock: { label: 'restricted', reason: 'This task reads restricted data.' }, lastObserved: record({ observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified', locked: true }) });
    expect(TaskRouteViewSchema.safeParse(locked).success).toBe(true);
  });

  it('a lock must force device only: a view that says otherwise is refused', () => {
    expect(TaskRouteViewSchema.safeParse(route({ effective: 'PREFER_IN_CLOUD', lock: { label: 'restricted', reason: 'x' } })).success).toBe(false);
  });

  it('the run default is on the run, with where it came from', () => {
    const run = { runId: 'r1', lifecycle: 'running', planRevision: 1, latestEvidence: null };
    expect(RunViewSchema.safeParse({ ...run, routePolicy: { value: 'PREFER_ON_DEVICE', origin: 'onboarding', revision: 0 } }).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...run, routePolicy: { value: null, origin: 'unset', revision: 0 } }).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...run, routePolicy: { value: 'CLOUD', origin: 'setting', revision: 1 } }).success).toBe(false);
  });

  it('task settings are settings like any other', () => {
    expect(SettingViewSchema.safeParse({
      scope: 'task', key: 't1', field: 'route_override', desired: 'ONLY_IN_CLOUD', effective: 'ONLY_IN_CLOUD', desiredRevision: 1, effectiveRevision: 1, enforcer: 'server', state: 'applied', updatedBy: 'u', updatedAt: AT, appliedAt: AT,
    }).success).toBe(true);
  });

  it('labels a route in words, with the source and an unknown kept unknown', () => {
    expect(taskRouteLabel(route())).toEqual({ mode: 'Local first', source: 'run default', observed: null });
    expect(taskRouteLabel(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: { label: 'secret', reason: 'x' }, lastObserved: record({ observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified' }) })))
      .toEqual({ mode: 'Local only', source: 'locked: secret data', observed: 'Unknown (reported by the browser)' });
    expect(taskRouteLabel(route({ effective: null, source: 'unset' })).mode).toBe('Not set');
    expect(taskRouteLabel(route({ lastObserved: record() })).observed).toBe('Cloud, fell back (reported by the browser)');
  });
});

describe('route commands and events', () => {
  it('the browser reports a route record through a command; the lock refusal is named', () => {
    const report = {
      kind: 'route', requestId: 'req-1', stepKind: 'triage', callOverride: null, requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok',
      model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 5, firstOutputMs: null }, validation: 'passed', blockedReason: null,
    };
    expect(AuthorizedViewCommandSchema.safeParse({ command: 'route.report', idempotencyKey: 'k', expectedRevision: 0, args: { projectId: 'p1', taskId: 't1', report } }).success).toBe(true);
    expect(AuthorizedViewCommandSchema.safeParse({ command: 'route.report', idempotencyKey: 'k', expectedRevision: 0, args: { projectId: 'p1', taskId: 't1', report: { ...report, prompt: 'x' } } }).success).toBe(false);
    expect(AuthorizedViewCommandSchema.safeParse({ command: 'setting.set', idempotencyKey: 'k', expectedRevision: 0, args: { projectId: 'p1', key: 't1', change: { scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' } } }).success).toBe(true);
    expect(REJECTION_REASONS).toContain('route_locked_restricted');
  });

  it('an inference.reported event updates the last observed source of a task with a route', () => {
    const s = emptySnapshot({ projectId: 'p1', observedAt: AT, provenance: 'observed' });
    const state = projectionFromSnapshot(ProjectViewSnapshotSchema.parse({
      ...s, runs: { r1: { runId: 'r1', lifecycle: 'running', planRevision: 1, latestEvidence: null } }, tasks: { t1: task({ route: route() }) },
    }));
    const e = {
      schemaVersion: 1 as const, eventId: 'evt_1', projectId: 'p1', runId: 'r1', taskId: 't1', attemptId: null, type: 'inference.reported' as const, sequence: 1, aggregateRevision: 1,
      actor: { kind: 'human' as const, id: 'u' }, occurredAt: AT, receivedAt: AT, causationId: null, traceId: 'tr', payload: { revision: 1, record: record() }, provenance: 'observed' as const,
    };
    const r = applyEvent(state, e);
    expect(r.outcome).toBe('applied');
    expect(r.state.snapshot.tasks['t1']!.route!.lastObserved).toMatchObject({ observedSource: 'IN_CLOUD', fellBack: true });
    // A record that does not read leaves the view as it was.
    const bad = applyEvent(state, { ...e, payload: { revision: 1, record: { ...record(), prompt: 'x' } } });
    expect(bad.state.snapshot.tasks['t1']!.route!.lastObserved).toBeNull();
  });
});

describe('fresh task route reads', () => {
  it('a route read carries the route and the history; a locked override setting reads as locked', () => {
    expect(TaskRouteReadSchema.safeParse({ taskId: 't1', revision: 1, runId: 'r1', route: route(), records: [record()] }).success).toBe(true);
    expect(TaskRouteReadSchema.safeParse({ taskId: 't1', revision: 1, runId: 'r1', route: route(), records: [{ ...record(), prompt: 'x' }] }).success).toBe(false);
    expect(SettingViewSchema.safeParse({
      scope: 'task', key: 't1', field: 'route_override', desired: 'ONLY_IN_CLOUD', effective: 'ONLY_ON_DEVICE', desiredRevision: 1, effectiveRevision: 1, enforcer: 'server', state: 'locked', updatedBy: 'u', updatedAt: AT, appliedAt: AT,
    }).success).toBe(true);
  });

  it('a terminal task still takes its last observed source', () => {
    const s = emptySnapshot({ projectId: 'p1', observedAt: AT, provenance: 'observed' });
    const state = projectionFromSnapshot(ProjectViewSnapshotSchema.parse({
      ...s, runs: { r1: { runId: 'r1', lifecycle: 'running', planRevision: 1, latestEvidence: null } }, tasks: { t1: task({ status: 'merged', route: route() }) },
    }));
    const r = applyEvent(state, {
      schemaVersion: 1 as const, eventId: 'evt_2', projectId: 'p1', runId: 'r1', taskId: 't1', attemptId: null, type: 'inference.reported' as const, sequence: 1, aggregateRevision: 1,
      actor: { kind: 'human' as const, id: 'u' }, occurredAt: AT, receivedAt: AT, causationId: null, traceId: 'tr', payload: { revision: 1, record: record() }, provenance: 'observed' as const,
    });
    expect(r.state.snapshot.tasks['t1']!.route!.lastObserved).toMatchObject({ observedSource: 'IN_CLOUD' });
  });
});
