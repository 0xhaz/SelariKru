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
    <section aria-label="Office connection" className="contents">
    <p data-testid="office-connection-banner" className="z-50 mx-3 mt-3 border-2 border-ink bg-danger-tint px-3 py-1 text-[14px] font-semibold text-fg rounded-[4px] shadow-[2px_3px_0_rgba(43,29,20,0.22)] xl:fixed xl:left-1/2 xl:top-[68px] xl:mx-0 xl:mt-0 xl:-translate-x-1/2">
      <span aria-hidden="true" className="text-danger">▲ </span>{text}
    </p>
    </section>
  );
}
