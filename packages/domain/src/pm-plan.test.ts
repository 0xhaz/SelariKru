import { describe, expect, it } from 'vitest';
import { mapPmPlan, planPath } from './index.ts';

const t = (over: Record<string, unknown> = {}) => ({ key: 'T1', title: 'x', description: 'x', role: 'backend', requirementIds: ['R1'], paths: ['src/api'], dependsOn: [], ...over });
const existing = [{ taskId: 'a', revision: 1, role: 'backend', locked: false, allowedPaths: ['src/api'] }];

describe('PM plan paths and roles (fix round 3, N3)', () => {
  it('normalises a path before the role check, refusing .., absolute, empty and reserved paths', () => {
    expect(planPath('src/api/')).toEqual({ path: 'src/api' });
    expect(planPath('./src/api')).toEqual({ path: 'src/api' });
    for (const p of ['src/api/../../infra/deploy', '/etc/passwd', '', 'src/./x', 'src//x']) expect(planPath(p), p).toEqual({ refused: 'path_invalid' });
    expect(planPath('src/.env')).toEqual({ refused: 'path_reserved' });
    const r = mapPmPlan([t({ revises: 'a', paths: ['src/api/../../infra/deploy'] })], existing, { newTaskId: (i) => `n${i}`, allowedPaths: ['src'] });
    expect(r).toEqual({ ok: false, reason: 'path_invalid', key: 'T1' });
  });

  it('a new task\'s role must be a project role when the roles are given', () => {
    expect(mapPmPlan([t({ role: 'designer' })], existing, { newTaskId: (i) => `n${i}`, allowedPaths: ['src'], projectRoles: ['backend'] })).toEqual({ ok: false, reason: 'role_unknown', key: 'T1' });
    expect(mapPmPlan([t()], existing, { newTaskId: (i) => `n${i}`, allowedPaths: ['src'], projectRoles: ['backend'] }).ok).toBe(true);
  });
});
