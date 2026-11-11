import { AgentActions } from './AgentActions.tsx';
import { RunsOn } from './RunsOn.tsx';

/** Where a task's AI runs, and its AI actions: in the worker drawer's Task tab and the Pipeline inspector. Nothing when the source reports no route. */
export function TaskHybrid({ taskId }: { taskId: string }) {
  return (
    <div className="space-y-4" data-testid="task-hybrid">
      <RunsOn taskId={taskId} />
      <AgentActions taskId={taskId} />
    </div>
  );
}
