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
 * What a worker can actually be granted today, and so what `TASK.md` offers. A grant for either of these is a human decision the attempt then acts on; it
 * needs nothing from the sandbox or the path gate that does not exist yet.
 */
export const HONOURED_APPROVAL_OPERATIONS = ['breaking_api_change', 'destructive_data_migration'] as const satisfies readonly WorkerApprovalOperation[];

/**
 * Why an operation cannot take effect even if a person granted it, or null when it can. These are refused when asked, so nobody is shown a decision that
 * would change nothing: a network grant needs a sandbox that limits egress to the destination, and a scope grant needs a way to widen `allowedPaths`.
 */
export function approvalUnavailableReason(operation: string): 'egress_enforcement_unavailable' | 'scope_grant_unavailable' | null {
  if (requiresDestination(operation)) return 'egress_enforcement_unavailable';
  return operation === 'scope_change' || operation === 'broader_scope' ? 'scope_grant_unavailable' : null;
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
