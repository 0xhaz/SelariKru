import { useState } from 'react';
import { FIREBASE_CLOUD_ROUTE, type InferenceMode, type Policy } from '@selarikru/policy';
import { errorCodeOf, type AssistantProposal, type RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import type { AssistReviewResponse } from '@selarikru/domain';
import { Chip, buttonQuiet } from '@selarikru/ui';
import { POLICY_HINT, POLICY_LABEL, MODES } from '../assistant/labels.ts';
import type { AssistantPort } from '../assistant/types.ts';
import type { OnboardingApi } from './api.ts';
import { Notice } from './ui.tsx';

export interface AssistedGoal { name: string; idea: string; audience: string; firstOutcome: string }

const CRITERIA_IDS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8'];
const SOURCE_ID = 'onboarding-goal';

/** Mirrors the route the assistant screen already uses: cloud only for internal text the owner has approved. */
function policyFor(mode: InferenceMode, restricted: boolean, cloudApproved: boolean): Policy {
  const grant = cloudApproved && !restricted;
  return {
    policyVersion: 'browser-session.1', preferredMode: mode, selectedSources: grant ? [SOURCE_ID] : [],
    destinations: grant ? [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['public', 'internal'] }] : [],
  };
}

const ROUTE_TEXT = (mode: InferenceMode, restricted: boolean): string =>
  restricted ? 'Restricted text stays on this device. No cloud model will see it, and the result is kept here only.' : `${POLICY_LABEL[mode]}. ${POLICY_HINT[mode]}`;

/** Optional single-turn help. Its output is a suggestion. It can only fill in the form, and the owner still has to save. */
export function AssistPanel({ adapter, hold, api, mode, goal, onApply }: { adapter: AssistantPort | null; hold: RestrictedDraftHold | null; api: OnboardingApi; mode: 'mock' | 'live'; goal: AssistedGoal; onApply: (next: Partial<AssistedGoal>) => void }) {
  const [open, setOpen] = useState(false);
  const [routeMode, setRouteMode] = useState<InferenceMode>('PREFER_ON_DEVICE');
  const [cloudApproved, setCloudApproved] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const [review, setReview] = useState<AssistReviewResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (mode === 'mock' || !adapter) return <p className="text-sm text-muted">The assistant is off in demo mode.</p>;

  const ask = async (): Promise<void> => {
    setBusy(true); setFailure(null); setProposal(null); setReview(null);
    try {
      const taskText = [`Project idea: ${goal.idea}`, `For: ${goal.audience}`, `First useful outcome: ${goal.firstOutcome}`].join('\n');
      const p = await adapter.draftBrief({ projectId: 'onboarding', taskText, allowedRequirementIds: CRITERIA_IDS, sources: [{ id: SOURCE_ID, classification: restricted ? 'restricted' : 'internal' }], policy: policyFor(routeMode, restricted, cloudApproved) });
      setProposal(p);
      if (p.status !== 'ok') { setFailure(p.blockedReason ? `The assistant could not answer: ${p.blockedReason.replace(/_/g, ' ')}.` : 'The assistant did not return a usable draft.'); return; }
      if (restricted) { hold?.hold({ id: p.requestId, sourceClassifications: ['restricted'], proposal: p }); return; }
      const r = await api.reviewAssist({ envelope: { operation: p.operation, status: p.status, data: p.data } });
      if (r.ok) setReview(r.value);
      else setFailure(r.message);
    } catch (e) {
      setFailure(errorCodeOf(e) ?? 'The assistant did not respond.');
    } finally {
      setBusy(false);
    }
  };

  const source = proposal?.observedSource;
  return (
    <details className="rounded-card border border-line bg-panel" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Draft this with the assistant (optional)</summary>
      <div className="space-y-3 border-t border-line p-4">
        <p className="text-sm text-muted">The assistant suggests wording only. It cannot save, move this setup forward or start anything.</p>
        <fieldset>
          <legend className="text-sm font-medium">Where the assistant runs</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {MODES.map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-sm"><input type="radio" name="assist-route" checked={routeMode === m} disabled={restricted} onChange={() => setRouteMode(m)} />{POLICY_LABEL[m]}</label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={cloudApproved} disabled={restricted} onChange={(e) => setCloudApproved(e.target.checked)} /><span>Cloud is allowed for this text</span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /><span>This includes restricted material</span></label>
        <p className="text-sm text-fg" data-testid="assist-route-text">{ROUTE_TEXT(routeMode, restricted)}</p>
        <button type="button" className={buttonQuiet} disabled={busy || !goal.idea.trim()} onClick={() => void ask()}>{busy ? 'Drafting' : 'Draft a suggestion'}</button>
        {failure ? <Notice tone="warning" title="No suggestion">{failure}</Notice> : null}
        {proposal && source ? <p className="text-sm text-muted">Reported source: <Chip tone={source === 'UNKNOWN' ? 'warning' : 'neutral'}>{source === 'ON_DEVICE' ? 'On this device' : source === 'IN_CLOUD' ? 'Cloud model' : 'Unknown'}</Chip></p> : null}
        {proposal && restricted && proposal.status === 'ok' ? <Notice tone="neutral" title="Kept on this device">This draft came from restricted text, so it is shown only here and cannot be sent to the server.{typeof (proposal.data as { summary?: unknown } | null)?.summary === 'string' ? <span className="mt-1 block">{(proposal.data as { summary: string }).summary}</span> : null}</Notice> : null}
        {review ? (
          <div className="rounded-card border border-line p-3" data-testid="assist-suggestion">
            <p className="text-sm font-semibold">Suggestion, not saved</p>
            {review.summary ? <p className="mt-1 wrap-anywhere text-sm">{review.summary}</p> : null}
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{review.acceptanceCriteria.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
            <button type="button" className={`${buttonQuiet} mt-3`} onClick={() => onApply({ ...(review.summary ? { idea: review.summary } : {}), ...(review.acceptanceCriteria[0] ? { firstOutcome: review.acceptanceCriteria[0].text } : {}) })}>Use this wording</button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
