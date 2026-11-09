import type { ReviewedTask } from './types.ts';

export interface CoverageChange {
  readonly dropped: readonly string[];
  readonly added: readonly string[];
  readonly material: boolean;
}

/**
 * Compares the requirement coverage of the server-built candidates with the scope the project already has.
 * Any difference is a material criteria change the engineer must accept. "Valid" never means "in scope".
 */
export function coverageChange(baseline: readonly string[], tasks: readonly ReviewedTask[]): CoverageChange {
  const covered = new Set(tasks.flatMap((t) => t.requirementIds));
  const base = new Set(baseline);
  const dropped = [...base].filter((id) => !covered.has(id)).sort();
  const added = [...covered].filter((id) => !base.has(id)).sort();
  return { dropped, added, material: dropped.length > 0 || added.length > 0 };
}

export const issueKey = (i: { kind: string; path: string }): string => `${i.kind}:${i.path}`;

export function apiErrorText(code: string, details: unknown): string {
  switch (code) {
    case 'stale_revision': return 'The plan changed since you reviewed it. Review again before accepting.';
    case 'acknowledgement_required': return 'Acknowledge each listed issue to continue.';
    case 'proposal_rejected': return 'The server rejected this proposal. It is not accepted and nothing was created.';
    case 'criteria_not_covered': {
      const missing = (details as { missing?: unknown } | null)?.missing;
      return `This plan leaves out ${Array.isArray(missing) ? missing.join(', ') : 'required criteria'}. A run on this project is judged on every criterion, so the plan must cover them all.`;
    }
    case 'plan_invalid': return 'The candidate tasks are not a valid plan. Nothing was created.';
    case 'missing_server_config': return 'This project has no plan settings on the server, so review is blocked.';
    case 'policy_denied': return 'Policy does not allow planning here.';
    case 'task_not_replannable': return 'One of the tasks can no longer take a new revision.';
    case 'run_not_found': return 'The run ID is not known to the server.';
    case 'unauthenticated':
    case 'invalid_token':
    case 'wrong_principal_type':
    case 'not_owner': return 'The server did not accept your sign-in. Sign in again.';
    case 'network_error': return 'Could not reach the control API.';
    case 'proposal_not_acceptable': {
      const reason = (details as { reason?: unknown } | null)?.reason;
      if (reason === 'unverified_source') return 'The server will not accept this proposal: where its output came from could not be verified, so it stays untrusted.';
      return `The server will not accept this proposal${typeof reason === 'string' ? ` (${reason})` : ''}.`;
    }
    default: return `The server returned ${code}.`;
  }
}
