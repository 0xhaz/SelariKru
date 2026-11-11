// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md: the side drawer (resize handle, maximise) and the centred settings modal.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { hrefFor } from '../route.ts';
import { DRAWER_DEFAULT, ui, useUi } from '../ui-store.ts';

function MaximizeButton() {
  const max = useUi((s) => s.drawerMaximized);
  const label = max ? 'Restore size' : 'Maximize';
  return (
    <button type="button" className="btn hidden h-[30px] w-[34px] place-items-center px-0 xl:grid" aria-label={label} title={label} aria-pressed={max} onClick={() => ui.toggleDrawerMaximized()} data-testid="drawer-maximize">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        {max ? <><rect x="1" y="4" width="9" height="9" /><path d="M4 4V1h9v9h-3" /></> : <rect x="1" y="1" width="12" height="12" />}
      </svg>
    </button>
  );
}

/** The drawer's left edge: drag to resize (remembered in this browser), double-click for the default width. Pointer only; Maximize is the key path. */
function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null);
  // However a drag ends, text selection comes back: on release, on a lost capture, and if the drawer closes mid-drag.
  useEffect(() => () => { document.body.style.userSelect = ''; }, []);
  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width: aside.getBoundingClientRect().width };
    document.body.style.userSelect = 'none';
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (start.current) ui.setDrawerWidth(start.current.width + (start.current.x - e.clientX));
  };
  const up = (): void => {
    start.current = null;
    document.body.style.userSelect = '';
  };
  return (
    <div
      aria-hidden="true" data-testid="drawer-resize" title="Drag to resize. Double-click to reset."
      className="group absolute -left-[9px] top-0 z-10 hidden h-full w-[12px] cursor-col-resize justify-center xl:flex"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onDoubleClick={() => ui.setDrawerWidth(DRAWER_DEFAULT)}
    >
      <div className="my-auto h-12 w-[4px] bg-ink opacity-0 group-hover:opacity-60" />
    </div>
  );
}

const CLOSE = 'btn grid h-[30px] place-items-center px-2.5';

/**
 * A screen in the reference's right-side drawer, over the office. It is the screen's route, so it can be linked to; ✕ or Escape on the page go
 * back to the office. Below the floating layout's width it is a full-width panel in the page.
 */
export function ViewDrawer({ view, title, paused, children, after, aside = null }: { view: string; title: string; paused: ReactNode; children: ReactNode; after?: ReactNode; aside?: string | null }) {
  const width = useUi((s) => s.drawerWidth);
  const maximized = useUi((s) => s.drawerMaximized);
  return (
    <div
      data-testid="view-drawer" data-view={view}
      className={`panel pointer-events-auto relative z-20 m-0 flex min-w-0 flex-col xl:fixed xl:top-[74px] xl:right-4 xl:bottom-4 ${maximized ? 'xl:left-4' : 'xl:w-[var(--drawer-w)]'}`}
      style={{ ['--drawer-w' as string]: `min(${width}px, calc(100vw - 32px))` }}
    >
      {maximized ? null : <ResizeHandle />}
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
        <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b-[3px] border-ink px-3 py-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate" aria-hidden="true"><b className="text-[15px] text-fg">{title}</b>{aside ? <span className="text-[13px] text-muted" data-testid="view-drawer-aside">{aside}</span> : null}</span>
          <span className="hidden text-[13px] text-muted 2xl:inline" data-testid="view-drawer-keys"><kbd className="kbd">Esc</kbd> on the page closes</span>
          <MaximizeButton />
          <a href={hrefFor('office')} className={CLOSE} aria-label="Close, back to the office" data-testid="view-drawer-close">✕</a>
        </div>
        <div className="scroll-thin min-h-0 flex-1 xl:overflow-y-auto">
          <div className="@container mx-auto max-w-[1320px] px-4 py-5 sm:px-5">{children}</div>
          {after}
        </div>
      </main>
      {paused}
    </div>
  );
}

/** Settings: the reference's centred modal over the office. The rest of the app is inert while it is open, so focus stays inside it. */
export function SettingsModal({ children, paused }: { children: ReactNode; paused: ReactNode }) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-30 grid place-items-center bg-[rgba(36,26,46,0.55)] p-2 sm:p-4" data-testid="settings-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) window.location.hash = hrefFor('office'); }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" data-shell-modal="" tabIndex={-1} data-testid="view-drawer" data-view="settings" className="panel relative flex outline-none h-[min(760px,calc(100dvh-1rem))] w-[min(1080px,100%)] flex-col sm:h-[min(760px,calc(100dvh-2rem))]">
        <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          <div className="flex shrink-0 items-center gap-3 border-b-[3px] border-ink px-4 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted"><kbd className="kbd">Esc</kbd> on the page closes</span>
            <a href={hrefFor('office')} className={CLOSE} aria-label="Close settings" data-testid="view-drawer-close">✕</a>
          </div>
          <div className="scroll-thin @container min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
        </main>
        {paused}
      </div>
    </div>
  );
}
