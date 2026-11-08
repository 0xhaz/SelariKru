import { checkReservation } from './budget.ts';
import { HARD_DENY_KINDS, type OperationKind, type Policy, type Treatment } from './policy.ts';

export interface PolicyDecision {
  readonly decision: Treatment;
  /** Stable machine-readable code. */
  readonly reason: string;
  readonly policyVersion: string;
  /** Automatic allows are policy decisions, never `approval.granted` (human-only). */
  readonly record: 'policy_decision';
}

export type Operation =
  | { kind: 'read_approved_docs' | 'run_scoped_tests' | 'edit_scoped_dev_branch' | 'create_draft_pr' }
  | { kind: 'repair_within_limits'; attempt: number }
  | {
      kind: 'start_cloud_worker';
      totalRunning: number;
      /** Execution destination grant and data scope already approved for this worker. */
      executionGranted: boolean;
      estimatedCost: number | null;
      remainingBudget: number | null;
    }
  | { kind: 'new_domain' | 'new_connector' | 'broader_scope' | 'breaking_api_change' | 'scope_change' | 'budget_increase' }
  | { kind: 'production_data' | 'production_infrastructure' | 'deploy' | 'merge_protected_branch' }
  | { kind: 'modify_policy' | 'modify_credentials'; actor: 'agent' | 'administrator' | 'unknown' };

const NO_POLICY = 'missing_policy';

function decide(decision: Treatment, reason: string, policyVersion: string): PolicyDecision {
  return { decision, reason, policyVersion, record: 'policy_decision' };
}

export function evaluate(op: Operation, policy: Policy | undefined): PolicyDecision {
  if (!policy) return decide('deny', NO_POLICY, 'unknown');
  const v = policy.policyVersion;
  const kind: OperationKind = op.kind;

  if ((HARD_DENY_KINDS as readonly string[]).includes(kind)) return decide('deny', `hard_deny:${kind}`, v);

  switch (op.kind) {
    case 'modify_policy':
    case 'modify_credentials':
      return op.actor === 'administrator'
        ? decide('allow', `administrator_authorized:${op.kind}`, v)
        : decide('deny', `agent_cannot_modify:${op.kind}`, v);

    case 'repair_within_limits': {
      const max = policy.limits?.repairAttempts;
      if (max === undefined) return decide('deny', 'missing_limit:repairAttempts', v);
      if (!Number.isInteger(op.attempt) || op.attempt < 1) return decide('deny', 'invalid_attempt', v);
      return op.attempt <= max ? decide('allow', 'repair_within_limits', v) : decide('deny', 'repair_limit_exhausted', v);
    }

    case 'start_cloud_worker': {
      const max = policy.limits?.maxConcurrentTotal;
      if (max === undefined) return decide('deny', 'missing_limit:maxConcurrentTotal', v);
      if (!op.executionGranted) return decide('deny', 'missing_destination:execution', v);
      if (op.totalRunning >= max) return decide('deny', 'concurrency_limit_reached', v);
      const b = checkReservation(op.estimatedCost, op.remainingBudget);
      if (!b.ok) return decide('deny', `budget:${b.reason}`, v);
      return decide('allow', 'eligible_cloud_start_within_limits', v);
    }

    default: {
      const t = policy.operations?.[kind];
      if (t === undefined) return decide('deny', `missing_operation_config:${kind}`, v);
      return decide(t, `configured:${kind}`, v);
    }
  }
}

/**
 * Combine a decision with a human approval. A deny is final: approvals only
 * resolve `require_approval`. The result is never recorded as `approval.granted`
 * by this function; persistence of the human grant is the caller's concern.
 */
export function applyApproval(d: PolicyDecision, approved: boolean): PolicyDecision {
  if (d.decision === 'deny') return d;
  if (d.decision === 'allow') return d;
  return approved ? { ...d, decision: 'allow', reason: `approved:${d.reason}` } : d;
}
