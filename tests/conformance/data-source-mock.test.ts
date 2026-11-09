import { createMockDataSource, createSeededClock, fixtureTime } from '@selarikru/data-source-mock';
import { dataSourceConformance } from './data-source.ts';

dataSourceConformance('mock over the ten named fixtures', async () => {
  const clock = createSeededClock(fixtureTime(0));
  const source = createMockDataSource({ clock });
  return {
    source,
    busyProjectId: 'demo-unknown-costs',
    emptyProjectId: 'demo-no-data',
    unknownProjectId: 'demo-does-not-exist',
    async advance() {
      clock.advance(60_000);
    },
    async cleanup() {},
  };
});
