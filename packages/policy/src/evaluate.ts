import { checkReservation } from './budget.ts';
import { ClassificationSchema } from './classification.ts';
import { isDestinationGranted, type Source } from './destinations.ts';
import {
  ADMIN_KINDS, HARD_DENY_KINDS, HUMAN_DECISION_KINDS, OPERATION_KINDS, TREATMENTS,
  type OperationKind, type Policy, type Treatment,
} from './policy.ts';

export interface PolicyDecision {
  readonly decision: Treatment;
  /** Stable machine-readable code. */
  readonly reason: string;
  readonly policyVersion: string;
  /** Automatic allows are policy decisions, never `approval.granted` (human-only). */
  readonly record: 'policy_decision';
}

export type Operation =
  | { kind: 'read_approved_docs' | 'run_scoped_tests' | 'edit_scoped_dev_branch' | 'create_draft_pr' | 'append_artifacts' | 'assign_replan_tasks' }
  | { kind: 'repair_within_limits'; attempt: number; estimatedCost: number | null; remainingBudget: number | null }
  | {
      kind: 'start_cloud_worker';
      /** Execution destination ID (region is part of the ID). */
      destination: string;
      /** Every source feeding the worker's input bundle. */
      sources: readonly Source[];
      totalRunning: number;
      estimatedCost: number | null;
      remainingBudget: number | null;
    }
  | { kind: (typeof HUMAN_DECISION_KINDS)[number] }
  | { kind: 'production_data' | 'production_infrastructure' | 'deploy' | 'merge_protected_branch' }
  | {
      kind: (typeof ADMIN_KINDS)[number];
      /** Must come from the authenticated principal, never from operation arguments or model output. */
      actor: 'agent' | 'administrator' | 'unknown';
    };

function decide(decision: Treatment, reason: string, policyVersion: string): PolicyDecision {
  return { decision, reason, policyVersion, record: 'policy_decision' };
}

const has = (o: object | undefined, k: string): boolean => o !== undefined && Object.hasOwn(o, k);
const isTreatment = (t: unknown): t is Treatment => typeof t === 'string' && (TREATMENTS as readonly string[]).includes(t);

export function evaluate(op: Operation, policy: Policy | undefined): PolicyDecision {
  if (!policy) return decide('deny', 'missing_policy', 'unknown');
  const v = policy.policyVersion;
  const kind = op?.kind;
  if (typeof kind !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(kind)) {
    return decide('deny', 'unknown_operation', v);
  }
  const k = kind as OperationKind;
  const ops = policy.operations;
  const configured: unknown = has(ops, k) ? ops?.[k] : undefined;

  if ((HARD_DENY_KINDS as readonly string[]).includes(k)) return decide('deny', `hard_deny:${k}`, v);

  if ((ADMIN_KINDS as readonly string[]).includes(k)) {
    if ((op as { actor?: unknown }).actor !== 'administrator') return decide('deny', `not_administrator:${k}`, v);
    if (configured === undefined) return decide('deny', `missing_operation_config:${k}`, v);
    if (!isTreatment(configured)) return decide('deny', `invalid_operation_config:${k}`, v);
    return decide(configured, configured === 'deny' ? `configured_deny:${k}` : `administrator_authorized:${k}`, v);
  }

  if (k === 'repair_within_limits' || k === 'start_cloud_worker') {
    if (configured === 'deny') return decide('deny', `configured_deny:${k}`, v);
    if (configured !== undefined && !isTreatment(configured)) return decide('deny', `invalid_operation_config:${k}`, v);
    // Every deny check below wins over a configured `require_approval`; it only replaces the final allow.
    const allowed = (reason: string): PolicyDecision =>
      configured === 'require_approval' ? decide('require_approval', `configured_require_approval:${k}`, v) : decide('allow', reason, v);
    const limits = policy.limits;
    if (k === 'repair_within_limits') {
      const r = op as Extract<Operation, { kind: 'repair_within_limits' }>;
      const max = limits?.repairAttempts;
      if (max === undefined) return decide('deny', 'missing_limit:repairAttempts', v);
      if (!Number.isInteger(r.attempt) || r.attempt < 1) return decide('deny', 'invalid_attempt', v);
      if (r.attempt > max) return decide('deny', 'repair_limit_exhausted', v);
      const b = checkReservation(r.estimatedCost, r.remainingBudget);
      if (!b.ok) return decide('deny', `budget:${b.reason}`, v);
      return allowed('repair_within_limits');
    }
    const w = op as Extract<Operation, { kind: 'start_cloud_worker' }>;
    const max = limits?.maxConcurrentTotal;
    if (max === undefined) return decide('deny', 'missing_limit:maxConcurrentTotal', v);
    if (!Number.isInteger(w.totalRunning) || w.totalRunning < 0) return decide('deny', 'invalid_running_count', v);
    if (!Array.isArray(w.sources) || w.sources.length === 0) return decide('deny', 'no_sources', v);
    for (const s of w.sources) {
      const c = ClassificationSchema.safeParse(s?.classification);
      if (!c.success) return decide('deny', 'unclassified_source', v);
      if (c.data === 'restricted' || c.data === 'secret') return decide('deny', 'source_not_cloud_eligible', v);
      if (!policy.selectedSources?.includes(s.id)) return decide('deny', 'source_not_selected', v);
    }
    for (const s of w.sources) {
      if (!isDestinationGranted('execution', w.destination, s.classification, policy)) {
        return decide('deny', 'missing_destination:execution', v);
      }
    }
    if (w.totalRunning >= max) return decide('deny', 'concurrency_limit_reached', v);
    const b = checkReservation(w.estimatedCost, w.remainingBudget);
    if (!b.ok) return decide('deny', `budget:${b.reason}`, v);
    return allowed('eligible_cloud_start_within_limits');
  }

  if (configured === undefined) return decide('deny', `missing_operation_config:${k}`, v);
  if (!isTreatment(configured)) return decide('deny', `invalid_operation_config:${k}`, v);
  if (configured === 'allow' && (HUMAN_DECISION_KINDS as readonly string[]).includes(k)) {
    return decide('require_approval', `human_decision_required:${k}`, v);
  }
  return decide(configured, `configured:${k}`, v);
}

/**
 * Combine a decision with a human approval. A deny is final: approvals only
 * resolve `require_approval`. Persistence of the human grant is the caller's concern.
 */
export function applyApproval(d: PolicyDecision, approved: boolean): PolicyDecision {
  if (d.decision !== 'require_approval') return d;
  return approved ? { ...d, decision: 'allow', reason: `approved:${d.reason}` } : d;
}
