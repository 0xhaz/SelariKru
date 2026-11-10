import { hrefFor } from '../../shell/route.ts';
import type { ConnectionState, StackPort } from '../../shell/projection-store.ts';
import { StackSettings } from '../stack/StackSettings.tsx';

export interface SettingsPageProps {
  readonly stack: StackPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
}

/** Settings. Stack is the panel built here; the run's controls and each worker's settings stay where they act, on Overview and in the worker drawer. */
export function SettingsPage({ stack, connection, mode }: SettingsPageProps) {
  return (
    <div data-testid="settings-page" className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-fg">Settings</h1>
        <nav aria-label="Settings sections" className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line">
          <a href={`${hrefFor('settings')}`} aria-current="page" className="border-b-2 border-active px-1 py-2 text-sm font-medium text-fg">Stack</a>
        </nav>
        <p className="mt-2 max-w-prose text-sm text-muted">Scope: this project. Run controls and limits are in Bounded autonomy on <a className="text-active underline underline-offset-2" href={hrefFor('overview')}>Overview</a>; a worker's model and switches are in its drawer, from the team panel.</p>
      </header>
      <StackSettings port={stack} connection={connection} mode={mode} />
    </div>
  );
}
