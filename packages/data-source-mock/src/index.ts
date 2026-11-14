export { createSeededClock, type VirtualClock } from './clock.ts';
export { mulberry32, seededId } from './prng.ts';
export { FIXTURE_T0_MS, fixtureTime, scoped, type Fixture, type FixtureId, type TaskSeed, type ApprovalSeed, type Silence } from './builder.ts';
export { FIXTURE_IDS, EXTRA_FIXTURE_IDS, buildAllFixtures, buildDemoFixtures, buildFixture } from './fixtures.ts';
export { CLAUDE_DEMO } from './claude.ts';
export { demoPlanBriefNotes } from './plan-brief.ts';
export { createMockDataSource, demoMaxAttempts, demoNameFor, type MockDataSource, type MockOptions } from './source.ts';
import { createMockDataSource, type MockDataSource, type MockOptions } from './source.ts';
import { createSeededClock } from './clock.ts';
import { FIXTURE_T0_MS } from './builder.ts';

/** The demo entry point: a mock over all ten fixtures with a fresh virtual clock at the fixture epoch. */
export function createDemoDataSource(opts: { readonly isOffline?: () => boolean; readonly codingWorkers?: MockOptions['codingWorkers'] } = {}): MockDataSource {
  return createMockDataSource({ clock: createSeededClock(new Date(FIXTURE_T0_MS).toISOString()), ...(opts.isOffline ? { isOffline: opts.isOffline } : {}), ...(opts.codingWorkers ? { codingWorkers: opts.codingWorkers } : {}) });
}
