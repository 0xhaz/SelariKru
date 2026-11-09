import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Chip, buttonQuiet, formatExact, type Tone } from '@selarikru/ui';
import { sanitizeTerminalText } from '@selarikru/domain';
import { TERMINAL_MAX_LINES, type AuthorizedTerminalRequest, type TerminalChannel, type TerminalReason, type TerminalState } from '@selarikru/view-protocol';

const CONNECTING: TerminalState = { status: 'connecting', reason: null, lastLineAt: null, dropped: 0 };

const CHIP: Readonly<Record<TerminalState['status'], { readonly label: string; readonly tone: Tone }>> = {
  connecting: { label: 'Connecting', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  ended: { label: 'Ended', tone: 'neutral' },
  disconnected: { label: 'Disconnected', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
};

const REASON: Readonly<Record<TerminalReason, string>> = {
  no_channel: 'This attempt has no live output to show. It may not have started sending any yet, or its output has aged out.',
  expired: 'This output aged out of the short server retention and is gone.',
  restricted: 'Output is not streamed for restricted or secret work. It stays on the worker’s machine.',
  runner_silent: 'The worker has stopped sending output.',
  session_expired: 'This view reached its time limit. Reconnect to keep watching.',
  connection_lost: 'The connection to the server dropped.',
  unauthorized: 'You are not allowed to view this output. Sign in again if that is unexpected.',
};

/** What this tab can do without a worker to connect to: say so, and never open a channel. */
function NoAttempt() {
  return <p className="py-2 text-muted">This worker has no attempt whose output could be shown.</p>;
}

/** Connected only while mounted, which is only while this tab is selected: leaving the tab or closing the drawer closes the channel. */
export function TerminalPanel({ target, onOpen }: { target: AuthorizedTerminalRequest | null; onOpen: (request: AuthorizedTerminalRequest) => Promise<TerminalChannel> }) {
  const [state, setState] = useState<TerminalState>(CONNECTING);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [simulated, setSimulated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const held = useRef<string[]>([]);
  const [heldCount, setHeldCount] = useState(0);
  const [hidden, setHidden] = useState(false);

  const show = (incoming: readonly string[]): void => {
    setLines((prev) => {
      const next = [...prev, ...incoming];
      const over = next.length - TERMINAL_MAX_LINES;
      if (over <= 0) return next;
      setHidden(true);
      return next.slice(over);
    });
  };
  const release = (): void => {
    if (held.current.length === 0) return;
    const waiting = held.current;
    held.current = [];
    setHeldCount(0);
    show(waiting);
  };

  useEffect(() => {
    if (target === null) return undefined;
    let cancelled = false;
    let channel: TerminalChannel | null = null;
    let unsubscribe: (() => void) | null = null;
    setState(CONNECTING);
    setLines([]);
    setHidden(false);
    pinned.current = true;
    held.current = [];
    setHeldCount(0);
    void (async () => {
      try {
        const opened = await onOpen(target);
        if (cancelled) {
          opened.close();
          return;
        }
        channel = opened;
        setSimulated(opened.simulated);
        const offLine = opened.onLine((raw) => {
          const line = sanitizeTerminalText(raw);
          // Trimming the top moves everything up, so nothing is trimmed under someone reading back: new lines wait until they return.
          if (pinned.current) { show([line]); return; }
          held.current.push(line);
          if (held.current.length > TERMINAL_MAX_LINES) { held.current.shift(); setHidden(true); }
          setHeldCount(held.current.length);
        });
        const offState = opened.onState(setState);
        unsubscribe = () => { offLine(); offState(); };
      } catch {
        if (!cancelled) setState({ status: 'unavailable', reason: 'no_channel', lastLineAt: null, dropped: 0 });
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      channel?.close();
    };
  }, [target?.attemptId, generation]);

  useEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);

  if (target === null) return <NoAttempt />;

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (pinned.current) release();
  };

  const chip = CHIP[state.status];
  const noOutput = state.status === 'live' && lines.length === 0 && state.lastLineAt === null;
  const reason = state.reason !== null ? REASON[state.reason] : null;
  let summary: ReactNode = null;
  if (state.status === 'connecting') summary = 'Connecting to the worker’s output.';
  else if (noOutput) summary = 'Connected. No output yet.';
  else if (state.status === 'ended') summary = 'The attempt has ended. Output is held briefly and then deleted.';
  else if (state.status === 'disconnected') summary = reason ?? 'Disconnected.';
  else if (state.status === 'unavailable') summary = reason ?? 'Live output is not available for this attempt.';

  return (
    <div data-testid="terminal-panel" data-status={state.status} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        {simulated ? <Chip tone="warning">Simulated</Chip> : null}
        {summary !== null ? <p className="text-sm text-muted" role="status">{summary}</p> : null}
        {state.status === 'disconnected' ? (
          <button type="button" className={buttonQuiet} onClick={() => setGeneration((g) => g + 1)}>Reconnect</button>
        ) : null}
        {state.status === 'unavailable' && state.reason === 'no_channel' ? (
          <button type="button" className={buttonQuiet} onClick={() => setGeneration((g) => g + 1)}>Check again</button>
        ) : null}
      </div>

      <p className="text-sm text-muted" data-testid="terminal-caveat">Known secret formats are hidden. Other sensitive values may still appear.</p>
      {state.status === 'disconnected' ? (
        <p className="text-sm text-fg" data-testid="terminal-last-line">{state.lastLineAt ? <>Last line at <time dateTime={state.lastLineAt}>{formatExact(state.lastLineAt)}</time>.</> : 'No line had arrived before the connection was lost.'}</p>
      ) : null}
      {simulated ? <p className="text-sm text-warning">Simulated data. It is not evidence.</p> : null}
      {state.dropped > 0 ? <p className="text-sm text-warning" data-testid="terminal-dropped">{state.dropped} {state.dropped === 1 ? 'line was' : 'lines were'} dropped to keep up. The worker was not slowed.</p> : null}

      {hidden ? <p className="text-sm text-muted" data-testid="terminal-older-hidden">Older lines are hidden. Showing the latest {TERMINAL_MAX_LINES}.</p> : null}
      {lines.length > 0 ? (
        <div ref={scroller} onScroll={onScroll} role="log" aria-label="Worker output" aria-live="off" tabIndex={0} data-testid="terminal-output" className="max-h-[55vh] overflow-y-auto rounded-chip border border-line bg-bg p-3">
          <ol className="m-0 list-none space-y-0.5 p-0 font-mono text-mono">
            {lines.map((line, i) => <li key={i} data-testid="terminal-line" className="whitespace-pre-wrap wrap-anywhere text-fg">{line === '' ? ' ' : line}</li>)}
          </ol>
        </div>
      ) : null}

      {heldCount > 0 ? <button type="button" className={buttonQuiet} data-testid="terminal-held" onClick={() => { pinned.current = true; release(); }}>Show {heldCount} new {heldCount === 1 ? 'line' : 'lines'}</button> : null}
      <p className="text-sm text-muted">Read-only. Nothing here reaches the worker, and output is never saved.</p>
    </div>
  );
}
