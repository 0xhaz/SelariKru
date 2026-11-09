import { describe, expect, it } from 'vitest';
import { createPipelinePresentation } from './presentation.ts';

describe('pipeline presentation store', () => {
  it('graph and table share selection', () => {
    const store = createPipelinePresentation();
    store.getState().setView('graph');
    store.getState().select('task-1');
    store.getState().setView('table');
    expect(store.getState().selectedTaskId).toBe('task-1');
    expect(store.getState().view).toBe('table');
    store.getState().open('task-2');
    store.getState().setView('graph');
    expect(store.getState()).toMatchObject({ selectedTaskId: 'task-2', inspecting: true });
    store.getState().closeInspector();
    expect(store.getState()).toMatchObject({ selectedTaskId: 'task-2', inspecting: false });
  });

  it('filters are shared by both views and survive a view change', () => {
    const store = createPipelinePresentation();
    store.getState().setCriticalOnly(true);
    store.getState().setGroupByStage(false);
    store.getState().setView('graph');
    expect(store.getState()).toMatchObject({ criticalOnly: true, groupByStage: false });
  });

  it('forgets a selection that no longer exists, without touching one that does', () => {
    const store = createPipelinePresentation();
    store.getState().open('gone');
    store.getState().reconcile(['other']);
    expect(store.getState()).toMatchObject({ selectedTaskId: null, inspecting: false });
    store.getState().open('other');
    store.getState().reconcile(['other']);
    expect(store.getState()).toMatchObject({ selectedTaskId: 'other', inspecting: true });
  });

  it('a deep link restores view and task without opening the inspector unasked', () => {
    const store = createPipelinePresentation();
    store.getState().applyLink({ view: 'graph', task: 'abc' });
    expect(store.getState()).toMatchObject({ view: 'graph', selectedTaskId: 'abc', inspecting: false });
    store.getState().applyLink({ view: 'bogus', task: null });
    expect(store.getState().view).toBe('graph');
  });
});
