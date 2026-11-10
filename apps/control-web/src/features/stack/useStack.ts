import { useCallback, useEffect, useRef, useState } from 'react';
import type { StackAction } from '@selarikru/domain';
import type { StackView } from '@selarikru/view-protocol';
import type { StackPort } from '../../shell/projection-store.ts';

export interface StackState {
  readonly view: StackView | null;
  readonly loading: boolean;
  /** Null when the last load or change went through. */
  readonly error: string | null;
  readonly busy: boolean;
  reload(): void;
  /** Sends one change against the revision on screen. Resolves false, with `error` set and the stack read again, when it did not go through. */
  act(action: StackAction): Promise<boolean>;
}

const messageOf = (e: unknown): string => {
  if (e instanceof Error && e.name === 'CommandNotSent') return 'Not sent: the connection is not live. Nothing changed.';
  const m = e instanceof Error ? e.message : '';
  return /changed since/i.test(m) ? 'The stack changed since it was read, so nothing was saved. It has been read again; try once more.' : `Not saved${m ? `: ${m.slice(0, 160)}` : ''}. Nothing changed.`;
};

/** Loads the stack when mounted. Each change is sent against the revision on screen, so two edits never overwrite each other silently. */
export function useStack(port: StackPort | null): StackState {
  const [view, setView] = useState<StackView | null>(null);
  const [loading, setLoading] = useState(port !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  const current = useRef<StackView | null>(null);
  current.current = view;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!port) return;
    setLoading(true);
    port.load().then((v) => { if (alive.current) { setView(v); setError(null); } }, () => { if (alive.current) setError('The stack settings could not be read. Try again.'); }).finally(() => { if (alive.current) setLoading(false); });
  }, [port, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const act = useCallback(async (action: StackAction): Promise<boolean> => {
    const v = current.current;
    if (!port || !v) return false;
    setBusy(true);
    try {
      const next = await port.act({ expectedRevision: v.revision, action });
      if (alive.current) { setView(next); setError(null); }
      return true;
    } catch (e) {
      if (alive.current) { setError(messageOf(e)); setNonce((n) => n + 1); }
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [port]);
  return { view, loading, error, busy, reload, act };
}
