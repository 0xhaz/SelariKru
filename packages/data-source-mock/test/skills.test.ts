import { describe, expect, it, vi } from 'vitest';
import { SKILL_LIBRARY } from '@selarikru/domain';
import { AttemptSkillsViewSchema, SkillsViewSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';

const setup = () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const fixture = buildFixture('healthy-parallel-work');
  return { ds, projectId: fixture.projectId };
};

describe('the demo skill library', () => {
  it('lists the real first-party packs, stages a fixture pack through the domain scan, requires review before binding, and delivers it to an attempt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ds, projectId } = setup();
    const first = SkillsViewSchema.parse(await ds.getSkills!(projectId));
    expect(first.catalog.filter((c) => c.origin === 'first_party').map((c) => c.digest)).toEqual(SKILL_LIBRARY.map((v) => v.digest));
    const staged = SkillsViewSchema.parse(await ds.skillAction!(projectId, { kind: 'intake', path: '/home/me/packs/team-notes' }));
    const pack = staged.catalog.find((c) => c.origin === 'third_party')!;
    expect(pack.states).toEqual(['available']);
    expect(pack.scan!.egressHosts).toEqual(['example.com']);
    await expect(ds.skillAction!(projectId, { kind: 'bind', skillId: pack.skillId, expectedRevision: 0, binding: { versionId: pack.versionId, roles: [], paths: [] } })).rejects.toThrow(/reviewed/);
    await expect(ds.skillAction!(projectId, { kind: 'review', versionId: pack.versionId, acknowledgeFindings: false })).rejects.toThrow(/Acknowledge/);
    await ds.skillAction!(projectId, { kind: 'review', versionId: pack.versionId, acknowledgeFindings: true });
    await expect(ds.skillAction!(projectId, { kind: 'bind', skillId: pack.skillId, expectedRevision: 0, binding: { versionId: pack.versionId, roles: [], paths: [] } })).rejects.toThrow(/at least one role or path/);
    const snap = await ds.getSnapshot(projectId);
    const running = Object.values(snap.attempts).find((a) => a.outcome === 'running')!;
    const attemptId = running.attemptId;
    const role = snap.tasks[running.taskId]!.role!;
    await ds.skillAction!(projectId, { kind: 'bind', skillId: pack.skillId, expectedRevision: 0, binding: { versionId: pack.versionId, roles: [role], paths: [] } });
    expect((await ds.getSkills!(projectId)).history.map((h) => h.kind)).toEqual(['intake', 'review', 'bind']);
    const att = AttemptSkillsViewSchema.parse(await ds.getAttemptSkills!(projectId, attemptId));
    expect(att.record!.delivered.map((d) => d.versionId)).toEqual([pack.versionId]);
    expect(att.confirmedAt).toEqual(expect.any(String));
    // Revoked afterwards: the attempt keeps it and is marked.
    await ds.skillAction!(projectId, { kind: 'revoke', versionId: pack.versionId, reason: 'demo' });
    expect((await ds.getAttemptSkills!(projectId, attemptId)).revoked).toEqual([pack.versionId]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a path naming a setup script stages a Blocked pack that cannot be reviewed', async () => {
    const { ds, projectId } = setup();
    const v = await ds.skillAction!(projectId, { kind: 'intake', path: '/tmp/quick-setup' });
    const pack = v.catalog.find((c) => c.origin === 'third_party')!;
    expect(pack.states).toEqual(['blocked']);
    expect(pack.scan!.findings.some((f) => f.kind === 'script')).toBe(true);
    await expect(ds.skillAction!(projectId, { kind: 'review', versionId: pack.versionId, acknowledgeFindings: true })).rejects.toThrow(/blocked/);
  });
});
