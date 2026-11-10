// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { useUi } from '../ui-store.ts';

/** What the pointer is over in the office. Pointer only: the same words are in the team panel and the canvas label. */
export function Tooltip() {
  const hover = useUi((s) => s.hover);
  if (!hover) return null;
  return (
    <div aria-hidden="true" data-testid="office-tooltip" className="pointer-events-none fixed z-30 max-w-[340px] border-2 border-edge bg-panel px-2 py-0.5 text-sm text-fg shadow-[0_3px_0_var(--pixel-drop)]" style={{ left: hover.x + 14, top: hover.y + 16 }}>
      <div className="font-semibold">{hover.title}</div>
      {hover.sub ? <div className="truncate text-muted">{hover.sub}</div> : null}
    </div>
  );
}
