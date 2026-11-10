import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillActionView, SkillsView } from '@selarikru/view-protocol';
import type { SkillsPort } from '../../shell/projection-store.ts';

export interface SkillsState {
  readonly view: SkillsView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  reload(): void;
  /** Sends one action. Resolves false, with `error` set and the library read again, when it did not go through. */
  act(action: SkillActionView): Promise<boolean>;
}

const messageOf = (e: unknown): string => {
  if (e instanceof Error && e.name === 'CommandNotSent') return 'Not sent: the connection is not live. Nothing changed.';
  const m = e instanceof Error ? e.message : '';
  return `Not done${m ? `: ${m.slice(0, 200)}` : ''}. Nothing changed.`;
};

/** Loads the library when mounted; each action answers with the library as it is afterwards. */
export function useSkills(port: SkillsPort | null): SkillsState {
  const [view, setView] = useState<SkillsView | null>(null);
  const [loading, setLoading] = useState(port !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!port) return;
    setLoading(true);
    port.load().then((v) => { if (alive.current) setView(v); }, () => { if (alive.current) setError('The skill library could not be read. Try again.'); }).finally(() => { if (alive.current) setLoading(false); });
  }, [port, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const act = useCallback(async (action: SkillActionView): Promise<boolean> => {
    if (!port) return false;
    setBusy(true);
    try {
      const next = await port.act(action);
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
