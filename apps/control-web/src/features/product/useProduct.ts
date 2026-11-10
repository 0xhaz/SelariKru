import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductAction, ProductView } from '@selarikru/view-protocol';
import type { ProductPort } from '../../shell/projection-store.ts';

export interface ProductState {
  readonly view: ProductView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  reload(): void;
  /** Sends one write. Resolves null, with `error` set and the records read again, when it did not go through; else whether the server redacted text. */
  act(action: ProductAction): Promise<{ readonly redacted: boolean } | null>;
}

const messageOf = (e: unknown): string => {
  if (e instanceof Error && e.name === 'CommandNotSent') return 'Not sent: the connection is not live. Nothing changed.';
  const m = e instanceof Error ? e.message : '';
  return `Not saved${m ? `: ${m.slice(0, 200)}` : ''}. Nothing changed.`;
};

/** Loads the records when mounted and on `reload`; each write answers with the records as they are afterwards. Never polls. */
export function useProduct(port: ProductPort | null): ProductState {
  const [view, setView] = useState<ProductView | null>(null);
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
    port.load().then((v) => { if (alive.current) { setView(v); setError(null); } }, () => { if (alive.current) setError('The product records could not be read. Try again.'); }).finally(() => { if (alive.current) setLoading(false); });
  }, [port, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const act = useCallback(async (action: ProductAction): Promise<{ readonly redacted: boolean } | null> => {
    if (!port) return null;
    setBusy(true);
    try {
      const next = await port.act(action);
      if (alive.current) { setView(next.product); setError(null); }
      return { redacted: next.redacted };
    } catch (e) {
      if (alive.current) { setError(messageOf(e)); setNonce((n) => n + 1); }
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [port]);
  return { view, loading, error, busy, reload, act };
}
