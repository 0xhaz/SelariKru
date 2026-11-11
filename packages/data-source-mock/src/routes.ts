import {
  DEFAULT_NANO_INPUT_BUDGET_CHARS, effectiveRoutePolicy, routeLockFor, routeOutcome, suggestRoute,
  type RoutePolicyMode, type RouteRecord, type RouteRecordReport, type RouteStepKind,
} from '@selarikru/domain';
import type { RunRoutePolicyView, SettingView, TaskRouteView } from '@selarikru/view-protocol';
import { fixtureTime } from './builder.ts';

/**
 * A fixture's route policy, as the server's rows would hold it: the run default (the onboarding choice), each task's labels and estimated input, and the route
 * records a browser reported. Task overrides are seeded as task settings, so the same setting path changes them. Simulated, like everything here.
 */
export interface FixtureRoutes {
  readonly runDefault: RoutePolicyMode | null;
  /** By scoped task id. A task not listed is `internal`, with no override and nothing observed. */
  readonly tasks: Readonly<Record<string, FixtureTaskRoute>>;
}
export interface FixtureTaskRoute {
  readonly label?: 'public' | 'internal' | 'restricted' | 'secret';
  readonly override?: RoutePolicyMode;
  readonly inputChars?: number | null;
  readonly observed?: { readonly sec: number; readonly stepKind: RouteStepKind; readonly source: RouteRecord['observedSource']; readonly totalMs: number };
  /**
   * H5 fix round 4: the demo of a restricted sibling's project-wide plan claim. The task's own label stays internal, but its device context serves that claim, so on a
   * device-only route its calls lock to the device and nothing they produce is accepted. The cloud context leaves the claim out.
   */
  readonly restrictedSiblingClaim?: string;
}

/** The demo's stand-in for a model id: what the pinned Firebase AI Logic cloud model would report. Never a real call. */
const DEMO_MODEL = { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' } as const;

export function runRouteDefaultOf(routes: FixtureRoutes, settings: readonly SettingView[], runId: string): RunRoutePolicyView {
  const saved = settings.find((s) => s.scope === 'run' && s.key === runId && s.field === 'route_policy');
  if (saved) return { value: saved.desired as RoutePolicyMode, origin: 'setting', revision: saved.desiredRevision };
  return routes.runDefault ? { value: routes.runDefault, origin: 'onboarding', revision: 0 } : { value: null, origin: 'unset', revision: 0 };
}

export const routeLockOf = (routes: FixtureRoutes, taskId: string) => routeLockFor([routes.tasks[taskId]?.label ?? 'internal']);

/** A route record built the way the server builds one: its effective mode, fallback and conformance come from the policy, not from the report. */
export function routeRecordOf(input: {
  readonly routes: FixtureRoutes; readonly settings: readonly SettingView[]; readonly runId: string; readonly taskId: string; readonly taskRevision: number; readonly recordId: string; readonly at: string;
  readonly report: Pick<RouteRecordReport, 'requestId' | 'stepKind' | 'callOverride' | 'requestedMode' | 'observedSource' | 'status' | 'model' | 'timing' | 'validation' | 'blockedReason'>;
}): RouteRecord {
  const { report } = input;
  const lock = routeLockOf(input.routes, input.taskId);
  const override = input.settings.find((s) => s.scope === 'task' && s.key === input.taskId && s.field === 'route_override');
  const effective = effectiveRoutePolicy({ call: report.callOverride, task: (override?.desired as RoutePolicyMode | null | undefined) ?? null, run: runRouteDefaultOf(input.routes, input.settings, input.runId).value, lock });
  const outcome = report.status === 'blocked' || report.status === 'error'
    ? { ...routeOutcome(effective.mode, 'UNKNOWN', report.requestedMode, lock !== null), fellBack: null }
    : routeOutcome(effective.mode, report.observedSource, report.requestedMode, lock !== null);
  return {
    recordId: input.recordId, taskId: input.taskId, taskRevision: input.taskRevision, requestId: report.requestId, stepKind: report.stepKind, callOverride: report.callOverride, requestedMode: report.requestedMode,
    effectiveMode: effective.mode, policySource: effective.source, locked: lock !== null, observedSource: report.observedSource, fellBack: outcome.fellBack, conformance: outcome.conformance, requestModeMismatch: outcome.requestModeMismatch,
    status: report.status, model: { ...report.model }, timing: { totalMs: Math.round(report.timing.totalMs), firstOutputMs: report.timing.firstOutputMs === null ? null : Math.round(report.timing.firstOutputMs) },
    validation: report.validation, blockedReason: report.blockedReason, reportedBy: 'browser', trust: 'untrusted', reportedAt: input.at,
  };
}

/** The fixture's own reports, as records: what the browser said before the demo's first snapshot. */
export function seededRouteRecords(routes: FixtureRoutes, settings: readonly SettingView[], runId: string): Map<string, RouteRecord[]> {
  const out = new Map<string, RouteRecord[]>();
  for (const [taskId, t] of Object.entries(routes.tasks)) {
    if (!t.observed) continue;
    const lock = routeLockOf(routes, taskId);
    const requested = effectiveRoutePolicy({ task: t.override ?? null, run: routes.runDefault, lock }).mode;
    out.set(taskId, [routeRecordOf({
      routes, settings, runId, taskId, taskRevision: 1, recordId: `${taskId}.route_1`, at: fixtureTime(t.observed.sec),
      report: { requestId: `${taskId}.req_1`, stepKind: t.observed.stepKind, callOverride: null, requestedMode: requested, observedSource: t.observed.source, status: 'ok', model: DEMO_MODEL, timing: { totalMs: t.observed.totalMs, firstOutputMs: null }, validation: 'passed', blockedReason: null },
    })]);
  }
  return out;
}

/**
 * The settings list as the server shows it: a task override the data lock overrides reads `locked`, in force as ONLY_ON_DEVICE, so the list never contradicts the
 * task's route. A saved ONLY_ON_DEVICE is not overridden.
 */
export function withRouteLocks(routes: FixtureRoutes, settings: readonly SettingView[]): SettingView[] {
  return settings.map((x) => x.scope === 'task' && x.field === 'route_override' && x.desired !== 'ONLY_ON_DEVICE' && routeLockOf(routes, x.key)
    ? { ...x, effective: 'ONLY_ON_DEVICE', state: 'locked' as const } : { ...x });
}

/** Task overrides as the task settings the real table would hold. */
export function seededRouteSettings(routes: FixtureRoutes, at: string): SettingView[] {
  return Object.entries(routes.tasks).flatMap(([taskId, t]) => t.override === undefined ? [] : [{
    scope: 'task' as const, key: taskId, field: 'route_override' as const, desired: t.override, effective: t.override, desiredRevision: 1, effectiveRevision: 1, enforcer: 'server' as const,
    state: 'applied' as const, updatedBy: 'demo-operator', updatedAt: at, appliedAt: at,
  }]);
}

export function taskRouteOf(routes: FixtureRoutes, settings: readonly SettingView[], runId: string, taskId: string, last: RouteRecord | undefined): TaskRouteView {
  const t = routes.tasks[taskId] ?? {};
  const lock = routeLockOf(routes, taskId);
  const saved = settings.find((s) => s.scope === 'task' && s.key === taskId && s.field === 'route_override');
  const override = (saved?.desired as RoutePolicyMode | null | undefined) ?? null;
  const runDefault = runRouteDefaultOf(routes, settings, runId).value;
  const effective = effectiveRoutePolicy({ task: override, run: runDefault, lock });
  return {
    effective: effective.mode, source: effective.source, runDefault, override, overrideRevision: saved?.desiredRevision ?? 0,
    lock: lock ? { label: lock.label, reason: lock.reason } : null,
    suggestion: suggestRoute({ label: t.label ?? 'internal', stepKind: 'patch', inputChars: t.inputChars ?? null }, { nanoBudgetChars: DEFAULT_NANO_INPUT_BUDGET_CHARS }),
    lastObserved: last ?? null,
  };
}
