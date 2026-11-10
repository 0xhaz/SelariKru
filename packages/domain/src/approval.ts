import { z } from 'zod';

/**
 * What a worker may ask a person to approve through the harness signal. A closed list: anything else is refused before it reaches policy, and policy
 * (`evaluate`) still decides each one. `budget_increase` is left out on purpose: a worker asking for more money is not something a grant could satisfy.
 */
export const WORKER_APPROVAL_OPERATIONS = ['new_domain', 'new_connector', 'broader_scope', 'breaking_api_change', 'scope_change', 'destructive_data_migration'] as const;
export const WorkerApprovalOperationSchema = z.enum(WORKER_APPROVAL_OPERATIONS);
export type WorkerApprovalOperation = z.infer<typeof WorkerApprovalOperationSchema>;

/** Operations whose grant changes where a worker may reach. These must name a destination; it is part of the approval's scope. */
export const DESTINATION_OPERATIONS: readonly WorkerApprovalOperation[] = ['new_domain', 'new_connector'];
export const requiresDestination = (operation: string): boolean => (DESTINATION_OPERATIONS as readonly string[]).includes(operation);

/**
 * What a worker is offered today in `TASK.md`. A grant for either of these is advisory: it records a human decision that the attempt is told about and
 * that the pull request lists for the reviewer, but nothing in the sandbox or the path gate enforces it. It needs nothing from enforcement that does not
 * exist yet, which is why these two can be offered and the network and scope operations cannot.
 */
export const ADVISORY_APPROVAL_OPERATIONS = ['breaking_api_change', 'destructive_data_migration'] as const satisfies readonly WorkerApprovalOperation[];

/**
 * Why an operation cannot take effect even if a person granted it, or null when it can. These are refused when asked, so nobody is shown a decision that
 * would change nothing: a network grant needs a sandbox that limits egress to the destination, and a scope grant needs a way to widen `allowedPaths`.
 */
export function approvalUnavailableReason(operation: string): 'egress_enforcement_unavailable' | 'scope_grant_unavailable' | null {
  if (requiresDestination(operation)) return 'egress_enforcement_unavailable';
  return operation === 'scope_change' || operation === 'broader_scope' ? 'scope_grant_unavailable' : null;
}

/**
 * The reason a restricted attempt publishes for an approval request: the operation and destination, which are structured and checked, and none of the agent's own words.
 * Restricted output stays on the device, and those words are output. The runner keeps them in its own log; the server writes this sentence for a restricted attempt whatever
 * a runner sent.
 */
export function restrictedApprovalReason(operation: string | undefined, destination: { readonly host: string } | null | undefined): string {
  return `The worker asked for ${operation ?? 'an unnamed operation'}${destination ? ` to reach ${destination.host}` : ''}. Its own words stay on the device because this work is restricted.`;
}

/** The completion gate's reason for a restricted attempt: how many paths broke the rule, not which. The paths are names the agent chose. */
export const restrictedDiffReason = (count: number): string => `diff outside allowedPaths: ${count} path(s); the paths stay on the device because this work is restricted`;

/** The most paths a completion-gate count may claim. Anything above it is not a count this gate could produce, and is not rebuilt. */
export const MAX_DIFF_VIOLATIONS = 1_000_000;

/** Reads the count back out of a runner's completion-gate reason, so the server can reduce one a runner sent with paths in it. Null for any other reason, and for a count above the cap. */
export function diffViolationCount(reason: string): number | null {
  const m = /^diff outside allowedPaths: (\d{1,7}) path\(s\)/.exec(reason);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= MAX_DIFF_VIOLATIONS ? n : null;
}

/** A DNS name with an alphabetic last label: no raw IP addresses, schemes, ports, paths or wildcards. */
const NETWORK_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Where a grant reaches: a structured value, never parsed out of a reason's text. */
export const ApprovalDestinationSchema = z.object({ kind: z.literal('network_host'), host: z.string().regex(NETWORK_HOST, 'expected a lowercase DNS host name') }).strict();
export type ApprovalDestination = z.infer<typeof ApprovalDestinationSchema>;

/** A human grant delivered with the next lease. `destination` is what the scope bound; a null one grants no reach. */
export const LeaseGrantSchema = z
  .object({
    approvalId: z.string().min(1),
    scopeHash: z.string().min(1),
    operation: WorkerApprovalOperationSchema,
    destination: ApprovalDestinationSchema.nullable(),
    expiresAt: z.string().nullable(),
  })
  .strict();
export type LeaseGrant = z.infer<typeof LeaseGrantSchema>;
