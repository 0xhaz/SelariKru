import { describe, expect, it, vi } from 'vitest';
import { StackViewSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';
import { createDemoStack } from '../src/stack.ts';

const setup = () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  return { ds, projectId: buildFixture('healthy-parallel-work').projectId };
};

describe('the demo stack settings', () => {
  it('starts with the repository root undecided and a detection of the Feedback Board starter, computed by the domain detector', async () => {
    const { ds, projectId } = setup();
    const view = StackViewSchema.parse(await ds.getStack!(projectId));
    expect(view.revision).toBe(0);
    expect(view.document.components.map((c) => c.path)).toEqual(['.']);
    expect(Object.values(view.document.components[0]!.categories).every((s) => s.state === 'not_decided')).toBe(true);
    const ids = view.document.detection!.items.map((i) => i.entryId);
    expect(ids).toEqual(expect.arrayContaining(['react', 'express', 'sqlite', 'vite', 'vitest', 'typescript', 'pnpm', 'nodejs']));
    expect(view.document.detection!.items.every((i) => i.state === 'proposed')).toBe(true);
    expect(view.document.detection!.commands.map((c) => c.command)).toEqual(['pnpm run build', 'pnpm run test']);
    expect(view.native).toEqual({ ios: false, android: false });
  });

  it('applies an action against the revision it was read at, refuses a stale one, and touches no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ds, projectId } = setup();
    const next = await ds.stackAction!(projectId, { expectedRevision: 0, action: { kind: 'category.set', path: '.', category: 'payments', state: 'none' } });
    expect(next.revision).toBe(1);
    expect(next.document.components[0]!.categories.payments).toEqual({ state: 'none' });
    await expect(ds.stackAction!(projectId, { expectedRevision: 0, action: { kind: 'category.set', path: '.', category: 'auth', state: 'none' } })).rejects.toThrow(/changed/);
    const confirmed = await ds.stackAction!(projectId, { expectedRevision: 1, action: { kind: 'detection.confirm', detectionId: 'det:.:react' } });
    expect(confirmed.document.components[0]!.categories.frameworks).toMatchObject({ state: 'selected', items: [{ entryId: 'react', origin: 'detected' }] });
    await expect(ds.stackAction!(projectId, { expectedRevision: 2, action: { kind: 'item.add', path: '.', category: 'auth', item: { kind: 'catalog', entryId: 'stripe' } } })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('the demo stack store', () => {
  it('withholds detected items under a component marked restricted, the same way the server stores it', async () => {
    const stack = createDemoStack(() => '2026-11-10T00:00:00.000Z');
    const before = await stack.get('p1');
    expect(before.document.detection?.items.length ?? 0).toBeGreaterThan(0);
    const after = await stack.act('p1', {
      expectedRevision: before.revision,
      action: { kind: 'component.upsert', path: '.', name: 'Feedback Board', targets: ['web', 'server'], classification: 'restricted' },
    });
    expect(after.document.detection?.items ?? []).toHaveLength(0);
    expect(after.document.detection?.commands ?? []).toHaveLength(0);
    expect(after.document.detection?.withheld ?? 0).toBeGreaterThan(0);
  });
});
