import type { ChangeRequestView } from '@selarikru/view-protocol';

type OutOfDate = NonNullable<ChangeRequestView['outOfDate']>;

const STAGE: Readonly<Record<OutOfDate['rebuild'], { readonly lead: string; readonly stage: string; readonly next: string }>> = {
  building: { lead: 'is being rebuilt', stage: 'The rebuilt commit does not exist yet.', next: 'open the new one once verification passes' },
  verifying: { lead: 'was rebuilt', stage: 'The rebuilt code has not passed verification yet.', next: 'open the new one once verification passes' },
  verified: { lead: 'was rebuilt', stage: 'The rebuilt code has passed verification.', next: 'open the new one' },
  failed: { lead: 'was rebuilt, but the rebuild failed', stage: 'It is retried when main next moves, or you can replan the work.', next: 'open a new one once a rebuild passes verification' },
  conflicted: { lead: 'could not be rebuilt: it conflicts with main', stage: 'A resolution task is proposed.', next: 'open a new one once the conflict is resolved and verification passes' },
};

/** What a person must be told about an open pull request main has left behind, by how the rebuild is going. One wording for every screen. */
export function outOfDateCopy(cr: ChangeRequestView, outOfDate: OutOfDate): { readonly title: string; readonly summary: string; readonly next: string; readonly short: string } {
  const s = STAGE[outOfDate.rebuild];
  return {
    title: `Pull request #${cr.prNumber} no longer holds the verified code`,
    summary: `Main moved, so the code ${s.lead}. This pull request still holds the old commit. ${s.stage}`,
    next: `Close pull request #${cr.prNumber} on GitHub, and ${s.next}.`,
    short: `Main moved and the code ${s.lead}. Pull request #${cr.prNumber} no longer holds the verified code. Close it, and ${s.next}.`,
  };
}
