import { describe, expect, it } from 'vitest';
import { CriteriaRevisionRequestSchema, TaskAgentContextSchema } from './index.ts';

const bundle = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, destination: 'cloud', taskId: 't1', compilationVersion: null, generator: { id: 'g', version: '1' }, watermark: 0, sourceHead: 0, indexLag: 0, recordsPending: false,
  compiledAt: null, pinned: [], claims: [], omissions: [], ...over,
});
const context = (over: Record<string, unknown> = {}) => ({
  taskId: 't1', revision: 1, runId: 'r1', planRevision: 1, destination: 'cloud',
  task: { title: 'Search index', description: null, criteria: [{ id: 'AC-1', text: 'Finds by title' }], allowedPaths: ['src/search'], classification: 'internal' },
  bundle: bundle(), change: null, simulated: false, ...over,
});

describe('task agent context', () => {
  it('reads a context served for its destination', () => {
    expect(TaskAgentContextSchema.safeParse(context()).success).toBe(true);
    expect(TaskAgentContextSchema.safeParse(context({ change: { diff: 'diff --git a/x b/x', files: [{ path: 'x', classification: 'internal' }] }, spec: { taskId: 't1' } })).success).toBe(true);
  });

  it('refuses a bundle served for another destination or another task, and a label it does not know', () => {
    expect(TaskAgentContextSchema.safeParse(context({ bundle: bundle({ destination: 'local' }) })).success).toBe(false);
    expect(TaskAgentContextSchema.safeParse(context({ bundle: bundle({ taskId: 't2' }) })).success).toBe(false);
    expect(TaskAgentContextSchema.safeParse(context({ task: { ...context().task, classification: 'confidential' } })).success).toBe(false);
  });

  it('a criteria revision names the task, the plan revision it saw, and at least one reworded criterion', () => {
    expect(CriteriaRevisionRequestSchema.safeParse({ taskId: 't1', expectedPlanRevision: 1, idempotencyKey: 'k', criteria: [{ id: 'AC-1', text: 'Finds by title and body' }] }).success).toBe(true);
    expect(CriteriaRevisionRequestSchema.safeParse({ taskId: 't1', expectedPlanRevision: 1, idempotencyKey: 'k', criteria: [] }).success).toBe(false);
    expect(CriteriaRevisionRequestSchema.safeParse({ taskId: 't1', expectedPlanRevision: 1, idempotencyKey: 'k', criteria: [{ id: 'AC-1', text: '   ' }] }).success).toBe(false);
  });
});
