import { hrefFor, useHashQuery } from '../../shell/route.ts';
import type { ConnectionState, SkillsPort, StackPort } from '../../shell/projection-store.ts';
import { SkillsSettings } from '../skills/SkillsSettings.tsx';
import { StackSettings } from '../stack/StackSettings.tsx';

export interface SettingsPageProps {
  readonly stack: StackPort | null;
  readonly skills?: SkillsPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
}

const SECTIONS = [{ id: 'stack', label: 'Stack' }, { id: 'skills', label: 'Knowledge and skills' }] as const;

/** Settings. Stack and Knowledge and skills are built here; the run's controls and each worker's settings stay where they act, on Overview and in the worker drawer. */
export function SettingsPage({ stack, skills = null, connection, mode }: SettingsPageProps) {
  const query = useHashQuery();
  const section = query.get('section') === 'skills' ? 'skills' : 'stack';
  return (
    <div data-testid="settings-page" className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-fg">Settings</h1>
        <nav aria-label="Settings sections" className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line">
          {SECTIONS.map((s) => (
            <a key={s.id} href={s.id === 'stack' ? hrefFor('settings') : `${hrefFor('settings')}?section=${s.id}`} aria-current={section === s.id ? 'page' : undefined}
              className={`border-b-2 px-1 py-2 text-sm font-medium ${section === s.id ? 'border-active text-fg' : 'border-transparent text-muted hover:text-fg'}`}>{s.label}</a>
          ))}
        </nav>
        <p className="mt-2 max-w-prose text-sm text-muted">Scope: this project. Run controls and limits are in Bounded autonomy on <a className="text-active underline underline-offset-2" href={hrefFor('overview')}>Overview</a>; a worker's model and switches are in its drawer, from the team panel.</p>
      </header>
      {section === 'skills' ? <SkillsSettings port={skills} connection={connection} mode={mode} /> : <StackSettings port={stack} connection={connection} mode={mode} />}
    </div>
  );
}
