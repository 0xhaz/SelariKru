// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import type { ConnectionState } from '../projection-store.ts';

/**
 * Over the office while the stream is not live, so the picture is never read as current. Not a live region: the shell's announcer already
 * says each change of connection once.
 */
export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  if (connection !== 'reconnecting' && connection !== 'dead') return null;
  const text = connection === 'dead' ? 'The stream stopped. The office shows the last confirmed state.' : 'Connection lost, trying again. The office shows the last confirmed state.';
  return (
    <p data-testid="office-connection-banner" className="pointer-events-auto border-[3px] border-edge bg-danger-tint px-3 py-1 text-sm font-semibold text-fg shadow-[0_3px_0_var(--pixel-drop)]">
      <span aria-hidden="true" className="text-danger">▲ </span>{text}
    </p>
  );
}
