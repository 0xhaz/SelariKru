import { describe, expect, it } from 'vitest';
import { citationResolves } from '@selarikru/domain';
import { AttemptContextViewSchema, BrainViewSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';

const setup = async () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('healthy-parallel-work');
  const snap = await ds.getSnapshot(f.projectId);
  return { ds, projectId: f.projectId, snap };
};

describe('the demo Project Brain', () => {
  it('compiles simulated sources with the domain compiler: cited claims, a disputed criterion and an open conflict', async () => {
    const { ds, projectId } = await setup();
    const brain = BrainViewSchema.parse(await ds.getBrain!(projectId));
    const claims = brain.compilation!.pages.flatMap((p) => p.claims);
    expect(claims.find((c) => c.key === 'criterion:FB-03')).toMatchObject({ status: 'disputed' });
    expect(brain.conflicts).toEqual([expect.objectContaining({ key: 'criterion:FB-03', state: 'open' })]);
    for (const c of claims) {
      for (const cite of c.citations) {
        const rev = await ds.getBrainSource!(projectId, cite.sourceId, cite.revision);
        expect(citationResolves(cite, [rev])).toBe(true);
      }
    }
  });

  it('records each attempt\'s bundle once, and a revocation shows in the next attempt\'s bundle', async () => {
    const { ds, projectId, snap } = await setup();
    const [first, second] = Object.keys(snap.attempts);
    const before = AttemptContextViewSchema.parse(await ds.getAttemptContext!(projectId, first!));
    expect(before.bundle.claims.length).toBeGreaterThan(0);
    expect(before.bundle.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'out_of_scope' })]));
    const after = await ds.brainAction!(projectId, { kind: 'revoke', sourceId: `criteria:${projectId}`, reason: 'demo' });
    expect(after.compilation!.pages.flatMap((p) => p.claims).find((c) => c.key === 'criterion:FB-01')!.status).toBe('unsupported');
    expect(await ds.getAttemptContext!(projectId, first!)).toEqual(before);
    const next = (await ds.getAttemptContext!(projectId, second!))!;
    expect(next.bundle.omissions).toContainEqual({ kind: 'source', id: `criteria:${projectId}`, reason: 'revoked' });
    await expect(ds.brainAction!(projectId, { kind: 'revoke', sourceId: `criteria:${projectId}`, reason: 'again' })).rejects.toThrow();
    expect(await ds.getAttemptContext!(projectId, 'no-such-attempt')).toBeNull();
  });

  it('keeping the accepted value settles the conflict', async () => {
    const { ds, projectId } = await setup();
    const conflictId = (await ds.getBrain!(projectId)).conflicts[0]!.conflictId;
    const kept = await ds.brainAction!(projectId, { kind: 'keep', conflictId });
    expect(kept.conflicts).toEqual([expect.objectContaining({ conflictId, state: 'kept_accepted' })]);
    expect(kept.compilation!.pages.flatMap((p) => p.claims).find((c) => c.key === 'criterion:FB-03')!.status).toBe('current');
  });
});
