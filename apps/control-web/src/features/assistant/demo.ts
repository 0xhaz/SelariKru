import type { AssistantProposal } from '@selarikru/inference-firebase-web';
import type { ProposalOperation } from '@selarikru/domain';

/** Canned output for the Demo data mode. No model runs; the result is never evidence. */
export function demoData(op: ProposalOperation, ids: readonly string[]): unknown {
  if (op === 'draftTaskPlan') {
    return { tasks: ids.map((id) => ({ title: `Demo task for ${id}`, description: `Demo description for ${id}.`, requirementIds: [id] })) };
  }
  const criteria = ids.map((id) => ({ requirementId: id, text: `Demo criterion for ${id}.` }));
  return op === 'draftBrief' ? { summary: 'Demo summary. Not produced by a model.', acceptanceCriteria: criteria } : { acceptanceCriteria: criteria };
}

export function demoProposal(op: ProposalOperation, ids: readonly string[]): AssistantProposal {
  return {
    trust: 'untrusted_proposal',
    status: 'ok',
    operation: op,
    data: demoData(op, ids),
    requestId: 'demo',
    requestedMode: null,
    observedSource: 'UNKNOWN',
    rawInferenceSource: null,
    model: { cloudModel: 'none', sdkVersion: 'none' },
    timing: { totalMs: 0, firstOutputMs: null },
    usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    validation: { status: 'not_run', errors: [] },
    payloadSha256: null,
    allowedRequirementIds: [...ids],
    blockedReason: null,
    errorName: null,
  };
}
