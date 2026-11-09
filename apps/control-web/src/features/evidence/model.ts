import type { Tone } from '@selarikru/ui';
import type { CriterionEvidenceView, ProjectViewSnapshot, RunEvidenceView, RunView } from '@selarikru/view-protocol';
import { hrefFor } from '../../shell/route.ts';

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
  readonly verified: boolean;
  /** What ties this criterion to its evidence. Null only for a criterion no check has reported on. */
  readonly evidence: { readonly checkId: string; readonly checkHref: string; readonly candidateSha: string; readonly candidateShort: string; readonly candidateHref: string; readonly at: string } | null;
  readonly tasks: readonly string[];
}

export interface CheckRow {
  readonly checkRunId: string;
  readonly anchor: string;
  readonly criterionId: string;
  readonly stateLabel: string;
  readonly tone: Tone;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

export interface CandidateModel {
  readonly sha: string;
  readonly short: string;
  readonly statusLabel: string;
  readonly live: boolean;
  readonly anchor: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly flaky: readonly string[];
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
  readonly checks: readonly CheckRow[];
  readonly candidate: CandidateModel | null;
  readonly notDelivered: readonly string[];
}

export const shortSha = (sha: string): string => sha.slice(0, 12);
const CRITERION_STATE: Readonly<Record<CriterionEvidenceView['state'], { label: string; tone: Tone }>> = {
  passed: { label: 'Passed', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' }, skipped: { label: 'Skipped', tone: 'warning' }, error: { label: 'Verifier error', tone: 'warning' }, not_run: { label: 'No check yet', tone: 'neutral' },
};

/** Stable anchors, so a link survives every refresh. */
export const checkAnchor = (checkRunId: string): string => `check-${checkRunId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
export const CANDIDATE_ANCHOR = 'candidate';
const evidenceHref = (runId: string, query: Record<string, string>): string => `${hrefFor('evidence')}?${new URLSearchParams({ run: runId, ...query }).toString()}`;
export const checkHref = (runId: string, checkRunId: string): string => evidenceHref(runId, { check: checkRunId });
export const candidateHref = (runId: string, sha: string): string => evidenceHref(runId, { candidate: sha });

function verifiedState(run: RunView, evidence: RunEvidenceView | null): DeliveryState {
  const base = { key: 'verified' as const, title: 'Verified', link: null };
  if (!run.criteria || !evidence) return { ...base, value: 'Not connected', tone: 'neutral', detail: 'This run has no per-criterion evidence. Task counts are not criteria, so none is shown.', established: false };
  const { verified, total } = run.criteria;
  const at = evidence.candidate ? ` at candidate ${shortSha(evidence.candidate.sha)}` : '';
  if (evidence.candidate && !evidence.candidate.live) return { ...base, value: 'Not verified', tone: 'warning', detail: `The last candidate was ${evidence.candidate.status}, so its passes count for nothing. ${verified} of ${total} criteria verified.`, established: false };
  if (total > 0 && verified === total) return { ...base, value: 'Verified', tone: 'success', detail: `All ${total} criteria passed${at}.`, established: true };
  if (verified > 0) return { ...base, value: 'Partly verified', tone: 'warning', detail: `${verified} of ${total} criteria passed${at}.`, established: false };
  return { ...base, value: 'Not verified', tone: 'neutral', detail: `0 of ${total} criteria verified yet.`, established: false };
}

function mergedState(run: RunView, snapshot: ProjectViewSnapshot, simulated: boolean): DeliveryState {
  const base = { key: 'merged' as const, title: 'Merged' };
  const cr = snapshot.changeRequests.find((c) => c.runId === run.runId);
  const prLink = cr && !simulated ? { href: cr.url, label: `Pull request #${cr.prNumber} on GitHub`, external: true } : null;
  const prName = cr ? `Pull request #${cr.prNumber}` : 'A pull request';
  if (cr?.status === 'merged') return { ...base, value: 'Merged', tone: 'success', detail: `${prName} was merged by a person on GitHub${cr.mergeCommitSha ? ` as ${shortSha(cr.mergeCommitSha)}` : ''}.`, established: true, link: prLink };
  if (cr?.status === 'merged_sha_mismatch') return { ...base, value: 'Merge not recorded', tone: 'danger', detail: `${prName} merged a commit that is not the verified one, so no merge is recorded.`, established: false, link: prLink };
  if (cr?.status === 'stale_candidate') return { ...base, value: 'Not merged', tone: 'warning', detail: `${prName} no longer holds the run's candidate.`, established: false, link: prLink };
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

function rowsOf(run: RunView, evidence: RunEvidenceView, titles: Readonly<Record<string, string>>): { criteria: CriterionRow[]; checks: CheckRow[] } {
  const criteria: CriterionRow[] = evidence.criteria.map((c) => {
    const shape = CRITERION_STATE[c.state];
    return {
      criterionId: c.criterionId, state: c.state, stateLabel: shape.label, tone: shape.tone, verified: c.verified, tasks: c.taskIds.map((id) => titles[id] ?? id),
      evidence: c.check && c.candidateSha ? { checkId: c.check.checkRunId, checkHref: checkHref(run.runId, c.check.checkRunId), candidateSha: c.candidateSha, candidateShort: shortSha(c.candidateSha), candidateHref: candidateHref(run.runId, c.candidateSha), at: c.check.at } : null,
    };
  });
  const checks: CheckRow[] = evidence.criteria.flatMap((c) => {
    if (!c.check) return [];
    const shape = CRITERION_STATE[c.state];
    return [{
      checkRunId: c.check.checkRunId, anchor: checkAnchor(c.check.checkRunId), criterionId: c.criterionId, stateLabel: shape.label, tone: shape.tone,
      facts: [
        { label: 'Check run', value: c.check.checkRunId }, { label: 'Check', value: `${c.check.checkId} (version ${c.check.checkVersion})` }, { label: 'Task', value: `${titles[c.check.taskId] ?? c.check.taskId}, revision ${c.check.revision}` },
        { label: 'Attempt', value: c.check.attemptId ?? 'Not recorded' }, { label: 'Suite run', value: String(c.check.verificationAttempt) }, { label: 'Verification record', value: c.check.recordId ?? 'Not recorded' },
      ],
    }];
  });
  return { criteria, checks };
}

function candidateOf(evidence: RunEvidenceView, run: RunView, snapshot: ProjectViewSnapshot, simulated: boolean): CandidateModel | null {
  const c = evidence.candidate;
  if (!c) return null;
  const cr = snapshot.changeRequests.find((x) => x.runId === run.runId);
  // Only an opened pull request put this commit on GitHub, and only it knows the repository's address.
  const commitHref = !simulated && cr ? `${cr.url.replace(/\/pull\/\d+$/, '')}/commit/${c.sha}` : null;
  return {
    sha: c.sha, short: shortSha(c.sha), statusLabel: c.live ? 'Live' : (c.status === 'rejected' ? 'Rejected' : c.status), live: c.live, anchor: CANDIDATE_ANCHOR, commitHref, flaky: c.flaky,
    facts: [
      { label: 'Base commit', value: c.baseSha }, { label: 'Tree', value: c.treeSha ?? 'Not recorded' }, { label: 'Target branch', value: c.target },
      { label: 'Verification record', value: c.recordId ?? 'Not recorded' }, { label: 'Verified on', value: c.verifierHost ?? 'Not recorded' }, { label: 'Check manifest', value: c.checkManifestSha256 ? `sha256:${c.checkManifestSha256.slice(0, 16)}` : 'Not recorded' }, { label: 'Verifier', value: c.verifierSha256 ? `sha256:${c.verifierSha256.slice(0, 16)}` : 'Not recorded' },
    ],
  };
}

/** The acceptance-to-evidence report for one run. Null when the project has no run. Pure. */
export function buildEvidence(snapshot: ProjectViewSnapshot, wantedRunId: string | null): EvidenceModel | null {
  const run = chosenRun(snapshot, wantedRunId);
  if (!run) return null;
  const simulated = snapshot.meta.provenance === 'simulated';
  const titles = Object.fromEntries(Object.values(snapshot.tasks).map((t) => [t.taskId, t.title ?? t.taskId]));
  const evidence = run.evidence;
  const { criteria, checks } = evidence ? rowsOf(run, evidence, titles) : { criteria: [], checks: [] };
  const n = (s: CriterionEvidenceView['state']): number => criteria.filter((c) => c.state === s).length;
  const counts = evidence ? ([{ label: 'passed', n: n('passed'), tone: 'success' }, { label: 'failed', n: n('failed'), tone: 'danger' }, { label: 'skipped', n: n('skipped'), tone: 'warning' }, { label: 'verifier error', n: n('error'), tone: 'warning' }, { label: 'no check yet', n: n('not_run'), tone: 'neutral' }] as const).filter((c) => c.n > 0) : [];
  const accepted = run.reducedScope;
  const notDelivered = accepted?.notDelivered.requirementIds ?? run.scopeAssessment?.notDelivered.requirementIds ?? [];
  return {
    runId: run.runId, runLabel: run.runId, simulated, connected: evidence !== null, runOptions: Object.values(snapshot.runs).map((r) => ({ id: r.runId, label: r.runId })),
    states: [verifiedState(run, evidence), mergedState(run, snapshot, simulated), DEPLOYED],
    coverage: run.criteria ? `${run.criteria.verified} of ${run.criteria.total} criteria verified` : 'Per-criterion evidence is not connected',
    counts, criteria, checks, candidate: evidence ? candidateOf(evidence, run, snapshot, simulated) : null, notDelivered,
  };
}
