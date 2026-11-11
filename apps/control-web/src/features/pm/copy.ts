import { refusalText } from '../hybrid/model.ts';

/** Plain words for what the Project Manager's calls and assignments can be refused with (H11). */
const REFUSAL: Readonly<Record<string, string>> = {
  research_locked: 'This task reads restricted data, so the Project Manager does not search the web for it.',
  research_cloud_only: 'Web research runs only in the cloud, and this call could not go there.',
  research_device_only: 'You set this task to run on this device only, so the Project Manager does not search the web for it.',
  research_not_granted: 'Web research is off. Turn on "Google Search (web research)" in Settings › Workflow to allow it; only your question is sent.',
  question_too_long: 'A web research question is at most 500 characters. Shorten it.',
  question_empty: 'Write a question first.',
  auto_delegate_off: 'Auto-delegation is off in Settings › Workflow, so this waits for you.',
  plan_revision_not_accepted: 'It is not for the accepted plan revision in force.',
  task_not_in_plan: 'That task is not in the accepted plan.',
  worker_unknown: 'No such worker.',
  worker_disabled: 'That worker is disabled.',
  role_not_in_task: 'That worker\'s role is not the task\'s role.',
  task_not_delegable: 'That task is already running or done.',
  retry_limit_reached: 'That task has no attempt left.',
  duplicate_task: 'The task was named twice.',
  outside_plan_field: 'It named something the accepted plan does not cover (a path, a budget or a role).',
  delegation_output_mismatch: 'These are not the assignments the Project Manager\'s call produced, so they are not applied.',
  plan_revision_changed: 'The plan changed since the Project Manager proposed this. Ask it again.',
  route_record_used: 'This proposal was already used once. Ask the Project Manager again.',
  proposal_from_restricted_call: 'This came from a call that read restricted data, so it stays on this device and is not applied.',
  proposal_from_restricted_context: 'This came from a call whose context held restricted data, so it stays on this device and is not applied.',
};

/** A refusal in plain words. `name` is the worker's label, for the refusals that need one. */
export function pmRefusal(code: string, name?: string): string {
  if (code === 'worker_role_unset') return `${name ? `Set ${name}'s` : 'Set this worker\'s'} role in Team settings first.`;
  return REFUSAL[code] ?? refusalText(code);
}
