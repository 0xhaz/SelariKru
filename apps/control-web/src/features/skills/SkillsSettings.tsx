import { useId, useMemo, useState, type FormEvent } from 'react';
import { Chip, EmptyState, Panel, buttonDanger, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { SkillsView } from '@selarikru/view-protocol';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import type { ConnectionState, SkillsPort } from '../../shell/projection-store.ts';
import { inputClass } from '../onboarding/ui.tsx';
import { bindingOf, historyRows, packRows, type PackRow } from './model.ts';
import { useSkills } from './useSkills.ts';

export interface SkillsSettingsProps {
  readonly port: SkillsPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
}

function Intake({ live, onStage }: { live: boolean; onStage: (path: string) => void }) {
  const [path, setPath] = useState('');
  const id = useId();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (path.trim() !== '') onStage(path.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-describedby={`${id}-help`}>
      <label className="block text-sm text-fg">Local pack directory<input className={`${inputClass} mt-1 font-mono text-mono`} value={path} maxLength={1024} placeholder="/path/to/pack" onChange={(e) => setPath(e.target.value)} /></label>
      <p id={`${id}-help`} className="text-sm text-muted">The control plane reads the directory in place and scans it as text. Nothing is fetched, installed or run, and a staged pack can do nothing until you mark one exact version reviewed and bind it.</p>
      <button type="submit" className={buttonQuiet} disabled={!live || path.trim() === ''}>Stage pack</button>
    </form>
  );
}

function PackCard({ row, view, live, act }: { row: PackRow; view: SkillsView; live: boolean; act: (a: Parameters<ReturnType<typeof useSkills>['act']>[0], done: string) => void }) {
  const [ack, setAck] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const scoped = roles.length > 0 || paths.length > 0;
  const [reason, setReason] = useState('');
  const id = useId();
  const binding = bindingOf(view, row.skillId);
  const expected = binding?.desiredRevision ?? 0;
  return (
    <li data-testid="skill-row" data-version={row.versionId} className="rounded-chip border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-fg wrap-anywhere">{row.title}</h3>
          <p className="text-sm text-muted">{row.origin}</p>
        </div>
        <span className="flex flex-wrap gap-1.5" data-testid="skill-states" data-states={row.states.map((s) => s.id).join(" ")}>{row.states.map((s) => <Chip key={s.id} tone={s.tone}>{s.label}</Chip>)}</span>
      </div>
      {row.description ? <p className="mt-1 text-fg wrap-anywhere">{row.description}</p> : null}
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
        <dt className="text-muted">Digest</dt><dd className="m-0 break-all font-mono text-mono text-fg">{row.digest ?? 'None: the pack could not be described'}</dd>
        <dt className="text-muted">Files</dt><dd className="m-0 text-fg">{row.files}</dd>
        <dt className="text-muted">Source</dt><dd className="m-0 text-fg wrap-anywhere">{row.source}</dd>
        <dt className="text-muted">License</dt><dd className="m-0 text-fg">{row.license}</dd>
        <dt className="text-muted">Assumes tools</dt><dd className="m-0 text-fg">{row.tools}</dd>
        <dt className="text-muted">Triggers</dt><dd className="m-0 text-fg wrap-anywhere">{row.triggers}</dd>
        <dt className="text-muted">Binding</dt><dd className="m-0 text-fg" data-testid="skill-binding">{row.binding}</dd>
        {row.enabledFor ? <><dt className="text-muted">Enabled for</dt><dd className="m-0 text-fg">{row.enabledFor}</dd></> : null}
      </dl>
      {row.revocation ? <p className="mt-2 text-sm text-danger">{row.revocation}</p> : null}
      {row.scan ? (
        <div className="mt-2">
          <p className="text-sm text-fg" data-testid="skill-scan">{row.scan}</p>
          {row.findings.length > 0 ? (
            <ul className="mt-1 space-y-1 text-sm" aria-label={`Scan findings for ${row.title}`}>
              {row.findings.map((f) => (
                <li key={f.key} data-testid="skill-finding" className="wrap-anywhere"><Chip tone={f.severity === 'Blocks' ? 'danger' : 'warning'}>{f.severity}</Chip> <span className="font-mono text-mono text-muted">{f.where}</span> <span className="text-fg">{f.detail}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {row.canReview ? (
          <div className="space-y-1">
            {row.reviewFindings > 0 ? (
              <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I have read the {row.reviewFindings} finding{row.reviewFindings === 1 ? '' : 's'} for review. Platform policy still wins over this pack's text.</span></label>
            ) : null}
            <button type="button" className={buttonPrimary} disabled={!live || (row.reviewFindings > 0 && !ack)} onClick={() => act({ kind: 'review', versionId: row.versionId, acknowledgeFindings: ack }, `Marked ${row.title} reviewed. It can now be bound; nothing is delivered until it is.`)}>Mark {row.title} reviewed</button>
          </div>
        ) : null}
        {row.canBind ? (
          <fieldset className="space-y-1" {...(row.needsScope ? { "aria-describedby": `${id}-scope` } : {})}>
            <legend className="text-sm text-muted">Bind to this project{row.needsScope ? ', for these roles or paths' : ', optionally only for these roles or paths'}</legend>
            {row.needsScope ? <p id={`${id}-scope`} className="text-sm text-muted">A third-party pack declares no trigger we trust, so choose at least one role or path it serves.</p> : null}
            {view.roles.length > 0 ? (
              <span className="flex flex-wrap gap-3"><span className="text-sm text-muted">Roles:</span>
                {view.roles.map((r) => <label key={r} className="flex items-center gap-1.5 text-sm text-fg"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((xs) => (e.target.checked ? [...xs, r] : xs.filter((x) => x !== r)))} />{r}<span className="sr-only"> role for {row.title}</span></label>)}
              </span>
            ) : null}
            {view.paths.length > 0 ? (
              <span className="flex flex-wrap gap-3"><span className="text-sm text-muted">Paths:</span>
                {view.paths.map((p) => <label key={p} className="flex items-center gap-1.5 font-mono text-mono text-fg"><input type="checkbox" checked={paths.includes(p)} onChange={(e) => setPaths((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))} />{p}<span className="sr-only"> path for {row.title}</span></label>)}
              </span>
            ) : null}
            {row.needsScope && view.roles.length === 0 && view.paths.length === 0 ? <p className="text-sm text-warning">No roles or component paths exist yet to scope it to. Add a component under Stack, or plan tasks first.</p> : null}
            <button type="button" className={buttonQuiet} disabled={!live || (row.needsScope && !scoped)} onClick={() => act({ kind: 'bind', skillId: row.skillId, expectedRevision: expected, binding: { versionId: row.versionId, roles, paths } }, `Bound ${row.title}. In force now: the next claim of a matching task receives it, read-only.`)}>Bind {row.title}</button>
          </fieldset>
        ) : null}
        {row.bound ? (
          <button type="button" className={buttonQuiet} disabled={!live} onClick={() => act({ kind: 'bind', skillId: row.skillId, expectedRevision: expected, binding: null }, `Unbound ${row.title}. New claims no longer receive it; an attempt already running keeps it.`)}>Unbind {row.title}</button>
        ) : null}
        {row.canRevoke ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-sm text-fg" htmlFor={`${id}-reason`}>Reason to revoke {row.title}<input id={`${id}-reason`} className={`${inputClass} mt-1`} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
            <button type="button" className={buttonDanger} disabled={!live || reason.trim() === ''} onClick={() => act({ kind: 'revoke', versionId: row.versionId, reason: reason.trim() }, `Revoked ${row.title}. No new attempt starts with it; tasks it matched are blocked until it is unbound or replaced.`)}>Revoke {row.title}</button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Settings → Knowledge and skills: the curated catalog, staged third-party packs with their scan, review, bindings and revocation. */
export function SkillsSettings({ port, connection, mode }: SkillsSettingsProps) {
  const skills = useSkills(port);
  const live = connection === 'live' && !skills.busy;
  const [notice, setNotice] = useState('');
  const view = skills.view;
  const rows = useMemo(() => (view ? packRows(view) : []), [view]);
  const act = (a: Parameters<typeof skills.act>[0], done: string): void => {
    void skills.act(a).then((ok) => setNotice(ok ? done : ''));
  };
  if (!port) return <EmptyState title="The skill library is not available">This connection does not serve the skill library.</EmptyState>;
  const firstParty = rows.filter((r) => r.origin.startsWith('First party'));
  const thirdParty = rows.filter((r) => !r.origin.startsWith('First party'));
  return (
    <section aria-labelledby="skills-title" data-testid="skills-settings" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="skills-title" className="text-lg font-semibold text-fg">Knowledge and skills</h2>
          <p className="mt-1 max-w-prose text-muted">Knowledge packs are reference text for workers, pinned by digest. A task receives only the bound, reviewed packs whose triggers match its stack, role, paths and actions, mounted read-only. A pack grants no tool, path or approval, and platform policy wins over anything it says.</p>
        </div>
        <DemoBadge mode={mode} testId="skills-demo-badge" />
      </header>
      {mode === 'mock' ? <p className="text-sm text-warning">Simulated library. The staged pack is a demo fixture and nothing here is evidence.</p> : null}
      <p role="status" aria-live="polite" data-testid="skills-notice" className="text-sm text-fg">{notice}</p>
      {skills.error ? <p role="alert" className="text-danger">{skills.error} <button type="button" className={buttonQuiet} onClick={skills.reload}>Read again</button></p> : null}
      {skills.loading && !view ? <p role="status" className="text-muted">Loading the skill library</p> : null}
      {view && view.waitingForRunnerUpdate.length > 0 ? (
        <p role="alert" data-testid="skills-waiting" className="text-warning">Waiting for runner update: {view.waitingForRunnerUpdate.join(', ')}. This build cannot deliver knowledge packs, so it gets no task a bound pack applies to until it is updated.</p>
      ) : null}
      {view ? (
        <>
          <Panel title="Curated library" labelId="skills-library" aside={`${firstParty.length} packs`}>
            <ul className="space-y-3">{firstParty.map((r) => <PackCard key={r.versionId} row={r} view={view} live={live} act={act} />)}</ul>
          </Panel>
          <Panel title="Staged third-party packs" labelId="skills-staged" aside={`${thirdParty.length} staged`}>
            <Intake live={live} onStage={(path) => act({ kind: 'intake', path }, 'Staged the pack and scanned it. It is Available or Blocked, and does nothing until a version is reviewed and bound.')} />
            {thirdParty.length === 0 ? <p className="mt-3 text-muted">Nothing staged.</p> : <ul className="mt-3 space-y-3">{thirdParty.map((r) => <PackCard key={r.versionId} row={r} view={view} live={live} act={act} />)}</ul>}
          </Panel>
          <Panel title="History" labelId="skills-history" aside={`${view.history.length} action${view.history.length === 1 ? '' : 's'}`}>
            {view.history.length === 0 ? <p className="text-muted">No action yet.</p> : (
              <ol className="space-y-1 text-sm" data-testid="skills-history">
                {historyRows(view).map((h) => <li key={h.key} data-testid="skills-history-row" className="wrap-anywhere text-fg"><time className="text-muted" dateTime={h.at}>{h.at}</time> {h.text}</li>)}
              </ol>
            )}
          </Panel>
        </>
      ) : null}
    </section>
  );
}
