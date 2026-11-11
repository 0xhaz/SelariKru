// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Pointer input for the office: drag to pan, wheel to zoom, hover and click on things. The keyboard path to the same places is the team
// panel and the top bar; the canvas adds nothing they lack.

import type { Hit, PxRect } from './layout/layout.ts';
import type { OfficeScene } from './OfficeScene.ts';

export interface SceneHooks {
  /** A robot or a desk was clicked: open that worker's drawer. */
  readonly onOpenWorker: (workerId: string) => void;
  /** The plan wall, the gate or the PR board was clicked. */
  readonly onOpenPlace: (place: 'plan' | 'prs') => void;
  readonly onHover: (info: { title: string; sub?: string; x: number; y: number } | null) => void;
}

type Target = { hit: Hit; rect: PxRect };

const inside = (r: PxRect, x: number, y: number): boolean => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

function hitTest(s: OfficeScene, sx: number, sy: number): Target | null {
  const l = s.layout;
  if (!l) return null;
  const { x, y } = s.camera.screenToWorld(sx, sy);
  const bots = [...s.bots.values()].sort((a, b) => b.y - a.y);
  for (const b of bots) {
    const rect = s.botRect(b);
    if (inside(rect, x, y)) return { hit: { kind: 'agent', id: b.config.id, rect }, rect };
  }
  for (const h of l.hits) if (inside(h.rect, x, y)) return { hit: h, rect: h.rect };
  return null;
}

function activate(s: OfficeScene, hit: Hit): void {
  if (hit.kind === 'agent') s.hooks.onOpenWorker(hit.id);
  else if (hit.kind === 'env') {
    // A rack is a worker's sandbox: it opens that worker.
    const id = s.layout?.racks.find((r) => r.name === hit.id)?.agentId;
    if (id) s.hooks.onOpenWorker(id);
  }
  else if (hit.kind === 'plan' || hit.kind === 'lead') s.hooks.onOpenPlace('plan');
  else s.hooks.onOpenPlace('prs');
}

export function attachInput(s: OfficeScene): () => void {
  const el = s.canvas;
  let down: { x: number; y: number; lastX: number; lastY: number; dragging: boolean } | null = null;

  const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const updateHover = (e: PointerEvent): void => {
    const p = local(e);
    const target = hitTest(s, p.x, p.y);
    s.hover = target ? { rect: target.rect, agentId: target.hit.kind === 'agent' ? target.hit.id : null } : null;
    el.style.cursor = down?.dragging ? 'grabbing' : target ? 'pointer' : 'grab';
    s.hooks.onHover(target ? { ...s.describe(target.hit.kind, target.hit.kind === 'env' ? s.layout?.racks.find((r) => r.name === target.hit.id)?.agentId ?? target.hit.id : target.hit.id), x: e.clientX, y: e.clientY } : null);
    s.invalidate();
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = local(e);
    down = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, dragging: false };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (down) {
      const p = local(e);
      if (!down.dragging && Math.hypot(p.x - down.x, p.y - down.y) > 4) down.dragging = true;
      if (down.dragging) {
        s.camera.panBy(p.x - down.lastX, p.y - down.lastY);
        down.lastX = p.x;
        down.lastY = p.y;
        el.style.cursor = 'grabbing';
        s.hooks.onHover(null);
        s.invalidate();
        return;
      }
    }
    updateHover(e);
  };
  const onUp = (e: PointerEvent): void => {
    const wasDrag = down?.dragging;
    down = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (wasDrag) return updateHover(e);
    const p = local(e);
    const target = hitTest(s, p.x, p.y);
    if (target) {
      s.hooks.onHover(null);
      activate(s, target.hit);
    }
  };
  const onLeave = (): void => {
    s.hover = null;
    s.hooks.onHover(null);
    s.invalidate();
  };
  let wheelAcc = 0;
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Whole zoom steps: one per ~80px of scroll so trackpads do not race.
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 80) return;
    s.camera.zoomBy(wheelAcc < 0 ? 1 : -1, local(e));
    wheelAcc = 0;
    s.invalidate();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.style.cursor = 'grab';
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('wheel', onWheel);
  };
}
