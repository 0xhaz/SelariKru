import { createStore, type StoreApi } from 'zustand/vanilla';

export const PIPELINE_VIEWS = ['table', 'graph'] as const;
export type PipelineView = (typeof PIPELINE_VIEWS)[number];

export interface PipelinePresentationState {
  readonly view: PipelineView;
  /** Shared by table and graph, so a task stays selected when the view changes. */
  readonly selectedTaskId: string | null;
  readonly inspecting: boolean;
  readonly runId: string | null;
  readonly groupByStage: boolean;
  readonly criticalOnly: boolean;
  /** The task whose approval is being previewed on the graph, from "What changes if I approve?". */
  readonly highlightFor: string | null;
  setView(view: PipelineView): void;
  select(taskId: string | null): void;
  open(taskId: string): void;
  closeInspector(): void;
  showApprovalEffect(taskId: string): void;
  setRun(runId: string): void;
  setGroupByStage(on: boolean): void;
  setCriticalOnly(on: boolean): void;
  setHighlightFor(taskId: string | null): void;
  /** Drops a selection whose task is gone (a new snapshot, a fixture change). */
  reconcile(taskIds: readonly string[]): void;
  /** Applies the `view` and `task` of a deep link. Ignores what it does not recognise. */
  applyLink(link: { readonly view: string | null; readonly task: string | null }): void;
}

export type PipelinePresentation = StoreApi<PipelinePresentationState>;

/**
 * Selection, filters and view mode (design section 12), held apart from the projection store so a snapshot never disturbs them and both
 * representations read the same state. Browser-local; nothing here is authority.
 */
export function createPipelinePresentation(): PipelinePresentation {
  return createStore<PipelinePresentationState>()((set, get) => ({
    view: 'table', selectedTaskId: null, inspecting: false, runId: null, groupByStage: true, criticalOnly: false, highlightFor: null,
    setView: (view) => set({ view }),
    select: (taskId) => set({ selectedTaskId: taskId }),
    open: (taskId) => set({ selectedTaskId: taskId, inspecting: true }),
    closeInspector: () => set({ inspecting: false }),
    showApprovalEffect: (highlightFor) => set({ highlightFor, inspecting: false, view: 'graph' }),
    setRun: (runId) => set({ runId, selectedTaskId: null, inspecting: false, highlightFor: null }),
    setGroupByStage: (groupByStage) => set({ groupByStage }),
    setCriticalOnly: (criticalOnly) => set({ criticalOnly }),
    setHighlightFor: (highlightFor) => set({ highlightFor }),
    reconcile: (taskIds) => {
      const { selectedTaskId } = get();
      if (selectedTaskId !== null && !taskIds.includes(selectedTaskId)) set({ selectedTaskId: null, inspecting: false, highlightFor: null });
    },
    applyLink: ({ view, task }) => {
      if (view !== null && (PIPELINE_VIEWS as readonly string[]).includes(view)) set({ view: view as PipelineView });
      if (task !== null) set({ selectedTaskId: task });
    },
  }));
}

/** The one store the Pipeline route reads. Module-level so it survives moving between views. */
export const pipelinePresentation = createPipelinePresentation();
