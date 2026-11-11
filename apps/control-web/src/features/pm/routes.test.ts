import { describe, expect, it } from 'vitest';
import { snapshotOf, task } from '../overview/testing.ts';
import { planRouteProposals, routeTargets } from './routes.ts';

const route = (lock: unknown = null) => ({ effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 2, lock, suggestion: null, lastObserved: null }) as never;
const snap = () => snapshotOf({ tasks: [task('t1', { route: route() }), task('t2', { route: route({ label: 'restricted', reason: 'r' }) })] });
const BROWSER = { online: true, cloudBudgetAvailable: null, nanoBudgetChars: 6000 };

describe('the PM\'s route per task (H12)', () => {
  it('proposes a route per plan task with its reason, from suggestRoute\'s inputs: the task\'s label (its lock, or the subject\'s for a new task), offline, the budget', () => {
    const plan = [{ key: 'T1', revises: 't1' }, { key: 'T2', revises: 't2' }, { key: 'T3' }];
    const routes = planRouteProposals(plan, snap(), 'internal', BROWSER);
    expect(routes.map((r) => [r.key, r.mode, r.locked])).toEqual([['T1', 'PREFER_ON_DEVICE', false], ['T2', 'ONLY_ON_DEVICE', true], ['T3', 'PREFER_ON_DEVICE', false]]);
    expect(routes[1]!.reason).toMatch(/restricted/);
    expect(planRouteProposals([{ key: 'T3' }], snap(), 'restricted', BROWSER)[0]).toMatchObject({ mode: 'ONLY_ON_DEVICE', locked: true });
    expect(planRouteProposals([{ key: 'T3' }], snap(), 'internal', { ...BROWSER, online: false })[0]).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'offline' });
  });

  it('after the plan is accepted, each route goes to its task: a revised task by its id, a new one by the ids the accept returned, in order; a locked one is not sent', () => {
    const plan = [{ key: 'T1', revises: 't1' }, { key: 'T2', revises: 't2' }, { key: 'T3' }, { key: 'T4' }];
    const routes = planRouteProposals(plan, snap(), 'internal', BROWSER);
    expect(routeTargets(plan, routes, ['t1', 't2', 'new-3', 'new-4'], snap())).toEqual([
      { taskId: 't1', mode: 'PREFER_ON_DEVICE', overrideRevision: 2 }, { taskId: 'new-3', mode: 'PREFER_ON_DEVICE', overrideRevision: 0 }, { taskId: 'new-4', mode: 'PREFER_ON_DEVICE', overrideRevision: 0 },
    ]);
  });
});

describe('fix 1 (I5): a PM route proposal never widens a route', () => {
  const routeOf = (effective: string, lock: unknown = null) => ({ effective, source: 'run', runDefault: effective, override: null, overrideRevision: 0, lock, suggestion: null, lastObserved: null }) as never;
  const runWith = (value: string | null) => {
    const s = snapshotOf({ tasks: [task('t1', { route: routeOf('ONLY_ON_DEVICE') }), task('t2', { route: routeOf('PREFER_ON_DEVICE') })] });
    return { ...s, runs: { run: { ...s.runs['run']!, routePolicy: { value, origin: 'owner', revision: 1 } as never } } };
  };

  it('a run default of Device only is not widened, for a revised task or a new one; each says "now X → proposed Y"', () => {
    const routes = planRouteProposals([{ key: 'T1', revises: 't1' }, { key: 'T2' }], runWith('ONLY_ON_DEVICE'), 'internal', BROWSER, 'run');
    expect(routes.map((r) => [r.key, r.mode])).toEqual([['T1', 'ONLY_ON_DEVICE'], ['T2', 'ONLY_ON_DEVICE']]);
    expect(routes[0]!.change).toBe('now Local only → proposed Local only');
  });

  it('a Local first task is not proposed the cloud, even for a long input; it may be narrowed', () => {
    const routes = planRouteProposals([{ key: 'T1', revises: 't2' }], runWith('PREFER_IN_CLOUD'), 'internal', { ...BROWSER, online: false }, 'run');
    expect(routes[0]).toMatchObject({ mode: 'ONLY_ON_DEVICE', change: 'now Local first → proposed Local only' });
    const wide = planRouteProposals([{ key: 'T1', revises: 't2' }], runWith('PREFER_IN_CLOUD'), 'internal', { ...BROWSER, nanoBudgetChars: 1 }, 'run');
    expect(wide[0]!.mode).toBe('PREFER_ON_DEVICE');
  });

  it('what is applied is exactly what was shown', () => {
    const plan = [{ key: 'T1', revises: 't2' }, { key: 'T2' }];
    const shown = planRouteProposals(plan, runWith('PREFER_IN_CLOUD'), 'internal', BROWSER, 'run');
    const applied = routeTargets(plan, shown, ['t2', 'new-2'], runWith('PREFER_IN_CLOUD'));
    expect(applied.map((a) => a.mode)).toEqual(shown.filter((r) => !r.locked).map((r) => r.mode));
  });
});
