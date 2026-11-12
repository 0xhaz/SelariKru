import { sha256Hex, type AcceptedProposal, type AiCheckpointResume, type AiCheckpointText, type RouteRecordReport } from '@selarikru/domain';
import type { CheckpointEngine, ChainOutcome } from '../checkpoints/engine.ts';
import { connectivity, isOnline } from '../checkpoints/connectivity.ts';
import { effectiveStep } from './model.ts';
import type { TaskFacts } from './facts.ts';
import { AgentCatalog, FirebaseHybridAssistantAdapter, type AssistantSdk } from '@selarikru/inference-firebase-web';
import type { DelegationReceipt, DelegationRequest, OwnerDelegationRequest, PmPlanAcceptReceipt, PmPlanAcceptRequest, AuthorizedViewCommand, CommandReceipt, CriteriaRevisionRequest, CriteriaRevisionResult, EngineeringDataSource, ProjectViewSnapshot, ProposalAcceptReceipt, TaskAgentContext, TaskRouteRead } from '@selarikru/view-protocol';
import { runAgentStep, type AgentRunOutcome, type AgentRunRequest } from './runner.ts';
import { runPmStep, webResearchGranted, type PmKind, type PmOutcome, type PmRequest } from '../pm/runner.ts';

/** A call waiting for or in a model, and where it is meant to run first. For the office's desk marks and the rooftop cloud deck. */
export interface InFlightCall {
  readonly callId: number;
  readonly taskId: string;
  readonly kind: AgentRunRequest['kind'] | PmKind;
  readonly place: 'device' | 'cloud' | null;
}

/** `resumed`: this outcome continued a paused step (H12): sent after reconnecting, escalated, or moved to device only. */
export type AgentsOutcome = AgentRunOutcome & { readonly simulated: boolean; readonly resumed?: AiCheckpointResume };

/** The task agents for one project: run a step, watch calls in flight, accept a criteria proposal through the replan path. */
export interface AgentsPort {
  /** Demo data: results are labelled so and are never evidence. */
  readonly simulated: boolean;
  /** H9, hosted demo: the answers come from a real model (Firebase AI Logic) over demo data. Still demo data and never evidence. */
  readonly liveModel?: boolean;
  run(req: AgentRunRequest): Promise<AgentsOutcome>;
  inFlight(): readonly InFlightCall[];
  onInFlight(fn: (calls: readonly InFlightCall[]) => void): () => void;
  /** Absent: the source cannot replan. */
  readonly reviseCriteria: ((request: CriteriaRevisionRequest) => Promise<CriteriaRevisionResult>) | null;
  /** Whether the task has a change and its input size, for the destination its fresh route allows. Counts only: no context or bundle comes into the tab. */
  facts(taskId: string): Promise<TaskFacts>;
  /** Accepts a checked patch proposal for the no-model apply worker (H5). Absent: the source cannot apply a change. */
  readonly acceptPatch: ((outcome: Extract<AgentsOutcome, { kind: 'result' }>, round: number) => Promise<ProposalAcceptReceipt>) | null;
  /** Where an accepted patch proposal is now, read from the server. Null: never accepted, or the source cannot say. */
  readonly proposalState: ((outcome: Extract<AgentsOutcome, { kind: 'result' }>) => Promise<ProposalAcceptReceipt | null>) | null;
  /** H11: one turn with the Project Manager, through the same adapter and the subject task's route. */
  pm(req: PmRequest): Promise<PmOutcome & { readonly simulated: boolean; readonly resumed?: AiCheckpointResume }>;
  /** H11: sends the PM's delegation for the server to apply inside the accepted plan. Absent: the source cannot delegate. */
  readonly delegate: ((runId: string, request: DelegationRequest) => Promise<DelegationReceipt>) | null;
  /** H11 fix round 1 (I3): the owner's own assignment, from Action items. Absent: the source cannot assign. */
  readonly assign: ((runId: string, request: OwnerDelegationRequest) => Promise<DelegationReceipt>) | null;
  /** H11 fix round 1 (I4): accepts a Project Manager plan through the plan-revision path and the server's backstop. Absent: the source cannot. */
  readonly acceptPlan: ((runId: string, request: PmPlanAcceptRequest) => Promise<PmPlanAcceptReceipt>) | null;
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
  readonly source: Pick<EngineeringDataSource, 'getTaskRoute' | 'getTaskContext' | 'getTaskContextSize' | 'reviseTaskCriteria' | 'acceptPatchProposal' | 'getTaskFiles' | 'listTaskFiles' | 'getProposalState' | 'delegate' | 'assign' | 'acceptPmPlan'>;
  /** The live adapter (wired to this source's `getTaskRoute`), or none, to build one over `sdk`. */
  readonly adapter?: Pick<FirebaseHybridAssistantAdapter, 'runAgent'>;
  /** The demo's stand-in SDK. */
  readonly sdk?: AssistantSdk;
  readonly simulated: boolean;
  /** H9: a real model answers over demo data (the hosted demo). */
  readonly liveModel?: boolean;
  /** Sends `route.report`. A refusal is a failed report and changes nothing else. */
  readonly execute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly snapshot: () => ProjectViewSnapshot | null;
  /** How many times Propose change asks again after a patch fails its check for line drift. Default 1 (`DEFAULT_REASK_LIMIT`). */
  readonly reaskLimit?: number;
  /** H12: keeps each step's checkpoint at every stage boundary. Absent: no checkpoints. */
  readonly checkpoints?: CheckpointEngine | null;
  /** H12: a step that continued a paused checkpoint finished; the screen shows its outcome where the step lives. */
  readonly onResumed?: (req: { readonly taskId: string; readonly kind: AgentRunRequest['kind'] | PmKind; readonly question?: string; readonly restricted?: boolean }, outcome: AgentsOutcome | (PmOutcome & { readonly simulated: boolean; readonly resumed?: AiCheckpointResume })) => void;
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
  const adapter = opts.adapter ?? (opts.sdk ? new FirebaseHybridAssistantAdapter({ sdk: opts.sdk, fetchRoute: fetchRouteFrom(source), isOnline, onNetworkFailure: () => connectivity.getState().reportNetworkFailure(), onNetworkSuccess: () => connectivity.getState().reportNetworkSuccess() }) : null);
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
    liveModel: opts.liveModel === true,
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
    proposalState: source.getProposalState ? (outcome) => source.getProposalState!(projectId, outcome.context.taskId, outcome.result.proposal.requestId) : null,
    async facts(taskId) {
      if (!source.getTaskContextSize) throw new Error('this source cannot size a task\'s input');
      const read = await getTaskRoute(projectId, taskId);
      const size = await source.getTaskContextSize(projectId, taskId, effectiveStep(read.route, null).destination);
      return { hasChange: size.hasChange, inputChars: size.inputChars };
    },
    delegate: source.delegate ? (runId, request) => source.delegate!(projectId, runId, request) : null,
    assign: source.assign ? (runId, request) => source.assign!(projectId, runId, request) : null,
    acceptPlan: source.acceptPmPlan ? (runId, request) => source.acceptPmPlan!(projectId, runId, request) : null,
    async pm(req) {
      const callId = next++;
      // H12: one PM turn is one checkpoint: the owner's question with its label, then the reply with its label.
      const contextId = `ctx_${crypto.randomUUID().replace(/-/g, '')}`;
      let subjectRoute: TaskRouteRead['route'] | undefined;
      const rec = opts.checkpoints?.begin({
        taskId: req.subjectTaskId, stepKind: req.kind, callOverride: req.callOverride,
        texts: [{ who: 'owner', text: req.question.slice(0, 2000), classification: req.questionClassification }],
        ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}),
      });
      try {
        const out = await runPmStep({
          projectId, catalog, snapshot: opts.snapshot, newContextId: () => contextId,
          // The owner's grant for web research, read from the run's settings at the time of the call.
          webResearch: () => { const s = opts.snapshot(); return webResearchGranted(s, s?.tasks[req.subjectTaskId]?.runId ?? null); },
          getTaskRoute: async (taskId) => {
            const read = await getTaskRoute(projectId, taskId);
            if (taskId === req.subjectTaskId) subjectRoute = read.route;
            // Only the subject's read is the call in flight; a plan scope's fresh read of each listed task (H12 step 0) is not.
            if (taskId === req.subjectTaskId && !calls.some((c) => c.callId === callId)) publish([...calls, { callId, taskId, kind: req.kind, place: placeOf(read, req.kind === 'pmResearch' ? 'ONLY_IN_CLOUD' : req.callOverride) }]);
            return read;
          },
          getTaskContext: (taskId, destination, callOverride, contextId) => getTaskContext(projectId, taskId, destination, callOverride, contextId),
        }, req);
        if (rec) {
          if (out.kind === 'result' && out.context) rec.stage({ stage: 'context', context: out.context, contextId, ...(subjectRoute ? { route: subjectRoute } : {}) });
          await rec.finish(out as ChainOutcome, out.kind === 'result' ? pmReplyText(out) : undefined);
        }
        const done = { ...out, simulated: opts.simulated, ...(req.resume ? { resumed: req.resume.kind } : {}) };
        if (req.resume) opts.onResumed?.({ taskId: req.subjectTaskId, kind: req.kind, question: req.question, restricted: req.questionClassification === 'restricted' }, done);
        return done;
      } finally {
        if (calls.some((c) => c.callId === callId)) publish(calls.filter((c) => c.callId !== callId));
      }
    },
    async run(req) {
      const callId = next++;
      const rec = opts.checkpoints?.begin({ taskId: req.taskId, stepKind: req.kind, callOverride: req.callOverride, ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}) });
      try {
        const out = await runAgentStep({
          projectId, catalog, failedCheck, ...(opts.reaskLimit !== undefined ? { reaskLimit: opts.reaskLimit } : {}), ...(rec ? { onStage: (m) => rec.stage(m) } : {}),
          getTaskRoute: async (taskId) => {
            const read = await getTaskRoute(projectId, taskId);
            publish([...calls, { callId, taskId: req.taskId, kind: req.kind, place: placeOf(read, req.callOverride) }]);
            return read;
          },
          getTaskContext: (taskId, destination, callOverride, contextId) => getTaskContext(projectId, taskId, destination, callOverride, contextId),
          ...(source.getTaskFiles ? { getTaskFiles: (taskId: string, paths: readonly string[]) => source.getTaskFiles!(projectId, taskId, paths) } : {}),
          ...(source.listTaskFiles ? { listTaskFiles: (taskId: string) => source.listTaskFiles!(projectId, taskId) } : {}),
        }, req);
        await rec?.finish(out as ChainOutcome);
        const done = { ...out, simulated: opts.simulated, ...(req.resume ? { resumed: req.resume.kind } : {}) };
        if (req.resume) opts.onResumed?.({ taskId: req.taskId, kind: req.kind }, done);
        return done;
      } finally {
        if (calls.some((c) => c.callId === callId)) publish(calls.filter((c) => c.callId !== callId));
      }
    },
  };
}

/** H12: what a PM reply leaves in its checkpoint: its answer (or, for a plan or assignments, a one-line summary), with the label its call earned. */
function pmReplyText(out: Extract<PmOutcome, { kind: 'result' }>): AiCheckpointText | undefined {
  const p = out.result.proposal;
  if (p.status !== 'ok') return undefined;
  const d = (p.data ?? {}) as { answer?: unknown; tasks?: unknown[]; assignments?: unknown[] };
  const text = typeof d.answer === 'string' ? d.answer : Array.isArray(d.tasks) ? `Drafted a plan with ${d.tasks.length} task${d.tasks.length === 1 ? '' : 's'}.` : Array.isArray(d.assignments) ? `Proposed ${d.assignments.length} assignment${d.assignments.length === 1 ? '' : 's'}.` : '';
  return text ? { who: 'pm', text: text.slice(0, 2000), classification: out.result.locked ? 'restricted' : 'internal' } : undefined;
}
