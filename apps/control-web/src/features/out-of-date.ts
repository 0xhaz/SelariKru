import type { ChangeRequestView } from '@selarikru/view-protocol';

type OutOfDate = NonNullable<ChangeRequestView['outOfDate']>;

const STAGE: Readonly<Record<OutOfDate['rebuild'], { readonly lead: string; readonly stage: string; readonly next: string }>> = {
  building: { lead: 'is being rebuilt', stage: 'The rebuilt commit does not exist yet.', next: 'open the new one once verification passes' },
  verifying: { lead: 'was rebuilt', stage: 'The rebuilt code has not passed verification yet.', next: 'open the new one once verification passes' },
  verified: { lead: 'was rebuilt', stage: 'The rebuilt code has passed verification.', next: 'open the new one' },
  failed: { lead: 'was rebuilt, but the rebuild failed', stage: 'It is retried when main next moves, or you can replan the work.', next: 'open a new one once a rebuild passes verification' },
  conflicted: { lead: 'could not be rebuilt: it conflicts with main', stage: 'A resolution task is proposed.', next: 'open a new one once the conflict is resolved and verification passes' },
};

/** Why the run left this pull request behind: main moved under it, or the run's own work changed (a newer candidate, or a plan with work the old commit does not carry). */
const CAUSE: Readonly<Record<OutOfDate['reason'], { readonly so: string; readonly and: string; readonly status: string }>> = {
  main_moved: { so: 'Main moved, so', and: 'Main moved and', status: 'Out of date: main moved' },
  superseded: { so: 'The run\'s work changed, so', and: 'The run\'s work changed and', status: 'Out of date: the run\'s work changed' },
};

/** What a person must be told about an open pull request the run has left behind, by why and by how the rebuild is going. One wording for every screen. */
export function outOfDateCopy(cr: ChangeRequestView, outOfDate: OutOfDate): { readonly title: string; readonly summary: string; readonly next: string; readonly short: string; readonly status: string } {
  const s = STAGE[outOfDate.rebuild];
  const c = CAUSE[outOfDate.reason];
  return {
    title: `Pull request #${cr.prNumber} no longer holds the verified code`,
    summary: `${c.so} the code ${s.lead}. This pull request still holds the old commit. Do not merge it. ${s.stage}`,
    next: `Close pull request #${cr.prNumber} on GitHub, and ${s.next}.`,
    status: c.status,
    short: `${c.and} the code ${s.lead}. Pull request #${cr.prNumber} no longer holds the verified code. Close it, and ${s.next}.`,
  };
}
