// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import type { ReactNode } from 'react';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import type { OfficeWorld } from '../../office/model.ts';
import type { ConnectionState } from '../projection-store.ts';

function JsonNode({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (value === null || typeof value !== 'object') {
    const color = typeof value === 'string' ? '#8fd89a' : typeof value === 'number' ? '#f2c45a' : '#f2a48a';
    return <div className="truncate pl-3"><span className="text-feed-soft">{name}: </span><span style={{ color }}>{JSON.stringify(value)}</span></div>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return (
    <details open={depth < 1} className="pl-3">
      <summary className="cursor-pointer text-paper">{name} <span className="text-feed-soft">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span></summary>
      {entries.map(([k, v]) => <JsonNode key={k} name={k} value={v} depth={depth + 1} />)}
    </details>
  );
}

/** Development only: the demo controls and what the shell is reading. Not part of the product, and never in a production build. */
export function DebugPanel({ connection, snapshot, world, onClose, children }: { connection: ConnectionState; snapshot: ProjectViewSnapshot | null; world: OfficeWorld | null; onClose: () => void; children?: ReactNode }) {
  return (
    <section aria-label="Debug" data-testid="debug-panel" className="panel-dark pointer-events-auto relative z-[15] mx-3 my-3 flex flex-col overflow-hidden xl:fixed xl:bottom-4 xl:left-4 xl:m-0 xl:max-h-[60vh] xl:w-[280px]">
      <div className="flex items-center justify-between border-b-2 border-ink px-3 py-1.5">
        <h2 className="text-[13px] uppercase tracking-[0.14em] text-feed-soft">Debug · development only</h2>
        <button type="button" className="btn px-2 text-[13px]" onClick={onClose} aria-label="Close debug panel">✕</button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {children ? <div className="bg-paper p-1 text-ink">{children}</div> : null}
        <details className="font-mono text-[15px] leading-tight text-paper">
          <summary className="cursor-pointer text-paper">State</summary>
          <JsonNode name="connection" value={connection} depth={1} />
          <JsonNode name="office" value={world ? { banner: world.banner, running: world.running, agents: world.agents.map((a) => `${a.name}: ${a.label}`), parcels: world.parcels, prs: world.prs } : null} depth={1} />
          <JsonNode name="snapshot.meta" value={snapshot?.meta ?? null} depth={1} />
        </details>
      </div>
    </section>
  );
}
