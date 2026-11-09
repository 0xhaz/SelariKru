import { useId } from 'react';
import { buttonPrimary, buttonQuiet, formatClock } from '@selarikru/ui';
import type { DataSourceError } from '@selarikru/view-protocol';
import type { ConnectionState } from './projection-store.ts';
import { hrefFor } from './route.ts';

/** The way forward from an empty or unavailable screen. Under demo data the assistant is off, so that link would be a dead end. */
export function NextStep({ mode, leaveDemoHref, primary }: { mode: 'mock' | 'live'; leaveDemoHref?: string | undefined; primary?: boolean }) {
  const cls = primary ? buttonPrimary : buttonQuiet;
  if (mode === 'mock') return leaveDemoHref ? <a className={cls} href={leaveDemoHref}>Leave demo mode</a> : null;
  return <a className={cls} href={hrefFor('assistant')}>Open the Assistant</a>;
}

export const STATE_COPY = {
  unavailable: { live: 'The project could not be loaded from the server. No demo or placeholder data is shown in its place.', mock: 'The demo source did not return a snapshot.' },
};

export function ConnectionBanner({ connection, error, onRestart, observedAt }: { connection: ConnectionState; error: DataSourceError | null; onRestart: () => void; observedAt: string | null }) {
  const headingId = useId();
  if (connection !== 'reconnecting' && connection !== 'dead') return null;
  const dead = connection === 'dead';
  return (
    <section aria-labelledby={headingId} className={`mb-4 rounded-chip border border-l-4 p-3 ${dead ? 'border-danger bg-danger-tint' : 'border-warning bg-warning-tint'}`} data-testid="connection-banner">
      <h2 id={headingId} className={`font-medium ${dead ? 'text-danger' : 'text-warning'}`}>{dead ? 'The event stream stopped' : 'Reconnecting to the event stream'}</h2>
      <p className="mt-0.5 text-fg">
        {dead ? 'What you see is frozen at the last confirmed state' : 'Showing the last confirmed state'}{observedAt ? ` from ${formatClock(observedAt)}` : ''}. Worker health reads as unknown, and no action is taken on stale data.
      </p>
      {error ? <p className="mt-1 text-sm text-muted">Error category <span className="font-mono text-mono">{error.code}</span>{error.retryable ? ', retrying' : ', not retryable'}</p> : null}
      {dead ? <button type="button" className={`${buttonQuiet} mt-2`} onClick={onRestart}>Restart session</button> : null}
    </section>
  );
}
