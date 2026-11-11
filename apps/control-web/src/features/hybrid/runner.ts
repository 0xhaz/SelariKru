import { parseUnifiedDiff, type RoutePolicyMode } from '@selarikru/domain';
import type { AgentInputs, AgentResult } from '@selarikru/inference-firebase-web';
import { FIREBASE_CLOUD_ROUTE, type Policy } from '@selarikru/policy';
import type { TaskAgentContext, TaskBaseFiles, TaskRouteRead } from '@selarikru/view-protocol';
import { effectiveStep, type AgentActionKind } from './model.ts';

/**
 * Runs one AI step of a task through the agent catalog (H3). The route is read fresh first, only to choose the destination of the context bundle: `cloud` for any
 * cloud-capable route, `local` only for a device-only one. The adapter reads the route again before the call and again inside its queue; nothing here routes the call.
 */

export interface AgentRunnerDeps {
  readonly projectId: string;
  readonly getTaskRoute: (taskId: string) => Promise<TaskRouteRead>;
  /** The server checks the destination against the route with this call's override, and refuses `cloud` when the route keeps the task on the device. */
  readonly getTaskContext: (taskId: string, destination: 'local' | 'cloud', callOverride: RoutePolicyMode | null) => Promise<TaskAgentContext>;
  readonly catalog: { run<K extends AgentActionKind>(kind: K, input: AgentInputs[K]): Promise<AgentResult<K>> };
  /** The task's latest failed check, from the snapshot. Untrusted text. */
  readonly failedCheck: (taskId: string) => { readonly checkId: string; readonly output: string } | null;
  /** The task's files at its base commit, for the patch agent (H5): read by the local runner and relayed. Absent: the agent gets none and can only create files. */
  readonly getTaskFiles?: (taskId: string, paths: readonly string[]) => Promise<TaskBaseFiles>;
  /** How many times Propose change asks again after the check refuses a patch for line drift. Default 1. */
  readonly reaskLimit?: number;
}

/** Patch check codes a fresh look at the same files can fix: a hunk that did not match, line drift, a file it was not given or one that exists. */
const REASKABLE: readonly string[] = ['diff_does_not_apply', 'diff_file_not_provided', 'diff_file_exists', 'diff_unparseable', 'diff_header_mismatch', 'diff_empty'];
export const DEFAULT_REASK_LIMIT = 1;
const codeOf = (issue: string): string => issue.trim().split(/\s+/).at(-1) ?? '';

/** Context refusals the screen says in their own words. */
const PASSED_THROUGH: readonly string[] = ['context_destination_refused', 'task_spec_unreadable'];

export interface AgentRunRequest {
  readonly taskId: string;
  readonly kind: AgentActionKind;
  readonly callOverride: RoutePolicyMode | null;
}

export type AgentRunOutcome =
  /** `base`: the commit and revision a patch was proposed against, for its accept. `reasked`: how many times Propose change asked again. */
  | { readonly kind: 'result'; readonly result: AgentResult; readonly context: TaskAgentContext; readonly base?: { readonly sha: string; readonly revision: number } | null; readonly reasked?: number }
  | { readonly kind: 'refused'; readonly code: string };

/**
 * The browser's data policy for a task's agents: the cloud is granted for public and internal data only. Restricted locks the call to the device and secret never
 * reaches a model, whatever the route says; the server's route policy decides the rest.
 */
export const taskAgentPolicy = (sourceId: string): Policy => ({
  policyVersion: 'task-route.1',
  selectedSources: [sourceId],
  destinations: [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['public', 'internal'] }],
} as Policy);

/** Where the bundle may go for this call, from a fresh read: the call override, else the task override, else the run default, after the lock. */
export const destinationFor = (read: TaskRouteRead, callOverride: RoutePolicyMode | null): 'local' | 'cloud' => effectiveStep(read.route, callOverride).destination;

export async function runAgentStep(deps: AgentRunnerDeps, req: AgentRunRequest): Promise<AgentRunOutcome> {
  let read: TaskRouteRead;
  try {
    read = await deps.getTaskRoute(req.taskId);
  } catch {
    return { kind: 'refused', code: 'route_fetch_failed' };
  }
  let context: TaskAgentContext;
  try {
    context = await deps.getTaskContext(req.taskId, destinationFor(read, req.callOverride), req.callOverride);
  } catch (e) {
    // A refusal the source names keeps its code; only a read that failed is `context_unavailable`.
    const code = /^([a-z_]+):/.exec(e instanceof Error ? e.message : '')?.[1];
    return { kind: 'refused', code: code !== undefined && PASSED_THROUGH.includes(code) ? code : 'context_unavailable' };
  }
  const sourceId = `task:${req.taskId}`;
  const t = context.task;
  const base = {
    projectId: deps.projectId,
    task: { taskId: req.taskId, title: t.title, description: t.description, criteria: t.criteria, allowedPaths: t.allowedPaths, classification: t.classification },
    bundle: context.bundle,
    sources: [{ id: sourceId, classification: t.classification }],
    policy: taskAgentPolicy(sourceId),
    callOverride: req.callOverride,
  };
  const done = (result: AgentResult): AgentRunOutcome => ({ kind: 'result', result, context });
  switch (req.kind) {
    case 'criteria': return done(await deps.catalog.run('criteria', base));
    case 'breakdown': return done(await deps.catalog.run('breakdown', base));
    case 'patch': {
      // The task's base files, read by the local runner with git and relayed (never stored). A restricted task's files stay on the device, so it gets none and can only
      // create files; a read that failed refuses the step rather than propose blind.
      let given: TaskBaseFiles | null = null;
      if (deps.getTaskFiles && t.allowedPaths.length > 0) {
        try {
          given = await deps.getTaskFiles(req.taskId, t.allowedPaths);
        } catch (e) {
          const code = /^([a-z_]+):/.exec(e instanceof Error ? e.message : '')?.[1];
          if (code !== 'files_restricted') return { kind: 'refused', code: 'files_unavailable' };
        }
      }
      const files = (given?.files ?? []).map((f) => ({ path: f.path, content: f.content, classification: t.classification }));
      const specBase = typeof context.spec?.['baseSha'] === 'string' ? { sha: context.spec['baseSha'], revision: context.revision } : null;
      const at = given !== null ? { sha: given.baseSha, revision: given.revision } : specBase;
      let result = await deps.catalog.run('patch', { ...base, files });
      let reasked = 0;
      const limit = Math.max(0, Math.floor(deps.reaskLimit ?? DEFAULT_REASK_LIMIT));
      // A bounded re-ask: once by default, a new call (its own route record) with the refusal codes and the same files, then it stops and shows the result.
      while (reasked < limit && result.proposal.status === 'invalid' && result.proposal.validation.errors.some((x) => REASKABLE.includes(codeOf(x)))) {
        reasked += 1;
        result = await deps.catalog.run('patch', { ...base, files, priorIssues: result.proposal.validation.errors });
      }
      return { kind: 'result', result, context, base: at, reasked };
    }
    case 'review': {
      if (!context.change) return { kind: 'refused', code: 'no_change' };
      const parsed = parseUnifiedDiff(context.change.diff);
      // A file the change creates had no contents before it. Any other path keeps no label here, so it counts as restricted and keeps the call on this device.
      const created = new Set(parsed.ok ? parsed.files.filter((f) => f.change === 'create').map((f) => f.path) : []);
      const files = context.change.files.filter((f) => created.has(f.path)).map((f) => ({ path: f.path, classification: f.classification, content: '' }));
      return done(await deps.catalog.run('review', { ...base, diff: context.change.diff, files }));
    }
    case 'prDescription':
      if (!context.change) return { kind: 'refused', code: 'no_change' };
      return done(await deps.catalog.run('prDescription', { ...base, diff: context.change.diff, files: context.change.files }));
    case 'triage': {
      const check = deps.failedCheck(req.taskId);
      if (!check) return { kind: 'refused', code: 'no_failed_check' };
      return done(await deps.catalog.run('triage', { ...base, check: { checkId: check.checkId, output: check.output, classification: t.classification } }));
    }
  }
}
