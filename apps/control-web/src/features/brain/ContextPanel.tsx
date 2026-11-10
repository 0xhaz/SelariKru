import { useEffect, useMemo, useState } from 'react';
import { Chip, formatExact } from '@selarikru/ui';
import type { AttemptContextView } from '@selarikru/view-protocol';
import type { BrainPort } from '../../shell/projection-store.ts';
import { contextModel } from './model.ts';

const LINK = 'break-all font-mono text-mono text-active underline underline-offset-2';

/** The worker drawer's Context tab: the Project Brain bundle this attempt received at claim, exactly as recorded, with everything it left out and why. */
export function ContextPanel({ attemptId, port }: { attemptId: string | null; port: BrainPort | null }) {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'failed'; view: AttemptContextView | null }>({ phase: 'loading', view: null });
  useEffect(() => {
    if (!port || attemptId === null) return;
    let live = true;
    setState({ phase: 'loading', view: null });
    port.context(attemptId).then((view) => { if (live) setState({ phase: 'ready', view }); }, () => { if (live) setState({ phase: 'failed', view: null }); });
    return () => { live = false; };
  }, [port, attemptId]);
  const m = useMemo(() => contextModel(state.view), [state.view]);

  if (!port) return <p className="py-2 text-muted">This connection does not serve the Project Brain.</p>;
  if (attemptId === null) return <p className="py-2 text-muted">No attempt has run on this worker, so no context was delivered.</p>;
  if (state.phase === 'loading') return <p role="status" className="py-2 text-muted">Loading the context this attempt received</p>;
  if (state.phase === 'failed') return <p role="alert" className="py-2 text-danger">The context bundle could not be read. Nothing changed.</p>;
  if (!m) return <p className="py-2 text-muted" data-testid="context-none">No context bundle was recorded for this attempt.</p>;
  return (
    <div data-testid="drawer-context" className="space-y-4">
      <p className="text-sm text-muted">What this attempt received from the Project Brain at claim. The worker read it as quoted data, after its instructions: it cannot change rules, paths, grants or approvals.</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
        <dt className="text-muted">Destination</dt><dd className="m-0 text-fg">{m.destination}</dd>
        <dt className="text-muted">Compilation</dt><dd className="m-0 text-fg">{m.version}</dd>
        <dt className="text-muted">Index lag</dt><dd className="m-0 text-fg">{m.lag}</dd>
        <dt className="text-muted">Recorded</dt><dd className="m-0 text-fg"><time dateTime={m.recordedAt}>{formatExact(m.recordedAt)}</time></dd>
        <dt className="text-muted">Pinned to</dt><dd className="m-0 break-all font-mono text-mono text-fg">{m.pinned.length > 0 ? m.pinned.join(', ') : 'No source'}</dd>
      </dl>
      <section aria-labelledby="context-claims">
        <h3 id="context-claims" className="mb-1 font-medium text-fg">Claims delivered ({m.claims.length})</h3>
        {m.claims.length === 0 ? <p className="text-muted">None.</p> : (
          <ul className="space-y-2">
            {m.claims.map((c) => (
              <li key={c.claimId} data-testid="context-claim" data-key={c.key} className="rounded-chip border border-line p-2">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium wrap-anywhere text-fg">{c.heading}</span><Chip tone={c.status === 'Disputed' ? 'warning' : 'success'}>{c.status}</Chip></div>
                <p className="whitespace-pre-wrap wrap-anywhere text-fg">{c.text}</p>
                <p className="text-sm text-muted">{c.citations.map((x, i) => <span key={x.href}>{i > 0 ? ', ' : ''}<a className={LINK} href={x.href}>{x.label}</a></span>)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="context-omissions">
        <h3 id="context-omissions" className="mb-1 font-medium text-fg">Left out ({m.omissions.length})</h3>
        {m.omissions.length === 0 ? <p className="text-muted">Nothing was left out.</p> : (
          <ul className="divide-y divide-line">
            {m.omissions.map((o) => (
              <li key={`${o.kind}:${o.id}`} data-testid="context-omission" className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 break-all font-mono text-mono text-fg">{o.kind}: {o.id}</span>
                <span className="text-sm text-fg">{o.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
