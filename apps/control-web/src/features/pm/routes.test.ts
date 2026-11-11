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
