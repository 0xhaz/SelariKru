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
  readonly focus: { readonly target: FocusTarget; readonly nonce: number } | null;
  readonly zoomRequest: { readonly delta: number; readonly nonce: number } | null;
}

export const useUi = create<UiState>(() => ({ hover: null, focus: null, zoomRequest: null }));

let nonce = 0;

export const ui = {
  setHover(hover: HoverInfo | null): void {
    useUi.setState({ hover });
  },
  zoom(delta: number): void {
    nonce += 1;
    useUi.setState({ zoomRequest: { delta, nonce } });
  },
  focus(target: FocusTarget): void {
    nonce += 1;
    useUi.setState({ focus: { target, nonce } });
  },
};
