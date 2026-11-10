import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandoverAction, HandoversView } from '@selarikru/view-protocol';
import type { HandoverPort } from '../../shell/projection-store.ts';
import { TRANSITIONAL } from './model.ts';

export interface HandoverState {
  readonly view: HandoversView | null;
  readonly error: string | null;
  readonly busy: boolean;
  act(action: HandoverAction): Promise<boolean>;
}

/** While a handover moves on its own (stopping, fenced, starting), it is read again this often; otherwise only when the projection moved or after an action. */
const MOVING_MS = 3_000;

const messageOf = (e: unknown): string => {
  if (e instanceof Error && e.name === 'CommandNotSent') return 'Not sent: the connection is not live. Nothing changed.';
  const m = e instanceof Error ? e.message : '';
  return `Not done${m ? `: ${m.slice(0, 240)}` : ''}. Nothing changed.`;
};

/** Reads the handovers when mounted, when `refreshKey` changes (the projection moved), and while one is moving on its own. Each action answers with the view afterwards. */
export function useHandovers(port: HandoverPort | null, refreshKey: string): HandoverState {
  const [view, setView] = useState<HandoversView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!port) return;
    port.load().then((v) => { if (alive.current) { setView(v); setError(null); } }, () => { if (alive.current) setError('The handovers could not be read. Try again.'); });
  }, [port, refreshKey, tick]);
  const moving = view?.tasks.some((t) => t.current !== null && TRANSITIONAL.includes(t.current.state)) ?? false;
  useEffect(() => {
    if (!moving) return;
    const id = setTimeout(() => setTick((n) => n + 1), MOVING_MS);
    return () => clearTimeout(id);
  }, [moving, view]);
  const act = useCallback(async (action: HandoverAction): Promise<boolean> => {
    if (!port) return false;
    setBusy(true);
    try {
      const next = await port.act(action);
      if (alive.current) { setView(next); setError(null); }
      return true;
    } catch (e) {
      if (alive.current) { setError(messageOf(e)); setTick((n) => n + 1); }
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [port]);
  return { view, error, busy, act };
}
