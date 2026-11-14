import { useId } from 'react';
import { useStore } from 'zustand';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { CheckpointEngine } from './engine.ts';
import { pausedRows } from './model.ts';
import { useOnlineNow } from './connectivity.ts';

/**
 * H12: "Paused AI work", the third group of Action items. Each AI step that stopped (offline, too large for this device, a local result that failed its checks, a
 * changed route, the budget) with what resuming would send (sizes and labels only for restricted work) and Resume, Move to device only and Drop. Inside the accepted
 * plan a step is sent on its own after reconnecting; outside it, it waits here.
 */
export function PausedWork({ engine, titleOf, simulated }: { engine: CheckpointEngine; titleOf: (taskId: string) => string; simulated: boolean }) {
  const id = useId();
  const state = useStore(engine.store);
  const online = useOnlineNow();
  const rows = pausedRows(state, titleOf, online);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-t`} data-testid="paused-work" className="mt-6">
      <h2 id={`${id}-t`} className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Paused AI work</h2>
      <p className="mb-2 text-sm text-muted">
        {online ? 'Each step is checked again before anything is sent: its route, the data lock, the budget, and whether its inputs changed.' : 'You are offline. Steps that need the cloud wait here and are not errors; they are checked again and sent once you reconnect.'}
        {simulated ? ' Demo data: simulated, never evidence.' : ''}
      </p>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} data-testid="paused-row" data-checkpoint-id={r.id} className="rounded-card border border-line bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={r.tone}>{r.stop}</Chip>
              {r.restricted ? <Chip tone="warning">Restricted: on this device only</Chip> : null}
              <span className="font-medium text-fg" data-testid="paused-headline">{r.headline}</span>
            </div>
            <p className="mt-1 text-sm text-muted" data-testid="paused-sends">Would send: {r.sends}</p>
            {r.problems.map((p) => <p key={p} className="mt-1 text-sm text-warning" data-testid="paused-problem">{p}</p>)}
            {r.abandoned ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={buttonPrimary} disabled={r.busy} onClick={() => void engine.runAgain(r.id)}>Run again</button>
                <button type="button" className={buttonQuiet} onClick={() => engine.dismiss(r.id)}>Dismiss</button>
              </div>
            ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {r.escalate === null
                ? <button type="button" className={buttonPrimary} disabled={r.busy} onClick={() => void engine.escalate(r.id)}>Escalate to cloud</button>
                : <button type="button" className={r.resume === null ? buttonPrimary : buttonQuiet} disabled={r.busy || r.resume !== null} title={r.resume ?? undefined} onClick={() => void engine.resume(r.id)}>Resume</button>}
              <button type="button" className={buttonQuiet} disabled={r.busy || r.moveToDevice !== null} title={r.moveToDevice ?? undefined} onClick={() => void engine.moveToDevice(r.id)}>Move to device only</button>
              <button type="button" className={buttonQuiet} disabled={r.busy} onClick={() => void engine.drop(r.id)}>Drop</button>
            </div>
            )}
            {!r.abandoned && r.resume !== null && r.escalate !== null ? <p className="mt-1 text-sm text-muted">{r.resume}</p> : null}
            {!r.abandoned && r.moveToDevice !== null ? <p className="mt-1 text-sm text-muted" data-testid="paused-move-off">{r.moveToDevice}</p> : null}
            {r.busy ? <p role="status" className="mt-1 text-sm text-fg">Sending…</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
