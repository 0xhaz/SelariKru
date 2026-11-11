// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Presentation-only state the office canvas and the HUD share: what the pointer is over, and zoom and focus requests for the camera.
// It holds no project data; that stays in the projection store.

import { create } from 'zustand';

export interface HoverInfo {
  readonly title: string;
  readonly sub?: string;
  readonly x: number;
  readonly y: number;
}

/** Something in the office the camera can fly to. */
export type FocusTarget = { readonly kind: 'agent'; readonly id: string } | { readonly kind: 'home' };

interface UiState {
  readonly hover: HoverInfo | null;
  /** The side drawer's width in px, remembered in this browser; `drawerMaximized` fills the screen. */
  readonly drawerWidth: number;
  readonly drawerMaximized: boolean;
  readonly focus: { readonly target: FocusTarget; readonly nonce: number } | null;
  readonly zoomRequest: { readonly delta: number; readonly nonce: number } | null;
}

const WIDTH_KEY = 'selarikru.drawerWidth';
export const DRAWER_MIN = 420;
/** Wider than the reference's 520 px: the run summary's tables and the pipeline graph need the room. */
export const DRAWER_DEFAULT = 760;

/** Room left for the team panel when the drawer is as wide as it gets. */
export const drawerMax = (): number => Math.max(DRAWER_MIN, window.innerWidth - 32);

function savedWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= DRAWER_MIN ? v : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}

export const useUi = create<UiState>(() => ({ hover: null, focus: null, zoomRequest: null, drawerWidth: savedWidth(), drawerMaximized: false }));

let nonce = 0;

export const ui = {
  setHover(hover: HoverInfo | null): void {
    useUi.setState({ hover });
  },
  zoom(delta: number): void {
    nonce += 1;
    useUi.setState({ zoomRequest: { delta, nonce } });
  },
  setDrawerWidth(px: number): void {
    const w = Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, px)));
    useUi.setState({ drawerWidth: w, drawerMaximized: false });
    try {
      window.localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* a private window applies it until reload */
    }
  },
  toggleDrawerMaximized(): void {
    useUi.setState((s) => ({ drawerMaximized: !s.drawerMaximized }));
  },
  focus(target: FocusTarget): void {
    nonce += 1;
    useUi.setState({ focus: { target, nonce } });
  },
};
