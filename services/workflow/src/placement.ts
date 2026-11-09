import { applyApproval, ClassificationSchema, evaluate, type Operation, type PolicyDecision, type Policy, type Source } from '@selarikru/policy';
import type { TaskSpec } from '@selarikru/domain';

export type PlacementTarget = 'local' | 'cloud';
const LOCATIONS = ['local', 'cloud'] as const satisfies readonly PlacementTarget[];

/**
 * A named run-level placement configuration. Slot counts match docs/demo/benchmark-manifest.json
 * (L1, C1, H2); L2 and C2 are its optional modes. `rolePlacement` pins a task role to a location.
 */
export interface PlacementMode {
  readonly id: string;
  readonly localSlots: number;
  readonly cloudSlots: number;
  readonly rolePlacement?: Readonly<Record<string, PlacementTarget>>;
}

export const PLACEMENT_MODES = {
  L1: { id: 'L1', localSlots: 1, cloudSlots: 0 },
  L2: { id: 'L2', localSlots: 2, cloudSlots: 0 },
  C1: { id: 'C1', localSlots: 0, cloudSlots: 1 },
  C2: { id: 'C2', localSlots: 0, cloudSlots: 2 },
  H2: { id: 'H2', localSlots: 1, cloudSlots: 1, rolePlacement: { backend: 'local', frontend: 'cloud' } },
} as const satisfies Record<string, PlacementMode>;

/** Quota and live count for one location. A missing `limit` denies the location; it is never unlimited. */
export interface LocationCapacity {
  readonly limit?: number | null | undefined;
  readonly running: number;
}

/** The capacity table `place` reads. Production builds it from the database; tests use a fake. */
export interface Capacity {
  readonly modeId?: string;
  /** The total across locations (2 for the pilot). Per-location limits can only narrow it. */
  readonly maxConcurrentTotal?: number | null | undefined;
  readonly local: LocationCapacity;
  readonly cloud: LocationCapacity;
  /** Running workers across every run of the tenant. Defaults to local + cloud when the table counts one scope only. */
  readonly totalRunning?: number | undefined;
  readonly rolePlacement?: Readonly<Record<string, PlacementTarget>> | undefined;
}

export function capacityForMode(
  mode: PlacementMode,
  live: { maxConcurrentTotal?: number | null | undefined; running: { local: number; cloud: number } },
): Capacity {
  return {
    modeId: mode.id, maxConcurrentTotal: live.maxConcurrentTotal,
    local: { limit: mode.localSlots, running: live.running.local },
    cloud: { limit: mode.cloudSlots, running: live.running.cloud },
    rolePlacement: mode.rolePlacement,
  };
}

/** What a cloud start is judged on. `sources` are the task's real input sources; `destination` the execution destination ID. */
export interface PlaceContext {
  readonly sources: readonly Source[];
  readonly destination: string | null | undefined;
  readonly estimatedCost: number | null;
  readonly remainingBudget: number | null;
  /** A human grant for this exact cloud start exists: it satisfies `require_approval`, and nothing else. A deny is final. */
  readonly approved?: boolean;
}

export interface Placement {
  readonly target: PlacementTarget;
  /** Stable code for the UI's "why it's here" text. */
  readonly reason: string;
  /** Present for a cloud start: the policy decision behind it, recorded as a policy decision and never as an approval. */
  readonly policy?: PolicyDecision;
}

export interface Blocked {
  readonly blocked: true;
  /** Stable, concrete code. Never a silent fallback to another location. */
  readonly reason: string;
  /** True when the block can clear by itself (a slot frees up). */
  readonly transient: boolean;
  /** Set for a configured `require_approval`: the operation a human would be approving. No row exists yet. */
  readonly approval?: { readonly op: Operation; readonly decision: PolicyDecision };
}

export const isBlocked = (r: Placement | Blocked): r is Blocked => 'blocked' in r;

const isCount = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min;
const block = (reason: string, transient = false): Blocked => ({ blocked: true, reason, transient });

type Slot = { state: 'free' } | { state: 'full' } | { state: 'disabled' } | { state: 'missing' };

function slotFor(loc: LocationCapacity, total: number): Slot {
  if (!isCount(loc.limit, 0)) return { state: 'missing' };
  if (loc.limit === 0) return { state: 'disabled' };
  if (!isCount(loc.running, 0)) return { state: 'full' };
  return loc.running < Math.min(loc.limit, total) ? { state: 'free' } : { state: 'full' };
}

/**
 * Decides where a ready task runs. Pure: no I/O, and the same inputs give the same answer.
 * A cloud start goes through the policy package. A restricted or secret label, a missing limit, destination or grant,
 * or a configured approval requirement (until a human grant for this exact start exists) yields `Blocked`; nothing is moved or retried elsewhere.
 */
export function place(task: TaskSpec, capacity: Capacity, policy: Policy | undefined, ctx: PlaceContext): Placement | Blocked {
  const total = capacity.maxConcurrentTotal;
  if (!isCount(total, 1)) return block('missing_limit:maxConcurrentTotal');
  const totalRunning = capacity.totalRunning ?? capacity.local.running + capacity.cloud.running;
  if (!isCount(totalRunning, 0)) return block('invalid_running_count');
  if (totalRunning >= total) return block('concurrency_limit_reached', true);

  // A mode that maps roles fails closed: a role it does not name (case-sensitive) is blocked, never spilled to the other location.
  if (capacity.rolePlacement !== undefined && !Object.hasOwn(capacity.rolePlacement, task.role)) return block(`role_not_mapped:${task.role}`);
  const pin = capacity.rolePlacement !== undefined ? capacity.rolePlacement[task.role] : undefined;
  let candidates: readonly PlacementTarget[];
  let reason: string;
  if (pin !== undefined) {
    if (task.execution !== 'eligible_any' && task.execution !== pin) return block('execution_conflicts_with_role_pin');
    candidates = [pin];
    reason = `role_pinned_${pin}`;
  } else if (task.execution === 'local' || task.execution === 'cloud') {
    candidates = [task.execution];
    reason = `execution_${task.execution}`;
  } else {
    candidates = LOCATIONS;
    reason = 'local_slot_free';
  }

  const label = ClassificationSchema.safeParse(task.classification);
  const cloudBarred = !label.success || label.data === 'restricted' || label.data === 'secret';
  const cloudWanted = candidates.includes('cloud');
  if (cloudWanted && cloudBarred) {
    candidates = candidates.filter((c) => c !== 'cloud');
    if (candidates.length === 0) return block('classification_not_cloud_eligible');
  }

  const slots = { local: slotFor(capacity.local, total), cloud: slotFor(capacity.cloud, total) };
  // A missing limit denies the location. It never lets the task expand to the other one.
  for (const target of candidates) if (slots[target].state === 'missing') return block(`missing_limit:${target}`);
  const anyChoice = pin === undefined && task.execution === 'eligible_any';
  for (const target of candidates) {
    if (slots[target].state !== 'free') continue;
    if (target === 'local') return { target, reason };
    const op = {
      kind: 'start_cloud_worker', destination: ctx.destination ?? '', sources: ctx.sources, totalRunning,
      estimatedCost: ctx.estimatedCost, remainingBudget: ctx.remainingBudget,
    } as const;
    const decision = applyApproval(evaluate(op, policy), ctx.approved === true);
    if (decision.decision === 'deny') return block(`policy_denied:${decision.reason}`, decision.reason === 'concurrency_limit_reached');
    if (decision.decision === 'require_approval') return { ...block(`approval_required:${decision.reason}`), approval: { op, decision } };
    const cloudReason = !anyChoice ? reason
      : slots.local.state === 'disabled' ? 'cloud_only_mode'
      : 'expanded_to_cloud:local_full';
    return { target, reason: cloudReason, policy: decision };
  }

  // Nothing is free. A task that could run locally and only waits for the slot is a transient wait, not a block.
  if (candidates.includes('local') && slots.local.state === 'full') return block('no_free_slot', true);
  if (cloudWanted && cloudBarred) return block('classification_not_cloud_eligible');
  if (candidates.every((c) => slots[c].state === 'disabled')) return block(`location_disabled:${candidates[0]}`);
  return block('no_free_slot', true);
}
