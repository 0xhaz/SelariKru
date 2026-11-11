import { beforeEach, describe, expect, it } from 'vitest';
import { snapshotOf, task } from '../overview/testing.ts';
import { pmProposals, proposalRows } from './proposals.ts';

describe('the Project Manager\'s refused assignments wait in Action items (H11 fix round 1, I3)', () => {
  beforeEach(() => pmProposals.getState().clear());

  it('every refused item becomes a row the owner can assign or dismiss; a row is kept once per task and worker', () => {
    pmProposals.getState().addRefused('run', 2, [{ taskId: 't1', workerId: 'w1', reason: 'auto_delegate_off' }, { taskId: 't1', workerId: 'w1', reason: 'auto_delegate_off' }]);
    const s = snapshotOf({ tasks: [task('t1', { title: 'Add posting', role: 'backend' })] });
    s.settings = [{ scope: 'runner', key: 'w1', field: 'display_name', desired: 'Aisyah', effective: 'Aisyah', desiredRevision: 1, effectiveRevision: 1, enforcer: 'server', state: 'applied', updatedBy: 'o', updatedAt: '2026-11-11T00:00:00Z', appliedAt: '2026-11-11T00:00:00Z' }] as never;
    const rows = proposalRows(s, pmProposals.getState().items);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Assign Add posting to Aisyah · Backend? (proposed by the PM)');
    expect(rows[0]!.why).toContain('Auto-delegation is off');
    pmProposals.getState().dismiss(rows[0]!.id);
    expect(pmProposals.getState().items).toEqual([]);
  });

  it('a row whose task was assigned meanwhile is gone', () => {
    pmProposals.getState().addRefused('run', 2, [{ taskId: 't1', workerId: 'w1', reason: 'auto_delegate_off' }]);
    const s = snapshotOf({ tasks: [task('t1', { delegation: { workerId: 'w1', planRevision: 2, actor: 'human', at: '2026-11-11T00:00:00Z' } })] });
    expect(proposalRows(s, pmProposals.getState().items)).toEqual([]);
  });
});
