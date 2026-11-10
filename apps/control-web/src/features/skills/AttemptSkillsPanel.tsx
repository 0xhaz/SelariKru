import { useEffect, useMemo, useState } from 'react';
import { Chip } from '@selarikru/ui';
import type { AttemptSkillsView } from '@selarikru/view-protocol';
import type { SkillsPort } from '../../shell/projection-store.ts';
import { attemptPackRows } from './model.ts';

/** In the worker drawer: the knowledge packs this attempt received at claim, each with the digest the runner checked, and any revoked since. */
export function AttemptSkillsPanel({ attemptId, port }: { attemptId: string | null; port: SkillsPort | null }) {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'failed'; view: AttemptSkillsView | null }>({ phase: 'loading', view: null });
  useEffect(() => {
    if (!port || attemptId === null) return;
    let live = true;
    setState({ phase: 'loading', view: null });
    port.attempt(attemptId).then((view) => { if (live) setState({ phase: 'ready', view }); }, () => { if (live) setState({ phase: 'failed', view: null }); });
    return () => { live = false; };
  }, [port, attemptId]);
  const m = useMemo(() => attemptPackRows(state.view), [state.view]);
  if (!port || attemptId === null) return null;
  return (
    <section aria-labelledby="drawer-skills-title" data-testid="drawer-skills" className="space-y-2 border-b border-line pb-4">
      <h3 id="drawer-skills-title" className="font-medium text-fg">Knowledge packs</h3>
      {state.phase === 'loading' ? <p role="status" className="text-muted">Loading the packs this attempt received</p>
        : state.phase === 'failed' ? <p role="alert" className="text-danger">The packs this attempt received could not be read. Nothing changed.</p>
          : !m ? <p className="text-muted">No pack record exists for this attempt.</p>
            : (
              <>
                <p className="text-sm text-muted">Enabled for this task at claim, mounted read-only and checked against these digests before the worker started. Reference text only: they granted nothing.</p>
                {m.packs.length === 0 ? <p className="text-muted" data-testid="drawer-skills-none">No pack matched this task.</p> : (
                  <ul className="space-y-2">
                    {m.packs.map((p) => (
                      <li key={p.versionId} data-testid="drawer-skill" data-version={p.versionId} className="rounded-chip border border-line p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-fg wrap-anywhere">{p.title}</span>
                          <span className="flex flex-wrap gap-1.5"><Chip tone="active">Enabled for this task</Chip>{p.revoked ? <Chip tone="danger">Revoked since: this attempt keeps its pinned version</Chip> : null}</span>
                        </div>
                        <p className="break-all font-mono text-mono text-muted">sha256 {p.digest}</p>
                        <p className="break-all font-mono text-mono text-muted">{p.dir}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {m.omitted.length > 0 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted">Bound but not delivered ({m.omitted.length})</summary>
                    <ul className="mt-1 space-y-0.5">{m.omitted.map((o) => <li key={o.key} className="break-all font-mono text-mono text-fg">{o.text}</li>)}</ul>
                  </details>
                ) : null}
              </>
            )}
    </section>
  );
}
