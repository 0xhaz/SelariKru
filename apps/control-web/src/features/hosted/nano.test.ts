import { describe, expect, it } from 'vitest';
import type { TaskRouteView } from '@selarikru/view-protocol';
import { snapshotOf, task } from '../overview/testing.ts';
import { nanoBanner } from './nano.ts';

const route = (effective: TaskRouteView['effective'], lock = false): TaskRouteView => ({
  effective, source: 'run', runDefault: effective, override: null, overrideRevision: 0, lock: lock ? { label: 'restricted', reason: 'r' } : null, suggestion: null, lastObserved: null,
}) as unknown as TaskRouteView;

const snap = snapshotOf({ tasks: [
  task('a', { title: 'Search index', route: route('PREFER_ON_DEVICE') }),
  task('b', { title: 'API contract', route: route('ONLY_IN_CLOUD') }),
  task('c', { title: 'Integration', route: route('ONLY_ON_DEVICE') }),
  task('d', { title: 'End-to-end checks', route: route('ONLY_ON_DEVICE', true) }),
  task('e', { title: 'Docs', route: route('PREFER_IN_CLOUD') }),
] });

describe('H9 item 3: an honest, calm state when Gemini Nano is unavailable', () => {
  it('says nothing when Nano is available', () => {
    expect(nanoBanner('available', snap)).toBeNull();
  });

  it('when it is not, says so and gives each route its consequence, naming the tasks: Local first goes to the cloud as a fallback; Local only and restricted block', () => {
    const b = nanoBanner('unavailable', snap)!;
    expect(b.title).toBe('Gemini Nano is not available in this browser');
    expect(b.lines).toEqual([
      { route: 'Local first → cloud', text: 'Runs in the cloud instead, labelled as a fallback: Search index.' },
      { route: 'Cloud first and Cloud only', text: 'Run in the cloud as usual: API contract, Docs.' },
      { route: 'Local only and restricted', text: 'Blocked until Gemini Nano is available, never sent to the cloud: Integration, End-to-end checks (restricted).' },
    ]);
    expect(b.href).toMatch(/^https:\/\/developer\.chrome\.com\//);
  });

  it('a model still downloading, or a check that could not tell, says that instead', () => {
    expect(nanoBanner('downloadable', snap)!.title).toBe('Gemini Nano is not downloaded in this browser yet');
    expect(nanoBanner('downloading', snap)!.title).toBe('Gemini Nano is still downloading in this browser');
    expect(nanoBanner('unknown', snap)!.title).toBe('This browser did not say whether Gemini Nano is available');
  });

  it('with no tasks yet, gives the rule for each route', () => {
    const b = nanoBanner('unavailable', null)!;
    expect(b.lines.map((l) => l.text)).toEqual(['Runs in the cloud instead, labelled as a fallback.', 'Run in the cloud as usual.', 'Blocked until Gemini Nano is available, never sent to the cloud.']);
  });
});
