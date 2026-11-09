import type { ProposalData, ProposalValidation } from '@selarikru/domain';
import { blockedExplanation } from './labels.ts';
import type { ResultMeta } from './store.ts';
import { Chip, btnQuiet, mono } from './ui.tsx';

function Data({ data }: { data: ProposalData }) {
  return (
    <div className="space-y-3" data-testid="output-list">
      {'summary' in data ? <p>{data.summary}</p> : null}
      {'acceptanceCriteria' in data ? (
        <ol className="space-y-2">
          {data.acceptanceCriteria.map((c, i) => (
            <li key={i} className="flex gap-3 rounded-chip border border-line bg-bg p-3">
              <span className={`${mono} shrink-0 text-active`}>{c.requirementId}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {'tasks' in data ? (
        <ol className="space-y-2">
          {data.tasks.map((t, i) => (
            <li key={i} className="rounded-chip border border-line bg-bg p-3">
              <p className="font-medium">{t.title}</p>
              <p className="text-sm text-muted">{t.description}</p>
              <p className={`${mono} mt-1 text-active`}>{t.role ? `${t.role}: ` : ''}{t.requirementIds.join(', ')}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Shows what came back, or explains why nothing did. Blocked and violation states never show prompt text. */
export function OutputView({ result, semantic, onDiscard }: { result: ResultMeta | null; semantic: ProposalValidation | null; onDiscard: () => void }) {
  let body;
  if (!result) {
    body = <p className="text-muted">No draft yet. Choose a brief and press Generate draft.</p>;
  } else if (result.status === 'blocked') {
    const e = blockedExplanation(result.blockedReason);
    body = (
      <div role="alert" className="rounded-chip border border-warning p-3">
        <p className="font-medium text-warning">Blocked by data policy</p>
        <p className="mt-1">{e.what}</p>
        <p className="mt-1 text-muted">{e.remedy}</p>
        <p className="mt-2 text-sm text-muted">Reason code <span className={mono}>{result.blockedReason ?? 'unspecified'}</span>. No request reached a model.</p>
      </div>
    );
  } else if (result.status === 'route_violation' || result.status === 'unverified_source') {
    const e = blockedExplanation(result.blockedReason);
    body = (
      <div role="alert" className="rounded-chip border border-danger p-3">
        <p className="font-medium text-danger">{result.status === 'route_violation' ? 'Route violation' : 'Source not verified'}: this output cannot be accepted</p>
        <p className="mt-1">{e.what}</p>
        <p className="mt-1 text-muted">The output was withheld and is not shown. {e.remedy}</p>
        <p className="mt-2 text-sm text-muted">Reason code <span className={mono}>{result.blockedReason ?? 'unspecified'}</span>.</p>
      </div>
    );
  } else if (result.status === 'error') {
    body = (
      <div role="alert" className="rounded-chip border border-danger p-3">
        <p className="font-medium text-danger">The request failed</p>
        <p className="mt-1 text-muted">No draft was produced{result.errorName ? ` (${result.errorName})` : ''}. Nothing was retried in the cloud.</p>
        {result.errorCode ? <p className="mt-2 text-sm text-muted">Error code <span className={mono} data-testid="error-code">{result.errorCode}</span></p> : null}
      </div>
    );
  } else if (result.status === 'invalid') {
    body = (
      <div className="rounded-chip border border-warning p-3">
        <p className="font-medium text-warning">The model output did not match the required shape</p>
        <p className="mt-1 text-muted">This is a quality failure, shown as is. It was not retried in the cloud.</p>
        <ul className="mt-2 list-disc pl-5 text-sm">{result.schemaErrors.map((m, i) => <li key={i} className={mono}>{m}</li>)}</ul>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {result.demo ? <Chip tone="warning">Demo data</Chip> : null}
          {result.restricted ? <Chip tone="warning">Restricted draft</Chip> : null}
        </div>
        {result.demo ? <p className="text-sm text-muted">Not evidence. No model ran, and nothing here is reported as a live result.</p> : null}
        {result.restricted ? <p className="text-sm text-muted">Held in memory on this device only. Nothing posts it, and it is gone when you reload.</p> : null}
        {semantic && semantic.issues.length > 0 ? (
          <div className="rounded-chip border border-warning p-3 text-sm">
            <p className="font-medium text-warning">{semantic.status === 'rejected' ? 'Rejected by the proposal checks' : 'Findings that need your review'}</p>
            <ul className="mt-1 list-disc pl-5">
              {semantic.issues.map((i, k) => <li key={k}><span className={mono}>{i.kind}</span> at <span className={mono}>{i.path}</span>: {i.message}</li>)}
            </ul>
          </div>
        ) : null}
        {semantic?.data ? <Data data={semantic.data} /> : <p className="text-muted">The draft is not shown because it was rejected.</p>}
        {result.restricted && result.draftId ? <button type="button" className={btnQuiet} onClick={onDiscard}>Discard draft</button> : null}
      </div>
    );
  }
  return (
    <section aria-labelledby="output-title" className="rounded-card border border-line bg-panel p-4">
      <h2 id="output-title" className="text-base font-semibold">Draft output</h2>
      <div className="mt-3">{body}</div>
    </section>
  );
}
