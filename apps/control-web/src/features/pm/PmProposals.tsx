import { useState } from 'react';
import { buttonPrimary, buttonQuiet } from '@selarikru/ui';
import { DataSourceException } from '@selarikru/view-protocol';
import { CommandNotSent } from '../../shell/projection-store.ts';
import { NOT_SENT_MESSAGE } from '../decisions/copy.ts';
import { useHybrid } from '../hybrid/context.tsx';
import { pmRefusal } from './copy.ts';
import { pmProposals, proposalRows } from './proposals.ts';

/**
 * H11 fix round 1 (I3): in Action items, the Project Manager's assignments that were not applied. Assign sends the owner's own delegation, through the same plan rule
 * as the PM's (the server may still refuse it, and says why); Dismiss drops the proposal. Nothing is assigned until you choose.
 */
export function PmProposals() {
  const h = useHybrid();
  const items = pmProposals((s) => s.items);
  const rows = proposalRows(h?.snapshot ?? null, items);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  if (rows.length === 0) return null;
  async function assign(id: string, runId: string, planRevision: number, taskId: string, workerId: string): Promise<void> {
    if (!h?.agents?.assign) return;
    setBusy(id);
    try {
      const r = await h.agents.assign(runId, { planRevision, assignments: [{ taskId, workerId }] });
      if (r.applied.length > 0) { pmProposals.getState().dismiss(id); h.refresh(); }
      else setSaid((s) => ({ ...s, [id]: `Not assigned. ${pmRefusal(r.refused[0]?.reason ?? 'unknown')}` }));
    } catch (e) {
      const code = /^([a-z_]+):/.exec(e instanceof DataSourceException ? e.detail.message : e instanceof Error ? e.message : '')?.[1];
      setSaid((s) => ({ ...s, [id]: e instanceof CommandNotSent ? NOT_SENT_MESSAGE : `Not assigned. ${pmRefusal(code ?? 'unknown')}` }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby="pm-proposals-title" data-testid="pm-proposals" className="mb-6">
      <h2 id="pm-proposals-title" className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">From the Project Manager</h2>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-card border-2 border-line bg-panel p-3" data-testid="pm-proposal">
            <p className="font-medium text-fg">{r.text}</p>
            <p className="text-sm text-muted">{r.why} It is a proposal: nothing changes until you assign it.</p>
            {said[r.id] ? <p role="status" className="text-sm text-warning">{said[r.id]}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={buttonPrimary} disabled={busy !== null || !h?.agents?.assign} title={!h?.agents?.assign ? 'This source cannot assign tasks.' : undefined}
                onClick={() => void assign(r.id, r.runId, r.planRevision, r.taskId, r.workerId)}>Assign{busy === r.id ? ' · Sending' : ''}</button>
              <button type="button" className={buttonQuiet} disabled={busy !== null} onClick={() => pmProposals.getState().dismiss(r.id)}>Dismiss</button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
