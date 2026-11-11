import { describe, expect, it } from 'vitest';
import { snapshotOf } from '../overview/testing.ts';
import { workerIdentity } from './identity.ts';

const setting = (key: string, field: string, desired: unknown, effective: unknown = desired) => ({
  scope: 'runner', key, field, desired, effective, desiredRevision: 1, effectiveRevision: effective === desired ? 1 : 0, enforcer: 'server', state: effective === desired ? 'applied' : 'applying', updatedBy: 'o', updatedAt: '2026-11-11T00:00:00Z', appliedAt: null,
});

describe('a worker\'s name and role (H11)', () => {
  it('shows "<Name> · <Role>", the name first, from the worker\'s settings', () => {
    const s = snapshotOf({});
    s.settings = [setting('w1', 'display_name', 'Aisyah'), setting('w1', 'role', 'backend')] as never;
    expect(workerIdentity(s, 'w1', 'frontend')).toEqual({ name: 'Aisyah', role: 'backend', label: 'Aisyah · Backend', roleLabel: 'Backend' });
  });

  it('falls back to the role label without a name, and to the task\'s role without a role setting', () => {
    const s = snapshotOf({});
    expect(workerIdentity(s, 'w1', 'frontend')).toEqual({ name: null, role: 'frontend', label: 'Frontend', roleLabel: 'Frontend' });
    expect(workerIdentity(s, 'w1', null)).toMatchObject({ label: 'Worker' });
  });

  it('a role change shows what is in force (effective) until the next claim takes the new one; the name is in force at once', () => {
    const s = snapshotOf({});
    s.settings = [setting('w1', 'role', 'tests', 'backend')] as never;
    expect(workerIdentity(s, 'w1', null)).toMatchObject({ role: 'backend', pendingRole: 'tests' });
  });
});
