import { useMemo, useState } from 'react';
import type { ProposalValidation } from '@selarikru/domain';
import { apiErrorText, coverageChange, issueKey } from './handoff.ts';
import type { ResultMeta } from './store.ts';
import type { ApiResult, AssistantApi, ClientInferenceReport, PlanRevisionResponse, ReviewResponse } from './types.ts';
import { btnPrimary, btnQuiet, mono } from './ui.tsx';

type Phase =
  | { readonly name: 'idle' }
  | { readonly name: 'working' }
  | { readonly name: 'needs_ack'; readonly paths: readonly string[] }
  | { readonly name: 'ready'; readonly review: ReviewResponse; readonly key: string }
  | { readonly name: 'accepted'; readonly done: PlanRevisionResponse; readonly report: 'sent' | 'failed' | 'skipped' };

const SOURCE_REPORT = { ON_DEVICE: 'on_device', IN_CLOUD: 'in_cloud', UNKNOWN: 'unknown' } as const;

/** Route metadata only: mode, observed source, model. Never prompt text or output. */
function reportFor(result: ResultMeta): ClientInferenceReport | null {
  if (!result.requestedMode) return null;
  return {
    kind: 'inference',
    mode: result.requestedMode,
    observedSource: SOURCE_REPORT[result.observedSource],
    ...(result.observedSource === 'IN_CLOUD' ? { model: result.cloudModel } : {}),
  };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="handoff-title" className="rounded-card border border-line bg-panel p-4">
      <h2 id="handoff-title" className="text-base font-semibold">Handoff to workflow</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function HandoffPanel({
  result, semantic, api,
}: { result: ResultMeta; semantic: ProposalValidation | null; api: AssistantApi | null }) {
  // Run and scope are those the result was produced for, not whatever the form says now.
  const { runId, baseline } = result;
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const [materialOk, setMaterialOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issueText = useMemo(() => new Map((semantic?.issues ?? []).map((i) => [issueKey(i), i.message] as const)), [semantic]);

  if (!api) return <Shell><p className="text-muted">Handoff is unavailable: the control API URL is not configured for this build.</p></Shell>;
  if (result.demo) return <Shell><p>Demo data cannot be accepted. It is not evidence and nothing here goes to the workflow.</p></Shell>;
  if (result.restricted) {
    return <Shell><p>This draft is restricted. It stays on this device and nothing posts it. Publishing derived work would need a separate, permitted policy change.</p></Shell>;
  }
  if (result.status === 'unverified_source') return <Shell><p className="text-danger">Where this output came from could not be verified, so it cannot be handed to the workflow.</p></Shell>;
  if (result.status !== 'ok') return <Shell><p className="text-muted">There is nothing to hand off for this response.</p></Shell>;
  if (result.operation !== 'draftTaskPlan') return <Shell><p className="text-muted">Only task plans are handed to the workflow. Criteria and briefs are for your review here; draft a task plan to continue.</p></Shell>;
  if (!semantic || semantic.status === 'rejected') return <Shell><p className="text-danger">The proposal checks rejected this draft, so it cannot be accepted.</p></Shell>;

  const client: AssistantApi = api;
  const fail = (r: Extract<ApiResult<unknown>, { ok: false }>): void => {
    setError(apiErrorText(r.code, r.details));
    setPhase({ name: 'idle' });
  };
  const envelope = { operation: result.operation, status: result.status, data: result.proposal?.data };

  async function review(acknowledgedIssuePaths: readonly string[]): Promise<void> {
    setError(null);
    setPhase({ name: 'working' });
    const r = await client.reviewProposal({ runId, envelope, acknowledgedIssuePaths });
    if (r.ok) {
      setMaterialOk(false);
      setPhase({ name: 'ready', review: r.value, key: `plan-${crypto.randomUUID()}` });
    } else if (r.code === 'acknowledgement_required') {
      const paths = (r.details as { paths?: unknown } | undefined)?.paths;
      setAcked(new Set());
      setPhase({ name: 'needs_ack', paths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [] });
    } else fail(r);
  }

  async function accept(rv: ReviewResponse, key: string): Promise<void> {
    setError(null);
    setPhase({ name: 'working' });
    const r = await client.createPlanRevision({ runId, expectedRevision: rv.expectedRevision, idempotencyKey: key, tasks: rv.tasks });
    if (!r.ok) {
      if (r.code === 'network_error') {
        // Unknown outcome: keep the review and resend the identical body with the same key.
        setError(apiErrorText(r.code, r.details));
        setPhase({ name: 'ready', review: rv, key });
        return;
      }
      if (r.code === 'stale_revision') setMaterialOk(false);
      return fail(r);
    }
    const first = r.value.taskIds[0];
    const report = reportFor(result);
    let status: 'sent' | 'failed' | 'skipped' = 'skipped';
    if (first && report) status = (await client.postClientReport({ taskId: first, report })).ok ? 'sent' : 'failed';
    setPhase({ name: 'accepted', done: r.value, report: status });
  }

  const err = error ? <p role="alert" className="rounded-chip border border-danger p-3 text-danger">{error}</p> : null;

  if (phase.name === 'accepted') {
    return (
      <Shell>
        <p className="text-success">Plan revision {phase.done.planRevision} created with {phase.done.taskIds.length} task{phase.done.taskIds.length === 1 ? '' : 's'}.</p>
        <p className={`${mono} text-muted`}>{phase.done.taskIds.join(', ')}</p>
        <p className="text-sm text-muted">
          {phase.report === 'sent' ? 'Route metadata was recorded as an untrusted client report. No prompt or output was sent.' : phase.report === 'failed' ? 'The route metadata report was not recorded. The plan is unaffected.' : 'No route metadata was reported.'}
        </p>
      </Shell>
    );
  }

  if (phase.name === 'needs_ack') {
    const all = phase.paths.length > 0 && phase.paths.every((p) => acked.has(p));
    return (
      <Shell>
        {err}
        <p>The server found issues a person must acknowledge. Review each one before continuing.</p>
        <ul className="space-y-2">
          {phase.paths.map((p) => (
            <li key={p}>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={acked.has(p)} onChange={(e) => setAcked((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n; })} />
                <span>
                  <span className={mono}>{p}</span>
                  <span className="block text-sm text-muted">{issueText.get(p) ?? 'Flagged by the server. Check the draft before acknowledging.'}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <button type="button" className={btnPrimary} disabled={!all} onClick={() => void review([...phase.paths])}>Review again with acknowledgements</button>
      </Shell>
    );
  }

  if (phase.name === 'ready') {
    const rv = phase.review;
    const change = coverageChange(baseline, rv.tasks);
    const blocked = change.material && !materialOk;
    return (
      <Shell>
        {err}
        <p className="text-sm text-muted">Server review passed. These candidates are what would be created; they are not accepted yet.</p>
        <ol className="space-y-2">
          {rv.tasks.map((t) => (
            <li key={t.taskId} className="rounded-chip border border-line bg-bg p-3">
              <p className="font-medium">{t.title}</p>
              <p className={`${mono} text-active`}>{typeof t['role'] === 'string' ? `${t['role']}: ` : ''}{t.requirementIds.join(', ')}</p>
            </li>
          ))}
        </ol>
        {rv.issues.length > 0 ? (
          <p className="text-sm text-muted">Acknowledged: {rv.issues.map((i) => issueKey(i)).join(', ')}</p>
        ) : null}
        {change.material ? (
          <div className="rounded-chip border border-warning p-3">
            <p className="font-medium text-warning">Criteria coverage change</p>
            {change.dropped.length > 0 ? <p>No task covers <span className={mono}>{change.dropped.join(', ')}</span>, which the project scope includes.</p> : null}
            {change.added.length > 0 ? <p>Tasks cover <span className={mono}>{change.added.join(', ')}</span>, which is outside the project scope.</p> : null}
            <label className="mt-2 flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={materialOk} onChange={(e) => setMaterialOk(e.target.checked)} />
              <span>I accept this change to the criteria coverage</span>
            </label>
          </div>
        ) : null}
        <p className="text-sm text-muted">Based on plan revision {rv.expectedRevision}. If the plan changes first, you will be asked to review again.</p>
        <button type="button" className={btnPrimary} disabled={blocked} onClick={() => void accept(rv, phase.key)}>Accept plan</button>
      </Shell>
    );
  }

  return (
    <Shell>
      {err}
      <p>Task plans go through the server before anything is created. The server re-checks this draft against project settings.</p>
      <button type="button" className={btnQuiet} disabled={phase.name === 'working'} onClick={() => void review([])}>Review with server</button>
    </Shell>
  );
}
