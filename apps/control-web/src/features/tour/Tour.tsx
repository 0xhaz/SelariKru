import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { buttonPrimary, buttonQuiet } from '@selarikru/ui';
import { officeOnScreen } from '../../office/OfficeCanvas.tsx';
import { connectivity } from '../checkpoints/connectivity.ts';
import { EMPTY_CHECKPOINT_STORE } from '../checkpoints/engine.ts';
import { useHybrid } from '../hybrid/context.tsx';
import { TOUR_FIXTURE, TOUR_OFFLINE_TASK, TOUR_STEPS, markTourOffered, tourOffered, tourStartHref } from './tour.ts';

/** Who opens the tour: the top bar's "Start the tour", the first-visit offer, or `?tour=1` after the switch to the tour's demo project. */
export const tourStore = createStore<{ open: boolean; step: number }>()(() => ({
  open: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tour') === '1',
  step: 0,
}));

/** Starts the tour: here when this is already the tour's demo project, otherwise on it (one page load: the demo data is the tour's). */
export function startTour(projectId: string): void {
  markTourOffered();
  if (projectId === `demo-${TOUR_FIXTURE}`) { tourStore.setState({ open: true, step: 0 }); return; }
  window.location.assign(tourStartHref(window.location.href));
}

type Rect = { x: number; y: number; w: number; h: number };

function targetRect(target: string): Rect | null {
  if (target === 'roof:device') return officeOnScreen.scene?.roofBoxOnScreen('device') ?? null;
  const el = document.querySelector<HTMLElement>(target);
  if (!el || el.getClientRects().length === 0) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * H9 item 4: the guide. A non-modal card with Back, Next and Close (Escape closes too), focus on its heading at every step, and a ring round the real element
 * each step is about. No animation: it honours reduced motion by having none. Step 4 runs a real (demo-data) step offline, then reconnects.
 */
export function Tour({ projectId, simulated, onOffice }: { projectId: string; simulated: boolean; onOffice: boolean }) {
  const { open, step } = useStore(tourStore);
  const hybrid = useHybrid();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [ring, setRing] = useState<Rect | null>(null);
  const [offer, setOffer] = useState(() => !tourStore.getState().open && !tourOffered());
  const [offline, setOffline] = useState<'idle' | 'running' | 'waiting' | 'sent'>('idle');
  const wentOffline = useRef(false);
  const checkpoints = useStore(hybrid?.checkpoints?.store ?? EMPTY_CHECKPOINT_STORE, (s) => s.checkpoints);
  const s = TOUR_STEPS[step]!;

  useEffect(() => {
    if (!open) return;
    // Focus lands on the step's heading once the screen it moved to has taken focus for itself (a route change focuses its main region).
    let frame = 0;
    const focus = (): void => { frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => heading.current?.focus()); }); };
    const moving = window.location.hash !== s.hash;
    if (moving) { window.addEventListener('hashchange', focus, { once: true }); window.location.hash = s.hash; } else focus();
    return () => { window.removeEventListener('hashchange', focus); cancelAnimationFrame(frame); };
  }, [open, step, s.hash]);
  // Escape closes the tour wherever focus is, unless a dialog or menu of the page has it.
  const closeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && !t.closest('[data-testid="tour"]') && (t.closest('dialog, [role="dialog"], [aria-expanded="true"]') || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  // The element may render a moment later, and moves with the camera or a scroll: followed while the tour is open.
  useEffect(() => {
    if (!open) { setRing(null); return; }
    const follow = (): void => setRing(targetRect(s.target));
    follow();
    const timer = window.setInterval(follow, 250);
    return () => window.clearInterval(timer);
  }, [open, s.target]);
  // Sent after reconnecting, as the checkpoint records it.
  useEffect(() => {
    if (offline === 'waiting' && Object.values(checkpoints).some((c) => c.taskId === TOUR_OFFLINE_TASK && c.status === 'sent')) setOffline('sent');
  }, [checkpoints, offline]);

  const close = (): void => {
    markTourOffered();
    if (wentOffline.current) { connectivity.getState().simulateOffline(false); wentOffline.current = false; }
    tourStore.setState({ open: false, step: 0 });
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) { url.searchParams.delete('tour'); window.history.replaceState(null, '', url); }
  };
  closeRef.current = close;
  const goOffline = async (): Promise<void> => {
    if (!hybrid?.agents) return;
    setOffline('running');
    wentOffline.current = true;
    connectivity.getState().simulateOffline(true);
    await hybrid.agents.run({ taskId: TOUR_OFFLINE_TASK, kind: 'criteria', callOverride: null });
    setOffline('waiting');
  };
  const reconnect = (): void => {
    wentOffline.current = false;
    connectivity.getState().simulateOffline(false);
  };

  if (!open) {
    // Offered once, on the office (the first screen), so it never sits over another screen's controls.
    if (!offer || !onOffice) return null;
    return (
      <section aria-labelledby={`${id}-offer`} data-testid="tour-offer" className="panel pointer-events-auto fixed bottom-4 right-4 z-50 w-[min(340px,calc(100vw-32px))] p-4">
        <h2 id={`${id}-offer`} className="text-[15px] font-semibold text-fg">New here? Take the two-minute tour</h2>
        <p className="mt-1 text-sm text-muted">Six steps on demo data: where each AI call runs, what stays on this device, and what happens offline.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={buttonPrimary} onClick={() => { setOffer(false); startTour(projectId); }}>Start the tour</button>
          <button type="button" className={buttonQuiet} onClick={() => { setOffer(false); markTourOffered(); }}>Not now</button>
        </div>
      </section>
    );
  }
  return (
    <>
      {ring ? <div aria-hidden="true" data-testid="tour-ring" className="pointer-events-none fixed z-[45] rounded-[6px] border-4 border-gold shadow-[0_0_0_3px_rgba(43,29,20,0.85)]" style={{ left: ring.x - 6, top: ring.y - 6, width: ring.w + 12, height: ring.h + 12 }} /> : null}
      <section role="dialog" aria-modal="false" aria-labelledby={`${id}-h`} aria-describedby={`${id}-b`} data-testid="tour" data-step={step + 1}
        className="panel pointer-events-auto fixed bottom-4 left-4 z-50 w-[min(380px,calc(100vw-32px))] p-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">Tour · step {step + 1} of {TOUR_STEPS.length}</p>
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1} className="mt-1 text-[16px] font-semibold text-fg outline-none">{s.title}</h2>
        <p id={`${id}-b`} className="mt-1 text-sm text-fg">{s.body}</p>
        {s.offline ? (
          <div className="mt-2 space-y-2" data-testid="tour-offline">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonQuiet} disabled={offline !== 'idle' || !hybrid?.agents} onClick={() => void goOffline()}>Go offline and run a Cloud only step</button>
              <button type="button" className={buttonQuiet} disabled={offline !== 'waiting'} onClick={reconnect}>Reconnect</button>
            </div>
            <p role="status" className="text-sm text-fg" data-testid="tour-offline-status">
              {offline === 'running' ? 'Running the step offline…' : offline === 'waiting' ? 'Waiting in Paused AI work: not an error. Reconnect to send it.' : offline === 'sent' ? 'Sent after reconnecting.' : ''}
            </p>
          </div>
        ) : null}
        {simulated ? <p className="mt-2 text-[12px] text-muted">Demo data: never evidence.</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={buttonQuiet} disabled={step === 0} onClick={() => tourStore.setState({ step: step - 1 })}>Back</button>
          {step < TOUR_STEPS.length - 1
            ? <button type="button" className={buttonPrimary} onClick={() => tourStore.setState({ step: step + 1 })}>Next</button>
            : <button type="button" className={buttonPrimary} onClick={close}>Finish</button>}
          <button type="button" className={`${buttonQuiet} ml-auto`} onClick={close}>Close the tour</button>
        </div>
      </section>
    </>
  );
}
