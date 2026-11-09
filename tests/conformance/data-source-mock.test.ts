import { buildDemoFixtures, createMockDataSource, createSeededClock, fixtureTime } from '@selarikru/data-source-mock';
import { dataSourceConformance } from './data-source.ts';

dataSourceConformance('mock over the ten named fixtures', async () => {
  const clock = createSeededClock(fixtureTime(0));
  // One fixture starts before its first plan.accepted, so the mock does not hide the empty-board case.
  const fixtures = buildDemoFixtures().map((f) => (f.id === 'healthy-parallel-work' ? { ...f, startSec: 0 } : f));
  const source = createMockDataSource({ clock, fixtures });
  return {
    source,
    busyProjectId: 'demo-unknown-costs',
    prePlanProjectId: 'demo-healthy-parallel-work',
    emptyProjectId: 'demo-no-data',
    pendingApprovalProjectId: 'demo-decision-queue',
    expiredApprovalProjectId: 'demo-expired-approval',
    budgetStopProjectId: 'demo-budget-stop',
    reverifyProjectId: 'demo-integration-blocked',
    reviewProjectId: 'demo-merge-review',
    failedProjectId: 'demo-failed-ci',
    unknownProjectId: 'demo-does-not-exist',
    clockFor: (projectId) => source.clockFor(projectId),
    async advance() {
      clock.advance(60_000);
    },
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
    async cleanup() {},
  };
});
