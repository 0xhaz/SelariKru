import { sha256Hex, type AcceptedProposal, type RouteRecordReport } from '@selarikru/domain';
import { effectiveStep } from './model.ts';
import type { TaskFacts } from './facts.ts';
import { AgentCatalog, FirebaseHybridAssistantAdapter, type AssistantSdk } from '@selarikru/inference-firebase-web';
import type { AuthorizedViewCommand, CommandReceipt, CriteriaRevisionRequest, CriteriaRevisionResult, EngineeringDataSource, ProjectViewSnapshot, ProposalAcceptReceipt, TaskAgentContext, TaskRouteRead } from '@selarikru/view-protocol';
import { runAgentStep, type AgentRunOutcome, type AgentRunRequest } from './runner.ts';

/** A call waiting for or in a model, and where it is meant to run first. For the office's desk marks and the server room's CLOUD rack. */
export interface InFlightCall {
  readonly callId: number;
  readonly taskId: string;
  readonly kind: AgentRunRequest['kind'];
  readonly place: 'device' | 'cloud' | null;
}

export type AgentsOutcome = AgentRunOutcome & { readonly simulated: boolean };

/** The task agents for one project: run a step, watch calls in flight, accept a criteria proposal through the replan path. */
export interface AgentsPort {
  /** Demo data: results are labelled so and are never evidence. */
  readonly simulated: boolean;
  run(req: AgentRunRequest): Promise<AgentsOutcome>;
  inFlight(): readonly InFlightCall[];
  onInFlight(fn: (calls: readonly InFlightCall[]) => void): () => void;
  /** Absent: the source cannot replan. */
  readonly reviseCriteria: ((request: CriteriaRevisionRequest) => Promise<CriteriaRevisionResult>) | null;
  /** Whether the task has a change and its input size, for the destination its fresh route allows. Counts only: no context or bundle comes into the tab. */
  facts(taskId: string): Promise<TaskFacts>;
  /** Accepts a checked patch proposal for the no-model apply worker (H5). Absent: the source cannot apply a change. */
  readonly acceptPatch: ((outcome: Extract<AgentsOutcome, { kind: 'result' }>, round: number) => Promise<ProposalAcceptReceipt>) | null;
}

/**
 * The accepted proposal from a patch result: the checked results with their hashes, the diff for review, the call's request id and its route record. Null when the result
 * has no checked results, no recorded route, or no known base. A locked result never becomes one: restricted work is applied by the local runner on this device.
 */
export function acceptedFrom(outcome: Extract<AgentsOutcome, { kind: 'result' }>): AcceptedProposal | null {
  const r = outcome.result;
  const diff = (r.proposal.data as { diff?: unknown } | null)?.diff;
  if (r.kind !== 'patch' || r.locked || !r.patch || r.report === null || r.reported !== 'sent' || !outcome.base || typeof diff !== 'string') return null;
  return {
    proposalId: r.proposal.requestId, taskId: outcome.context.taskId, taskRevision: outcome.base.revision, baseSha: outcome.base.sha, routeRecordId: r.report.requestId, diff,
    results: r.patch.results.map((f) => ({ path: f.path, sha256: f.content === null ? null : sha256Hex(f.content), content: f.content })),
  };
}

export interface CreateAgentsOptions {
  readonly projectId: string;
  readonly source: Pick<EngineeringDataSource, 'getTaskRoute' | 'getTaskContext' | 'getTaskContextSize' | 'reviseTaskCriteria' | 'acceptPatchProposal' | 'getTaskFiles' | 'listTaskFiles'>;
  /** The live adapter (wired to this source's `getTaskRoute`), or none, to build one over `sdk`. */
  readonly adapter?: Pick<FirebaseHybridAssistantAdapter, 'runAgent'>;
  /** The demo's stand-in SDK. */
  readonly sdk?: AssistantSdk;
  readonly simulated: boolean;
  /** Sends `route.report`. A refusal is a failed report and changes nothing else. */
  readonly execute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly snapshot: () => ProjectViewSnapshot | null;
  /** How many times Propose change asks again after a patch fails its check for line drift. Default 1 (`DEFAULT_REASK_LIMIT`). */
  readonly reaskLimit?: number;
}

/** The route read the adapter routes from: the data source's `getTaskRoute`, fresh each time. */
export const fetchRouteFrom = (source: Pick<EngineeringDataSource, 'getTaskRoute'>) => async (projectId: string, taskId: string) => {
  if (!source.getTaskRoute) throw new Error('this source has no task routes');
  return (await source.getTaskRoute(projectId, taskId)).route;
};

/** Where a call is meant to run first, from the fresh read and this call's override. */
const placeOf = (read: TaskRouteRead, callOverride: AgentRunRequest['callOverride']): InFlightCall['place'] => effectiveStep(read.route, callOverride).place;

/** Null when the source cannot run task agents (no route reads or no context reads). */
export function createAgents(opts: CreateAgentsOptions): AgentsPort | null {
  const { source, projectId } = opts;
  if (!source.getTaskRoute || !source.getTaskContext) return null;
  const getTaskRoute = source.getTaskRoute;
  const getTaskContext = source.getTaskContext;
  const adapter = opts.adapter ?? (opts.sdk ? new FirebaseHybridAssistantAdapter({ sdk: opts.sdk, fetchRoute: fetchRouteFrom(source) }) : null);
  if (!adapter) return null;
  const reportRoute = async (p: string, taskId: string, report: RouteRecordReport): Promise<void> => {
    const receipt = await opts.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: `route-${report.requestId}`, args: { projectId: p, taskId, report } });
    if (!receipt.accepted) throw new Error('the route record was not accepted');
  };
  const catalog = new AgentCatalog(adapter, { reportRoute });
  let calls: InFlightCall[] = [];
  let next = 1;
  const listeners = new Set<(c: readonly InFlightCall[]) => void>();
  const publish = (c: InFlightCall[]): void => {
    calls = c;
    for (const l of listeners) l(calls);
  };
  const failedCheck = (taskId: string) => {
    const snap = opts.snapshot();
    const failed = Object.values(snap?.checks ?? {}).filter((c) => c.taskId === taskId && c.state === 'failed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return failed ? { checkId: failed.checkId, output: failed.summary ?? 'The check failed and recorded no output.' } : null;
  };

  return {
    simulated: opts.simulated,
    inFlight: () => calls,
    onInFlight(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    reviseCriteria: source.reviseTaskCriteria ? (request) => source.reviseTaskCriteria!(projectId, request) : null,
    // `round`: 1 for the first accept; each accept again after a failed apply is the next round, with its own key. The same round's key again reads the proposal as it is now.
    acceptPatch: source.acceptPatchProposal ? async (outcome, round) => {
      const proposal = acceptedFrom(outcome);
      if (proposal === null) throw new Error('proposal_not_acceptable: this result cannot be accepted');
      return source.acceptPatchProposal!(projectId, proposal, `accept-${proposal.proposalId}-${round}`);
    } : null,
    async facts(taskId) {
      if (!source.getTaskContextSize) throw new Error('this source cannot size a task\'s input');
      const read = await getTaskRoute(projectId, taskId);
      const size = await source.getTaskContextSize(projectId, taskId, effectiveStep(read.route, null).destination);
      return { hasChange: size.hasChange, inputChars: size.inputChars };
    },
    async run(req) {
      const callId = next++;
      try {
        const out = await runAgentStep({
          projectId, catalog, failedCheck, ...(opts.reaskLimit !== undefined ? { reaskLimit: opts.reaskLimit } : {}),
          getTaskRoute: async (taskId) => {
            const read = await getTaskRoute(projectId, taskId);
            publish([...calls, { callId, taskId: req.taskId, kind: req.kind, place: placeOf(read, req.callOverride) }]);
            return read;
          },
          getTaskContext: (taskId, destination, callOverride) => getTaskContext(projectId, taskId, destination, callOverride),
          ...(source.getTaskFiles ? { getTaskFiles: (taskId: string, paths: readonly string[]) => source.getTaskFiles!(projectId, taskId, paths) } : {}),
          ...(source.listTaskFiles ? { listTaskFiles: (taskId: string) => source.listTaskFiles!(projectId, taskId) } : {}),
        }, req);
        return { ...out, simulated: opts.simulated };
      } finally {
        if (calls.some((c) => c.callId === callId)) publish(calls.filter((c) => c.callId !== callId));
      }
    },
  };
}
