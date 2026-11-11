// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md: the settings tab layout. The content of every tab is SelariKru's own.

import { useMemo, type ReactNode } from 'react';
import { Panel, TONE_TEXT } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt, ProjectViewSnapshot } from '@selarikru/view-protocol';
import { hrefFor, useHashQuery } from '../../shell/route.ts';
import type { ConnectionState, SkillsPort, StackPort } from '../../shell/projection-store.ts';
import { SETTINGS_MENU_EXTRA, SETTINGS_TABS, settingsHref, settingsSection, type SettingsTab } from '../../shell/views.ts';
import { FONT_STYLES, setFont, useFont } from '../../theme/fonts.ts';
import { SkillsSettings } from '../skills/SkillsSettings.tsx';
import { StackSettings } from '../stack/StackSettings.tsx';
import { ASSIGNMENTS_OFF, ModelAssignmentsPanel } from '../team/ModelAssignments.tsx';
import type { TeamModel } from '../team/model.ts';
import { autonomyModel } from './model.ts';

export interface SettingsPageProps {
  readonly stack: StackPort | null;
  readonly skills?: SkillsPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
  readonly projectLabel?: string;
  readonly snapshot?: ProjectViewSnapshot | null;
  readonly team?: TeamModel | null;
  /** The run's Bounded autonomy panel, the same one Overview and Team show. Null when the server reports no policy. */
  readonly autonomy?: ReactNode;
  readonly onOpenWorker?: ((workerId: string) => void) | undefined;
  readonly onExecute?: ((command: AuthorizedViewCommand) => Promise<CommandReceipt>) | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onResync?: (() => void) | undefined;
}

const link = 'text-active underline underline-offset-2';

/** A tab that cannot be backed yet says exactly what is missing. It never shows a control that does nothing. */
function NotBuilt({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Panel title={title} labelId={`settings-${id}-title`}>
      <div className="space-y-2 text-fg" data-testid={`settings-${id}-missing`}>{children}</div>
    </Panel>
  );
}

function Facts({ rows }: { rows: readonly { label: string; value: string; note?: string | null }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(10rem,auto)_minmax(0,1fr)]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-sm text-muted">{r.label}</dt>
          <dd className="m-0 wrap-anywhere text-fg">{r.value}{r.note ? <span className="block text-sm text-muted">{r.note}</span> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

function TeamTab({ team, connection, autonomy, onOpenWorker, onExecute, onRefresh, onResync }: Pick<SettingsPageProps, 'team' | 'connection' | 'autonomy' | 'onOpenWorker' | 'onExecute' | 'onRefresh' | 'onResync'>) {
  return (
    <div className="space-y-5">
      <Panel title="Workers" labelId="settings-workers-title" aside={<a className={link} href={hrefFor('team')}>Open the Team screen</a>}>
        {!team ? <p className="text-muted">No project data is connected, so no worker is shown.</p> : team.rows.length === 0 ? <p className="text-muted">No workers yet. They appear once a plan is accepted and a task starts.</p> : (
          <>
            <p className="mb-3 text-sm text-muted">Each worker's model, switches, Terminal and control mode are in its drawer.</p>
            <ul className="space-y-2" data-testid="settings-workers">
              {team.rows.map((r) => (
                <li key={r.workerId} className="flex flex-wrap items-center justify-between gap-2 border-2 border-line bg-panel-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-semibold text-fg">{r.role ? r.role.charAt(0).toUpperCase() + r.role.slice(1) : 'Unassigned'} <span className="font-mono text-mono font-normal text-muted">{r.workerId}</span></span>
                    <span className={`block text-sm ${TONE_TEXT[r.presence.tone]}`}>{r.presence.label}<span className="text-muted"> · {r.modelDetail ?? 'Model not recorded'}</span></span>
                  </span>
                  {onOpenWorker ? <button type="button" className="btn" data-open-worker={r.workerId} onClick={() => onOpenWorker(r.workerId)}>Open settings<span className="sr-only"> for {r.workerId}</span></button> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      {team && onExecute && onRefresh && onResync ? <ModelAssignmentsPanel model={team.assignments} disabledReason={connection === 'live' ? null : ASSIGNMENTS_OFF} onExecute={onExecute} onRefresh={onRefresh} onResync={onResync} idScope="settings" /> : null}
      {autonomy ?? (
        <Panel title="Bounded autonomy" labelId="settings-autonomy-title">
          <p className="text-muted" data-testid="settings-autonomy-missing">The server reports no policy for this run, so no limit is shown here. Nothing is invented in its place.</p>
        </Panel>
      )}
      <p className="text-sm text-muted">Knowledge and skills are part of the team: <a className={link} href={settingsHref('team', 'skills')}>open Knowledge and skills</a>.</p>
    </div>
  );
}

function WorkflowTab({ snapshot, connection }: { snapshot: ProjectViewSnapshot | null; connection: ConnectionState }) {
  const policy = useMemo(() => { try { return snapshot ? autonomyModel(snapshot, connection === 'live') : null; } catch { return null; } }, [snapshot, connection]);
  const pick = (key: string) => policy?.rows.find((r) => r.key === key);
  const rows = ['merge', 'repairAttempts', 'attemptTimeoutSeconds'].flatMap((k) => { const r = pick(k); return r ? [{ label: r.label, value: r.value, note: `${r.basis}${r.note ? `. ${r.note}` : ''}` }] : []; });
  const prs = snapshot?.changeRequests.length ?? 0;
  return (
    <div className="space-y-5">
      <Panel title="Review, merge and repair" labelId="settings-workflow-title">
        {rows.length > 0 ? <Facts rows={rows} /> : <p className="text-muted">The server reports no policy for this run, so its merge and repair rules are not shown.</p>}
        <p className="mt-3 text-sm text-muted">Change these in Bounded autonomy, under <a className={link} href={settingsHref('team')}>Team</a>. Agents never merge: a person merges on GitHub.</p>
      </Panel>
      <Panel title="Pull requests" labelId="settings-prs-title">
        <p className="text-fg">{prs === 0 ? 'No pull request has been opened for this project.' : `${prs} pull request${prs === 1 ? '' : 's'} on record.`} Each one and its evidence are in <a className={link} href={hrefFor('evidence')}>Evidence and PR</a>.</p>
      </Panel>
      <NotBuilt id="workflow" title="Not configurable here yet">
        <p>The verification checks, pull request rules and replan rules come from the accepted plan and the run's policy. This app has no controls for them yet, so none are shown.</p>
      </NotBuilt>
    </div>
  );
}

function SandboxTab({ snapshot, team, connection }: { snapshot: ProjectViewSnapshot | null; team: TeamModel | null; connection: ConnectionState }) {
  const policy = useMemo(() => { try { return snapshot ? autonomyModel(snapshot, connection === 'live') : null; } catch { return null; } }, [snapshot, connection]);
  const limit = snapshot?.limits.maxConcurrentTotal ?? null;
  const policyRows = ['maxConcurrentWorkers', 'cloudEligible', 'attemptTimeoutSeconds'].flatMap((k) => { const r = policy?.rows.find((x) => x.key === k); return r ? [{ label: r.label, value: r.value, note: r.basis }] : []; });
  const runners = team?.runners ?? [];
  return (
    <div className="space-y-5">
      <Panel title="Runtime and slots" labelId="settings-sandbox-title">
        <Facts rows={[
          { label: 'Concurrent slots', value: limit === null ? 'Not reported' : `${limit} at once, across locations`, note: limit === null ? 'Missing is never unlimited: work that needs a slot waits.' : null },
          ...policyRows,
        ]} />
      </Panel>
      <Panel title="Runners" labelId="settings-runners-title">
        {runners.length === 0 ? <p className="text-muted">No runner has enrolled for this project.</p> : (
          <ul className="space-y-1" data-testid="settings-runners">
            {runners.map((r) => (
              <li key={r.runnerId} className="text-fg">
                <span className="font-mono text-mono">{r.label ?? r.runnerId}</span>
                <span className="text-muted"> · {r.location === 'local' ? 'Local sandbox' : 'Cloud sandbox'} · {r.reachability === 'reachable' ? 'reachable' : r.reachability === 'not_reachable' ? 'not reachable' : 'reachability unknown'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <NotBuilt id="sandbox" title="Resources and handover">
        <p>Sandbox CPU and memory are not reported to this app, so no size is shown.</p>
        <p>Continue in cloud is offered per task, from a worker's drawer and from Pipeline. It has no settings of its own.</p>
      </NotBuilt>
    </div>
  );
}

function ProjectTab({ projectLabel, snapshot }: { projectLabel: string; snapshot: ProjectViewSnapshot | null }) {
  const font = useFont();
  return (
    <div className="space-y-5">
      <Panel title="Project" labelId="settings-project-title">
        <Facts rows={[{ label: 'Project', value: projectLabel }, { label: 'Project id', value: snapshot?.meta.projectId ?? 'No project data is connected' }]} />
        <ul className="mt-3 space-y-1 text-fg">
          <li><a className={link} href={hrefFor('product')}>Product brief and roadmap</a>: the brief, its revisions and the follow-ups.</li>
          <li><a className={link} href={hrefFor('onboarding')}>New project</a>: set up another project.</li>
        </ul>
      </Panel>
      <Panel title="Font" labelId="settings-font-title">
        <fieldset>
          <legend className="mb-2 text-sm text-muted">For panels, drawers, settings and terminals, in this browser only. The office keeps its pixel lettering.</legend>
          <div className="flex flex-wrap gap-2">
            {FONT_STYLES.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-start gap-2 border-2 border-line bg-panel-2 px-3 py-2">
                <input type="radio" name="font-style" value={f.id} checked={font === f.id} onChange={() => setFont(f.id)} className="mt-1" />
                <span><span className="block font-semibold text-fg">{f.label}</span><span className="block text-sm text-muted">{f.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </Panel>
    </div>
  );
}

/**
 * Settings, in the reference's tab set. Every existing setting keeps its behaviour and its rules: desired against effective, Applying until a
 * runner confirms, and the revoke rules all live in the panels shown here, unchanged.
 */
export function SettingsPage({ stack, skills = null, connection, mode, projectLabel = '', snapshot = null, team = null, autonomy = null, onOpenWorker, onExecute, onRefresh, onResync }: SettingsPageProps) {
  const query = useHashQuery();
  const { tab, sub } = settingsSection(query.get('section'));
  const current = (id: SettingsTab, s: 'skills' | null = null): boolean => tab === id && sub === s;
  return (
    <div data-testid="settings-page" data-tab={tab} className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-fg">Settings</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">Scope: this project. A worker's own model and switches are in its drawer, from the team panel.</p>
      </header>
      <div className="flex flex-col gap-5 md:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 gap-2 overflow-x-auto pb-1 md:w-[13rem] md:flex-col md:overflow-visible">
          {SETTINGS_TABS.map((t) => (
            <span key={t.id} className="contents">
              <a href={settingsHref(t.id)} aria-current={current(t.id) ? 'page' : undefined} className="btn shrink-0 flex-col items-start! px-2.5 py-1 text-left whitespace-normal md:w-full">
                <span className="text-base">{t.label}</span>
                <span aria-hidden="true" className="hidden text-xs font-normal text-muted md:block">{t.hint}</span>
              </a>
              {t.id === 'team' ? (
                <a href={settingsHref('team', 'skills')} aria-current={current('team', 'skills') ? 'page' : undefined} className="btn shrink-0 justify-start! px-2.5 py-1 text-left whitespace-normal md:ml-4 md:w-[calc(100%-1rem)]">
                  <span aria-hidden="true" className="hidden md:inline">↳</span> Knowledge and skills
                </a>
              ) : null}
            </span>
          ))}
          {/* For now Settings' menu also holds these two screens (owner, T5.12); each opens in its own drawer. */}
          <span aria-hidden="true" className="hidden border-t-2 border-line md:block" />
          {SETTINGS_MENU_EXTRA.map((e) => (
            <a key={e.route} href={hrefFor(e.route)} className="btn shrink-0 justify-start! px-2.5 py-1 text-left whitespace-normal md:w-full"><span className="text-base">{e.label}</span></a>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {tab === 'team' && sub === 'skills' ? <SkillsSettings port={skills} connection={connection} mode={mode} /> : null}
          {tab === 'team' && sub === null ? <TeamTab team={team} connection={connection} autonomy={autonomy} onOpenWorker={onOpenWorker} onExecute={onExecute} onRefresh={onRefresh} onResync={onResync} /> : null}
          {tab === 'workflow' ? <WorkflowTab snapshot={snapshot} connection={connection} /> : null}
          {tab === 'stack' ? <StackSettings port={stack} connection={connection} mode={mode} /> : null}
          {tab === 'mcp' ? (
            <NotBuilt id="mcp" title="MCP">
              <p className="font-semibold">No MCP connections yet. Connectors are not built.</p>
              <p className="text-muted">Workers get no MCP servers from SelariKru today, so nothing is connected and there is nothing to set here.</p>
            </NotBuilt>
          ) : null}
          {tab === 'sandbox' ? <SandboxTab snapshot={snapshot} team={team} connection={connection} /> : null}
          {tab === 'boards' ? (
            <NotBuilt id="boards" title="Boards">
              <p className="font-semibold">No Feedback Board is linked to this project.</p>
              <p className="text-muted">Feedback Board is a separate app with its own data. This app does not open it or read from it, so there is no link to set yet.</p>
            </NotBuilt>
          ) : null}
          {tab === 'project' ? <ProjectTab projectLabel={projectLabel} snapshot={snapshot} /> : null}
        </div>
      </div>
    </div>
  );
}
