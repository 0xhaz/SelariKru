export { createSeededClock, type VirtualClock } from './clock.ts';
export { mulberry32, seededId } from './prng.ts';
export { FIXTURE_T0_MS, fixtureTime, scoped, type Fixture, type FixtureId, type TaskSeed, type ApprovalSeed, type Silence } from './builder.ts';
export { FIXTURE_IDS, buildAllFixtures, buildFixture } from './fixtures.ts';
export { createMockDataSource, type MockDataSource, type MockOptions } from './source.ts';
import { createMockDataSource, type MockDataSource } from './source.ts';
import { createSeededClock } from './clock.ts';
import { FIXTURE_T0_MS } from './builder.ts';

/** The demo entry point: a mock over all ten fixtures with a fresh virtual clock at the fixture epoch. */
export function createDemoDataSource(): MockDataSource {
  return createMockDataSource({ clock: createSeededClock(new Date(FIXTURE_T0_MS).toISOString()) });
}
