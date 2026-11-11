// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { useEffect, useRef } from 'react';
import { ui, useUi } from '../shell/ui-store.ts';
import type { Insets } from './engine/camera.ts';
import type { OfficeWorld } from './model.ts';
import { OfficeScene } from './OfficeScene.ts';

export interface OfficeCanvasProps {
  readonly world: OfficeWorld | null;
  /** Room the HUD covers on each side, so the camera centres the office in what is left. */
  readonly insets: Insets;
  readonly onOpenWorker: (workerId: string) => void;
  readonly onOpenPlace: (place: 'plan' | 'prs') => void;
  /** True on the office screen, where the canvas is the subject. Behind a drawer it is decoration and hidden from assistive technology. */
  readonly subject: boolean;
  /** True while the office cannot be seen (a maximised drawer, the Settings modal): its animation stops. */
  readonly paused: boolean;
  /** Demo only: 1x, 2x or 4x on the office animation. */
  readonly speed: number;
}

/**
 * The pixel office behind every screen. A picture of what the team panel lists: it has role="img" and a summary label, and the team panel is
 * its keyboard path. Mounted once; it follows the world it is given.
 */
export function OfficeCanvas({ world, insets, onOpenWorker, onOpenPlace, subject, paused, speed }: OfficeCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const latest = useRef({ insets, onOpenWorker, onOpenPlace });
  latest.current = { insets, onOpenWorker, onOpenPlace };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new OfficeScene(el, {
      onOpenWorker: (id) => latest.current.onOpenWorker(id),
      onOpenPlace: (p) => latest.current.onOpenPlace(p),
      onHover: (h) => ui.setHover(h),
    }, () => latest.current.insets);
    scene.current = s;
    // Dev builds only: lets the Playwright specs find a robot on screen. Never in a production bundle.
    if (import.meta.env.DEV) (window as unknown as { __selarikruOffice?: OfficeScene }).__selarikruOffice = s;
    const off = useUi.subscribe((st, prev) => {
      if (st.zoomRequest && st.zoomRequest !== prev.zoomRequest) s.zoomBy(st.zoomRequest.delta);
      if (st.focus && st.focus !== prev.focus) {
        if (st.focus.target.kind === 'agent') s.focusAgent(st.focus.target.id);
        else s.home();
      }
    });
    return () => {
      off();
      ui.setHover(null);
      s.destroy();
      scene.current = null;
      if (import.meta.env.DEV) delete (window as unknown as { __selarikruOffice?: OfficeScene }).__selarikruOffice;
    };
  }, []);

  useEffect(() => {
    if (world) scene.current?.setWorld(world);
  }, [world]);

  useEffect(() => {
    scene.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    if (scene.current) scene.current.speed = speed;
  }, [speed]);

  useEffect(() => {
    scene.current?.camera.apply();
    scene.current?.invalidate();
  }, [insets.left, insets.right, insets.top, insets.bottom]);

  // A named region, so the picture sits in a landmark; its role="img" label is the summary the office screen also shows in words.
  return (
    <section aria-label={subject ? 'Office floor' : undefined} aria-hidden={subject ? undefined : true} className="contents">
      <div ref={host} data-testid="office-canvas" data-office-canvas="" role="img" aria-label={world?.summary ?? 'Office: no project data yet.'} className="fixed inset-0 z-0 overflow-hidden bg-grass" />
    </section>
  );
}
