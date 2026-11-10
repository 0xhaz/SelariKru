import { describe, expect, it } from 'vitest';
import { SKILL_LIBRARY } from '@selarikru/domain';
import type { SkillCatalogEntryView } from '@selarikru/view-protocol';
import { attemptPackRows, packRow } from './model.ts';

const v = SKILL_LIBRARY[0]!;
const entry = (over: Partial<SkillCatalogEntryView> = {}): SkillCatalogEntryView => ({
  versionId: v.versionId, skillId: v.skillId, name: v.name, version: v.version, description: v.description, origin: 'first_party', scope: 'platform', digest: v.digest, files: v.files,
  license: v.license, source: v.source, triggers: v.triggers, tools: v.tools, classification: 'public', states: ['reviewed'], review: { by: 'platform', at: null }, revocation: null, scan: null, enabledFor: [], evaluations: [], ...over,
});

describe('pack rows', () => {
  it('every state is its own chip with its own words, and only reviewed unbound versions offer binding', () => {
    const r = packRow(entry({ states: ['reviewed', 'tested_here', 'enabled_for_task'], enabledFor: [{ taskId: 't1', attemptId: 'a1' }] }), []);
    expect(r.states.map((s) => s.label)).toEqual(['Reviewed', 'Tested here', 'Enabled for this task']);
    expect(r.canBind).toBe(true);
    expect(r.canReview).toBe(false);
    expect(r.enabledFor).toBe('t1');
    expect(r.source).toMatch(/^This repository, packages\/domain\/skill-library\/.* at commit [0-9a-f]{12}$/);
    const bound = packRow(entry(), [{ skillId: v.skillId, desired: { versionId: v.versionId, roles: ['backend'], paths: [] }, effective: null, desiredRevision: 2, effectiveRevision: 2, state: 'applied', updatedBy: 'o', updatedAt: '' }]);
    expect(bound.binding).toBe('Bound at revision 2, only for roles backend · in force');
    expect(bound.canBind).toBe(false);
    expect(packRow(entry({ states: ['available'], origin: 'third_party' }), []).canBind).toBe(false);
    expect(packRow(entry({ states: ['blocked'], origin: 'third_party' }), []).canReview).toBe(false);
    expect(packRow(entry({ states: ['revoked'] }), []).canRevoke).toBe(false);
  });
});

describe('attempt pack rows', () => {
  it('lists what was delivered with its digest, and marks a version revoked since', () => {
    const d = { skillId: v.skillId, versionId: v.versionId, name: v.name, version: v.version, digest: v.digest, origin: 'first_party' as const, scope: 'platform' as const, classification: 'public' as const, dir: `.claude/skills/${v.skillId}` };
    const m = attemptPackRows({ attemptId: 'a', revoked: [v.versionId], record: { attemptId: 'a', taskId: 't', revision: 1, destination: 'local', harness: 'claude-code', delivered: [d], omitted: [{ skillId: 'x', versionId: 'x@1', reason: 'not_relevant:role' }], context: { entries: [], actions: [] }, recordedAt: '2026-11-10T00:00:00.000Z' } })!;
    expect(m.packs).toEqual([{ versionId: v.versionId, title: `${v.name} ${v.version}`, digest: v.digest, dir: d.dir, revoked: true }]);
    expect(m.omitted[0]!.text).toBe('x@1: not relevant · role');
    expect(attemptPackRows({ attemptId: 'a', record: null, revoked: [] })).toBeNull();
  });
});
