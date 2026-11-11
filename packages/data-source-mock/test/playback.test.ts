import { describe, expect, it } from 'vitest';
import { createDemoDataSource } from '../src/index.ts';

/** H7 fix: the demo's playback loops when a project's script has nothing left, so the mock says how much is still to come. */
describe('pendingCount', () => {
  it('counts a project\'s scripted events still to come, and reaches zero once the clock has passed them all', () => {
    const mock = createDemoDataSource();
    const busy = mock.listProjects().map((p) => p.projectId).find((id) => mock.pendingCount(id) > 0)!;
    expect(busy).toBeDefined();
    const before = mock.pendingCount(busy);
    // The source releases events while a subscriber is attached.
    const off = mock.subscribe(busy, '0', () => undefined, () => undefined);
    for (let k = 0; k < 400 && mock.pendingCount(busy) > 0; k++) mock.clock.advance(60_000);
    off();
    expect(before).toBeGreaterThan(0);
    expect(mock.pendingCount(busy)).toBe(0);
    expect(mock.pendingCount('no-such-project')).toBe(0);
    mock.disconnect();
  });
});
