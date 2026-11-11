import { outOfDateCopy } from '../out-of-date.ts';
import type { Tone } from '@selarikru/ui';
import type { CriterionEvidenceView, ProjectViewSnapshot, RunEvidenceView, RunView } from '@selarikru/view-protocol';
import { decisionHref, hrefFor } from '../../shell/route.ts';
import { isClosedRun } from '../overview/attention.ts';

export type DeliveryKey = 'verified' | 'merged' | 'deployed';

/** One of the three separate delivery facts. `established` is true only when evidence states it; each one is shown and worded on its own. */
export interface DeliveryState {
  readonly key: DeliveryKey;
  readonly title: string;
  readonly value: string;
  readonly tone: Tone;
  readonly detail: string;
  readonly established: boolean;
  /** A link to the record behind this state, when there is one to open. */
  readonly link: { readonly href: string; readonly label: string; readonly external: boolean } | null;
}

export interface CriterionRow {
  readonly criterionId: string;
  readonly state: CriterionEvidenceView['state'];
  readonly stateLabel: string;
  readonly tone: Tone;
  readonly description: string | null;
  readonly verified: boolean;
  /** Its result changed between suite retries. A flaky pass stays visible. */
  readonly flaky: boolean;
  /** What ties this criterion to its evidence. Null for a criterion no check has reported on, or that was not delivered. */
  readonly evidence: { readonly checkId: string; readonly checkHref: string; readonly anchor: string; readonly candidateSha: string; readonly candidateShort: string; readonly candidateHref: string; readonly at: string; readonly facts: readonly { readonly label: string; readonly value: string }[] } | null;
  readonly tasks: readonly string[];
}

export interface CandidateModel {
  readonly sha: string;
  readonly short: string;
  readonly statusLabel: string;
  readonly live: boolean;
  /** False: the record no longer stands, so this candidate's passes count for nothing. */
  readonly recordValid: boolean;
  readonly anchor: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly flaky: readonly string[];
  /** An open pull request still holds the code from before main moved. Null: none does. */
  readonly outOfDateNote: string | null;
  /** A link to the commit on GitHub. Only an observed pull request makes it a real address. */
  readonly commitHref: string | null;
}

export interface EvidenceModel {
  readonly runId: string;
  readonly runLabel: string;
  readonly runOptions: readonly { readonly id: string; readonly label: string }[];
  readonly simulated: boolean;
  /** False when the run has no per-criterion evidence: the table is replaced by a plain statement. */
  readonly connected: boolean;
  readonly states: readonly [DeliveryState, DeliveryState, DeliveryState];
  readonly coverage: string;
  readonly counts: readonly { readonly label: string; readonly n: number; readonly tone: Tone }[];
  readonly criteria: readonly CriterionRow[];
  readonly candidate: CandidateModel | null;
  readonly notDelivered: readonly string[];
  readonly reducedScopeAccepted: boolean;
  /** Attempts of this run a person opened a shell in, as they happened. A verifier pass does not clear this: the recorded model cannot vouch for what a person ran. */
  readonly humanIntervened: readonly { readonly attemptId: string; readonly taskId: string; readonly at: string }[];
}

export const shortSha = (sha: string): string => sha.slice(0, 12);

// C0 and C1 controls except tab and newline, and the bidi marks and embeddings that can reorder what a reader sees.
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Test output as a person should read it: candidate code can shape this text, so it can never carry control or direction characters onto the screen. A carriage return still ends a line. */
export const cleanFailureText = (text: string): string => text.replace(/\r\n?/g, '\n').replace(UNPRINTABLE, '');
const CRITERION_STATE: Readonly<Record<CriterionEvidenceView['state'], { label: string; tone: Tone }>> = {
  not_delivered: { label: 'Not delivered', tone: 'warning' },
  passed: { label: 'Passed', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' }, skipped: { label: 'Skipped', tone: 'warning' }, error: { label: 'Verifier error', tone: 'warning' }, not_run: { label: 'No check yet', tone: 'neutral' },
};

/** Stable anchors, so a link survives every refresh. */
export const checkAnchor = (checkRunId: string): string => `check-${checkRunId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
export const CANDIDATE_ANCHOR = 'candidate';
const evidenceHref = (runId: string, query: Record<string, string>): string => `${hrefFor('evidence')}?${new URLSearchParams({ run: runId, ...query }).toString()}`;
export const checkHref = (runId: string, checkRunId: string): string => evidenceHref(runId, { check: checkRunId });
export const candidateHref = (runId: string, sha: string): string => evidenceHref(runId, { candidate: sha });

/** The run's Verified state. Shared with the office's PR board, so both say verified on exactly the same record. */
export function verifiedState(run: RunView, evidence: RunEvidenceView | null): DeliveryState {
  const base = { key: 'verified' as const, title: 'Verified', link: null };
  if (!run.criteria || !evidence) return { ...base, value: 'Not connected', tone: 'neutral', detail: 'No per-criterion evidence for this run: its tasks name no criteria, or it is older than the report window. Tasks are not counted in their place.', established: false };
  const { verified, total } = run.criteria;
  const at = evidence.candidate ? ` at candidate ${shortSha(evidence.candidate.sha)}` : '';
  if (evidence.candidate && !evidence.candidate.live) return { ...base, value: 'Not verified', tone: 'warning', detail: `The last candidate was ${evidence.candidate.status}, so its passes count for nothing. ${verified} of ${total} approved criteria verified.`, established: false };
  if (evidence.candidate && !evidence.candidate.recordValid && evidence.criteria.some((c) => c.state === 'passed')) {
    // A closed run has nothing left to re-verify, so it is told what happened and offered nothing.
    const open = !isClosedRun(run);
    return { ...base, value: 'Record no longer valid', tone: 'warning', detail: `The verifier, its suite or the stored record changed after candidate ${shortSha(evidence.candidate.sha)} was judged, so its passes do not count.${open ? ' Re-verifying judges the same commit again and runs no worker.' : ''} 0 of ${total} approved criteria verified.`, established: false, link: open ? { href: decisionHref(`reverify:${run.runId}`), label: 'Re-verify in Action items', external: false } : null };
  }
  // Verified is established only on a sound record: something passed, on a live candidate whose record stands, with one row per approved criterion.
  // A count that disagrees with its rows, or that has no standing candidate behind it, is never read as verified.
  if (evidence.criteria.length !== total) return { ...base, value: 'Not verified', tone: 'warning', detail: `The verification record lists ${evidence.criteria.length} of ${total} approved criteria, so none is counted as verified.`, established: false };
  const standing = evidence.candidate !== null && evidence.candidate.live && evidence.candidate.recordValid;
  const sound = standing && verified > 0;
  if (total > 0 && verified === total) {
    if (sound) return { ...base, value: 'Verified', tone: 'success', detail: `All ${total} approved criteria passed${at}.`, established: true };
    return { ...base, value: 'Not verified', tone: 'warning', detail: `No candidate with a standing verification record is behind these passes, so they are not counted. 0 of ${total} approved criteria verified.`, established: false };
  }
  const missing = evidence.criteria.filter((c) => c.state === 'not_delivered').map((c) => c.criterionId);
  const accepted = run.reducedScope?.notDelivered.requirementIds ?? [];
  // The only way to say Verified with a criterion missing: the owner accepted exactly that, and the words say so.
  if (sound && missing.length > 0 && verified === total - missing.length && missing.every((id) => accepted.includes(id))) return { ...base, value: 'Verified at reduced scope', tone: 'warning', detail: `${verified} of ${total} approved criteria passed${at}. ${missing.length} not delivered, as you accepted.`, established: true };
  const shortfall = missing.length > 0 ? ` ${missing.length} not delivered.` : '';
  if (verified > 0) return { ...base, value: 'Partly verified', tone: 'warning', detail: `${verified} of ${total} approved criteria passed${at}.${shortfall}`, established: false };
  return { ...base, value: 'Not verified', tone: 'neutral', detail: `0 of ${total} approved criteria verified yet.${shortfall}`, established: false };
}

function mergedState(run: RunView, snapshot: ProjectViewSnapshot, simulated: boolean): DeliveryState {
  const base = { key: 'merged' as const, title: 'Merged' };
  const cr = snapshot.changeRequests.find((c) => c.runId === run.runId);
  const prLink = cr && !simulated ? { href: cr.url, label: `Pull request #${cr.prNumber} on GitHub`, external: true } : null;
  const prName = cr ? `Pull request #${cr.prNumber}` : 'A pull request';
  if (cr?.status === 'merged') return { ...base, value: 'Merged', tone: 'success', detail: `${prName} was merged by a person on GitHub${cr.mergeCommitSha ? ` as ${shortSha(cr.mergeCommitSha)}` : ''}.`, established: true, link: prLink };
  if (cr?.status === 'merged_sha_mismatch') return { ...base, value: 'Merge not recorded', tone: 'danger', detail: `${prName} merged a commit that is not the verified one, so no merge is recorded.`, established: false, link: prLink };
  if (cr?.status === 'stale_candidate') return { ...base, value: 'Not merged', tone: 'warning', detail: `${prName} no longer holds the run's candidate.`, established: false, link: prLink };
  if (cr?.status === 'open' && cr.outOfDate) return { ...base, value: 'Pull request out of date', tone: 'warning', detail: outOfDateCopy(cr, cr.outOfDate).short, established: false, link: prLink };
  if (cr?.status === 'open' && run.lifecycle !== 'ready_for_review') return { ...base, value: 'Not ready to merge', tone: 'warning', detail: `${prName} is open, but the run has left review while its code is judged again. Merging it now would not be recorded for this run.`, established: false, link: prLink };
  if (cr?.status === 'open') return { ...base, value: 'Awaiting a human merge', tone: 'neutral', detail: `${prName} is open. Merging happens on GitHub; agents never merge.`, established: false, link: prLink };
  if (cr) return { ...base, value: 'Not merged', tone: 'neutral', detail: `${prName} is ${cr.status}.`, established: false, link: prLink };
  return { ...base, value: 'Not merged', tone: 'neutral', detail: 'No pull request has been opened for this run.', established: false, link: null };
}

/** Nothing in this product observes a deployment, so this reads the same in every run. A merge or a passing check is never read as one. */
const DEPLOYED: DeliveryState = { key: 'deployed', title: 'Deployed', value: 'Not established', tone: 'neutral', detail: 'No deployment evidence is connected. A merge is not a deployment.', established: false, link: null };

function chosenRun(snapshot: ProjectViewSnapshot, wanted: string | null): RunView | null {
  const runs = Object.values(snapshot.runs);
  return runs.find((r) => r.runId === wanted) ?? runs.filter((r) => !['merged', 'failed', 'cancelled'].includes(r.lifecycle)).at(-1) ?? runs.at(-1) ?? null;
}

function rowsOf(run: RunView, evidence: RunEvidenceView, titles: Readonly<Record<string, string>>): CriterionRow[] {
  const rejected = evidence.candidate !== null && !evidence.candidate.live;
  return evidence.criteria.map((c) => {
    const shape = CRITERION_STATE[c.state];
    // A pass that does not count must not look like one that does: on a rejected candidate it is muted, and on a live one it says why, a record that no longer stands or a carrier still unfinished.
    const uncounted = c.state === 'passed' && !c.verified;
    const recordStands = evidence.candidate?.recordValid === true;
    const stateLabel = !uncounted || rejected ? shape.label : recordStands ? 'Waiting on another task' : 'Record no longer valid';
    const tone: Tone = uncounted ? (rejected || recordStands ? 'neutral' : 'warning') : shape.tone;
    return {
      criterionId: c.criterionId, description: c.description, state: c.state, stateLabel, tone, verified: c.verified, flaky: evidence.candidate?.flaky.includes(c.criterionId) ?? false, tasks: c.taskIds.map((id) => titles[id] ?? id),
      evidence: c.check && c.candidateSha ? {
        checkId: c.check.checkRunId, checkHref: checkHref(run.runId, c.check.checkRunId), anchor: checkAnchor(c.check.checkRunId), candidateSha: c.candidateSha, candidateShort: shortSha(c.candidateSha), candidateHref: candidateHref(run.runId, c.candidateSha), at: c.check.at,
        facts: [
          { label: 'Check run', value: c.check.checkRunId }, { label: 'Check', value: `${c.check.checkId} (version ${c.check.checkVersion})` }, { label: 'Task', value: `${titles[c.check.taskId] ?? c.check.taskId}, revision ${c.check.revision}` },
          { label: 'Attempt', value: c.check.attemptId ?? 'Not recorded' }, { label: 'Suite run', value: String(c.check.verificationAttempt) }, { label: 'Verification record', value: c.check.recordId ?? 'Not recorded' },
        ],
      } : null,
    };
  });
}

function candidateOf(evidence: RunEvidenceView, run: RunView, snapshot: ProjectViewSnapshot, simulated: boolean): CandidateModel | null {
  const c = evidence.candidate;
  if (!c) return null;
  const cr = snapshot.changeRequests.find((x) => x.runId === run.runId);
  // Only an opened pull request put this commit on GitHub, and only it knows the repository's address.
  const commitHref = !simulated && cr ? `${cr.url.replace(/\/pull\/\d+$/, '')}/commit/${c.sha}` : null;
  return {
    sha: c.sha, short: shortSha(c.sha), statusLabel: c.live ? 'Current' : (c.status === 'rejected' ? 'Rejected' : c.status), live: c.live, recordValid: c.recordValid, anchor: CANDIDATE_ANCHOR, commitHref, flaky: c.flaky,
    outOfDateNote: cr?.status === 'open' && cr.outOfDate ? outOfDateCopy(cr, cr.outOfDate).short : null,
    facts: [
      { label: 'Base commit', value: c.baseSha }, { label: 'Tree', value: c.treeSha ?? 'Not recorded' }, { label: 'Target branch', value: c.target },
      { label: 'Verification record', value: c.recordId ?? 'Not recorded' }, { label: 'Verified on', value: c.verifierHost ?? 'Not recorded' }, { label: 'Check manifest', value: c.checkManifestSha256 ? `sha256:${c.checkManifestSha256.slice(0, 16)}` : 'Not recorded' }, { label: 'Verifier', value: c.verifierSha256 ? `sha256:${c.verifierSha256.slice(0, 16)}` : 'Not recorded' },
    ],
  };
}

/** The acceptance-to-evidence report for one run. Null when the project has no run. Pure. */
/** The server's list covers every revision of the run; attempts in the projection add what an event marked since that snapshot. */
function interventionsOf(snapshot: ProjectViewSnapshot, run: RunView): EvidenceModel['humanIntervened'] {
  const live = Object.values(snapshot.attempts).filter((a) => a.humanIntervenedAt && snapshot.tasks[a.taskId]?.runId === run.runId).map((a) => ({ attemptId: a.attemptId, taskId: a.taskId, at: a.humanIntervenedAt! }));
  const all = new Map([...(run.humanInterventions ?? []), ...live].map((h) => [h.attemptId, h]));
  return [...all.values()].sort((x, y) => x.at.localeCompare(y.at));
}

export function buildEvidence(snapshot: ProjectViewSnapshot, wantedRunId: string | null): EvidenceModel | null {
  const run = chosenRun(snapshot, wantedRunId);
  if (!run) return null;
  const simulated = snapshot.meta.provenance === 'simulated';
  const titles = Object.fromEntries(Object.values(snapshot.tasks).map((t) => [t.taskId, t.title ?? t.taskId]));
  const evidence = run.evidence;
  const criteria = evidence ? rowsOf(run, evidence, titles) : [];
  const n = (s: CriterionEvidenceView['state']): number => criteria.filter((c) => c.state === s).length;
  const counts = evidence ? ([{ label: 'passed', n: n('passed'), tone: 'success' }, { label: 'failed', n: n('failed'), tone: 'danger' }, { label: 'skipped', n: n('skipped'), tone: 'warning' }, { label: 'verifier error', n: n('error'), tone: 'warning' }, { label: 'no check yet', n: n('not_run'), tone: 'neutral' }, { label: 'not delivered', n: n('not_delivered'), tone: 'warning' }] as const).filter((c) => c.n > 0) : [];
  const notDelivered = [...new Set([...criteria.filter((c) => c.state === 'not_delivered').map((c) => c.criterionId), ...(run.reducedScope?.notDelivered.requirementIds ?? run.scopeAssessment?.notDelivered.requirementIds ?? [])])].sort();
  return {
    runId: run.runId, runLabel: run.runId, simulated, connected: evidence !== null, runOptions: Object.values(snapshot.runs).map((r) => ({ id: r.runId, label: r.runId })),
    states: [verifiedState(run, evidence), mergedState(run, snapshot, simulated), DEPLOYED],
    coverage: run.criteria ? `${run.criteria.verified} of ${run.criteria.total} approved criteria verified` : 'Per-criterion evidence is not connected',
    reducedScopeAccepted: run.reducedScope !== null,
    humanIntervened: interventionsOf(snapshot, run),
    counts, criteria, candidate: evidence ? candidateOf(evidence, run, snapshot, simulated) : null, notDelivered,
  };
}
