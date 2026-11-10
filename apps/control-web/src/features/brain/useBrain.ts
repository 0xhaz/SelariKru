import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainAction, BrainView } from '@selarikru/view-protocol';
import type { BrainPort } from '../../shell/projection-store.ts';

export interface BrainState {
  readonly view: BrainView | null;
  readonly loading: boolean;
  /** Null when the last load or action went through. */
  readonly error: string | null;
  reload(): void;
  /** Sends an action and shows the Brain it answers with. Resolves false, with `error` set, when it did not go through. */
  act(action: BrainAction): Promise<boolean>;
}

const messageOf = (e: unknown): string => (e instanceof Error && e.name === 'CommandNotSent' ? 'Not sent: the connection is not live. Nothing changed.' : 'The Project Brain could not be reached. Nothing changed; try again.');

/** Loads the Brain when mounted and on `reload`. Never polls: the Brain changes only when its sources do, and the view says how fresh it is. */
export function useBrain(port: BrainPort | null): BrainState {
  const [view, setView] = useState<BrainView | null>(null);
  const [loading, setLoading] = useState(port !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!port) return;
    setLoading(true);
    port.load().then((v) => { if (alive.current) { setView(v); setError(null); } }, (e: unknown) => { if (alive.current) setError(messageOf(e)); }).finally(() => { if (alive.current) setLoading(false); });
  }, [port, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const act = useCallback(async (action: BrainAction): Promise<boolean> => {
    if (!port) return false;
    try {
      const v = await port.act(action);
      if (alive.current) { setView(v); setError(null); }
      return true;
    } catch (e) {
      if (alive.current) setError(messageOf(e));
      return false;
    }
  }, [port]);
  return { view, loading, error, reload, act };
}
