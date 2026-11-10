import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Chip, EmptyState, Panel, buttonPrimary, buttonQuiet, formatExact } from '@selarikru/ui';
import {
  STACK_CATEGORIES, STACK_SECTION_LABELS, STACK_TARGET_LABELS, STACK_TARGETS, StackComponentPathSchema, stackCategory,
  type StackAction, type StackCategoryId, type StackComponent, type StackSection, type StackTarget,
} from '@selarikru/domain';
import type { StackView } from '@selarikru/view-protocol';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import type { ConnectionState, StackPort } from '../../shell/projection-store.ts';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';
import { inputClass } from '../onboarding/ui.tsx';
import { categoryRows, componentRows, detectionRows, type CategoryRow, type ItemRow, type SearchOption } from './model.ts';
import { StackSearch } from './StackSearch.tsx';
import { useStack } from './useStack.ts';

const Exact = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;
const GATE_TONE = { passed: 'success', not_run: 'neutral', incomplete: 'warning', not_assessed: 'neutral' } as const;

function Readiness({ item }: { item: ItemRow }) {
  const id = useId();
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-sm text-active underline underline-offset-2">Readiness<span className="sr-only"> of {item.label}</span></summary>
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {item.axes.map((a) => (
          <div key={a.name} className="contents">
            <dt className="text-muted">{a.name}</dt>
            <dd className="m-0 text-fg"><span className="font-medium">{a.label}.</span> {a.detail}</dd>
          </div>
        ))}
      </dl>
      {item.gates.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm" aria-label={`Target gates for ${item.label}`}>
          {item.gates.map((g) => <li key={g.target} className="flex flex-wrap items-baseline gap-2"><Chip tone={GATE_TONE[g.state]}>{STACK_TARGET_LABELS[g.target]}: {g.label}</Chip><span className="text-muted">{g.explanation}</span></li>)}
        </ul>
      ) : null}
      {item.disconnect ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className={buttonQuiet} disabled aria-describedby={`${id}-dc`}>Disconnect…<span className="sr-only"> {item.label}</span></button>
          <span id={`${id}-dc`} className="text-muted">{item.disconnect.explanation}</span>
        </p>
      ) : null}
    </details>
  );
}

function Category({ row, component, live, onAct }: { row: CategoryRow; component: StackComponent; live: boolean; onAct: (a: StackAction, done: string) => void }) {
  const legend = useId();
  const name = `stack-state-${component.path}-${row.id}`;
  const [asking, setAsking] = useState<'not_decided' | 'none' | null>(null);
  const apply = (state: 'not_decided' | 'none'): void => {
    const cleared = row.items.length > 0 ? ` Its ${row.items.length} selection${row.items.length === 1 ? ' was' : 's were'} removed from the record; no provider data was deleted.` : '';
    onAct({ kind: 'category.set', path: component.path, category: row.id, state }, `${row.label} for ${component.path}: ${state === 'none' ? 'None · not used' : 'Not decided'}.${cleared}`);
  };
  // Moving between Not decided and None loses nothing. Leaving a selection would clear it, and an arrow key on the radio group is enough to get here, so it asks first.
  const set = (state: 'not_decided' | 'none'): void => {
    if (state === row.state) return;
    if (row.items.length > 0) setAsking(state);
    else apply(state);
  };
  const n = row.items.length;
  return (
    <li data-testid="stack-category" data-category={row.id} data-state={row.state} className="rounded-chip border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={legend} className="font-medium text-fg">{row.label}</h3>
        <span role="radiogroup" aria-labelledby={legend} aria-describedby={row.state !== 'not_decided' ? `${legend}-x` : undefined} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <label className="inline-flex items-center gap-1.5"><input type="radio" name={name} checked={row.state === 'not_decided'} disabled={!live} onChange={() => set('not_decided')} />Not decided</label>
          <label className="inline-flex items-center gap-1.5"><input type="radio" name={name} checked={row.state === 'none'} disabled={!live} onChange={() => set('none')} />None · not used</label>
          <label className="inline-flex items-center gap-1.5 text-muted"><input type="radio" name={name} checked={row.state === 'selected'} disabled={row.state !== 'selected'} readOnly />{row.state === 'selected' ? row.stateLabel : 'Selected (search to add)'}</label>
        </span>
      </div>
      {asking !== null ? (
        <ConfirmDialog
          copy={{
            title: `Clear ${n} selection${n === 1 ? '' : 's'} from ${row.label}?`,
            consequence: `${row.label} for ${component.path} becomes ${asking === 'none' ? 'None · not used' : 'Not decided'}, and ${row.items.map((i) => i.label).join(', ')} ${n === 1 ? 'is' : 'are'} removed from the stack record. This deletes no provider data and revokes no credential.`,
            keepLabel: 'Keep the selections',
          }}
          confirmLabel={asking === 'none' ? 'Clear and set None' : 'Clear and set Not decided'}
          onConfirm={() => { const st = asking; setAsking(null); apply(st); }}
          onKeep={() => setAsking(null)}
        />
      ) : null}
      {row.state !== 'not_decided' ? <p id={`${legend}-x`} className="mt-1 text-sm text-muted">{row.explanation}</p> : null}
      {row.items.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {row.items.map((i) => (
            <li key={i.key} data-testid="stack-item" data-item={i.key} className="rounded-chip border border-line-strong bg-panel-2 p-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 wrap-anywhere text-fg"><span className="font-medium">{i.label}</span>{i.version ? <span className="font-mono text-mono text-muted"> {i.version}</span> : null}</p>
                <button type="button" className={buttonQuiet} disabled={!live} onClick={() => onAct({ kind: 'item.remove', path: component.path, category: row.id, key: i.key }, `Removed ${i.label} from ${row.label} for ${component.path}. No provider data was deleted and no credential was revoked.`)}>Remove<span className="sr-only"> {i.label} from {row.label}</span></button>
              </div>
              <p className="text-sm text-muted">{i.origin} · {i.summary} · <span>No reviewed skills</span></p>
              <Readiness item={i} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CustomEntry({ section, component, live, onAct }: { section: StackSection; component: StackComponent; live: boolean; onAct: (a: StackAction, done: string) => void }) {
  const id = useId();
  const cats = STACK_CATEGORIES.filter((c) => c.section === section);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<StackCategoryId>(cats[0]!.id);
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const l = label.trim();
    if (l === '') { setError('Name the entry.'); return; }
    if (source.trim() !== '' && !/^https:\/\/\S+$/.test(source.trim())) { setError('A canonical source must be an https link.'); return; }
    setError(null);
    onAct({ kind: 'item.add', path: component.path, category, item: { kind: 'custom', label: l, canonicalSource: source.trim() || null } }, `Recorded ${l} as a custom entry in ${stackCategory(category).label} for ${component.path}. It has no reviewed skills or tested commands.`);
    setLabel('');
    setSource('');
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-2 rounded-chip border border-line p-3" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="font-medium text-fg">Other/custom</h3>
      <p className="text-sm text-muted">For something the catalog lacks or an older project. It is recorded as you name it, with every readiness axis unknown, and implies no skills or commands.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-sm text-fg">Name<input className={`${inputClass} mt-1`} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="block text-sm text-fg">Category<select className={`${inputClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value as StackCategoryId)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="block text-sm text-fg">Canonical source (optional)<input className={`${inputClass} mt-1`} value={source} maxLength={300} placeholder="https://" onChange={(e) => setSource(e.target.value)} /></label>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button type="submit" className={buttonQuiet} disabled={!live}>Add custom entry</button>
    </form>
  );
}

function SectionPanel({ section, component, live, native, onAct }: { section: StackSection; component: StackComponent; live: boolean; native: StackView['native']; onAct: (a: StackAction, done: string) => void }) {
  const rows = useMemo(() => categoryRows(component, section, native), [component, section, native]);
  const toggle = (o: SearchOption): void => {
    if (o.selected) onAct({ kind: 'item.remove', path: component.path, category: o.category, key: o.entryId }, `Removed ${o.label} from ${o.categoryLabel} for ${component.path}. No provider data was deleted.`);
    else onAct({ kind: 'item.add', path: component.path, category: o.category, item: { kind: 'catalog', entryId: o.entryId } }, `Added ${o.label} to ${o.categoryLabel} for ${component.path}. Recorded only: nothing was connected, installed or run.`);
  };
  const labelId = `stack-${section}`;
  return (
    <Panel title={STACK_SECTION_LABELS[section]} labelId={labelId} aside={<span>For <span className="font-mono text-mono">{component.path}</span></span>}>
      <StackSearch section={section} label={`Search ${STACK_SECTION_LABELS[section].toLowerCase()} for ${component.name}`} component={component} disabled={!live} onToggle={toggle} />
      <ul className="mt-4 space-y-2" aria-label={`${STACK_SECTION_LABELS[section]} categories`}>
        {rows.map((r) => <Category key={r.id} row={r} component={component} live={live} onAct={onAct} />)}
      </ul>
      <CustomEntry section={section} component={component} live={live} onAct={onAct} />
    </Panel>
  );
}

function AddComponent({ live, onAct, taken }: { live: boolean; onAct: (a: StackAction, done: string) => void; taken: readonly string[] }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [targets, setTargets] = useState<StackTarget[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const p = path.trim() || '.';
    if (name.trim() === '') { setError('Name the component.'); return; }
    if (!StackComponentPathSchema.safeParse(p).success) { setError('Use . for the repository root, or a relative path such as apps/web, with no .. segment.'); return; }
    if (taken.includes(p)) { setError('A component already uses that path.'); return; }
    setError(null);
    onAct({ kind: 'component.upsert', path: p, name: name.trim(), targets, ...(restricted ? { classification: 'restricted' as const } : {}) }, `Added the component ${name.trim()} at ${p}. Every category starts Not decided.`);
    setName(''); setPath(''); setTargets([]); setRestricted(false);
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-2 rounded-chip border border-line p-3" aria-labelledby="stack-add-component">
      <h3 id="stack-add-component" className="font-medium text-fg">Add a component</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm text-fg">Component name<input className={`${inputClass} mt-1`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-sm text-fg">Repository path<input className={`${inputClass} mt-1 font-mono`} value={path} maxLength={120} placeholder="apps/web" onChange={(e) => setPath(e.target.value)} /></label>
      </div>
      <fieldset>
        <legend className="text-sm text-fg">Targets</legend>
        <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STACK_TARGETS.map((t) => <label key={t} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={targets.includes(t)} onChange={(e) => setTargets(e.target.checked ? [...targets, t] : targets.filter((x) => x !== t))} />{STACK_TARGET_LABELS[t]}</label>)}
        </span>
      </fieldset>
      <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" className="mt-0.5" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /><span>Restricted: its stack goes only to local workers whose output stays on this device</span></label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button type="submit" className={buttonQuiet} disabled={!live}>Add component</button>
    </form>
  );
}

export interface StackSettingsProps {
  readonly port: StackPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
}

/** Settings → Stack: what the target application is built with, per component. Recording only; setup and runtime tests are separate actions. */
export function StackSettings({ port, connection, mode }: StackSettingsProps) {
  const stack = useStack(port);
  const live = connection === 'live' && !stack.busy && stack.view?.unreadable !== true;
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const view = stack.view;
  const components = view?.document.components ?? [];
  useEffect(() => {
    if (components.length === 0) { if (editing !== null) setEditing(null); return; }
    if (editing === null || !components.some((c) => c.path === editing)) setEditing(components[0]!.path);
  }, [components, editing]);
  const component = components.find((c) => c.path === editing) ?? null;
  const rows = useMemo(() => (view ? componentRows(view) : []), [view]);
  const detection = useMemo(() => (view ? detectionRows(view) : null), [view]);
  const act = (a: StackAction, done: string): void => {
    void stack.act(a).then((ok) => {
      setNotice(ok ? done : '');
      if (ok && a.kind === 'component.upsert') setEditing(a.path);
    });
  };

  if (!port) return <EmptyState title="Stack settings are not available">This connection does not serve stack settings.</EmptyState>;
  return (
    <section aria-labelledby="stack-title" data-testid="stack-settings" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="stack-title" className="text-lg font-semibold text-fg">Stack</h2>
          <p className="mt-1 max-w-prose text-muted">What the project's application is built with, per component. Selecting records context for the workers on that component: it authenticates nothing, installs nothing, sends no request and changes no repository. Setup and runtime tests are separate actions.</p>
        </div>
        <DemoBadge mode={mode} testId="stack-demo-badge" />
      </header>
      {mode === 'mock' ? <p className="text-sm text-warning">Simulated stack and detection. Nothing here is evidence.</p> : null}
      <p role="status" aria-live="polite" data-testid="stack-notice" className="text-sm text-fg">{notice}</p>
      {stack.error ? <p role="alert" className="text-danger">{stack.error} <button type="button" className={buttonQuiet} onClick={stack.reload}>Read again</button></p> : null}
      {stack.loading && !view ? <p role="status" className="text-muted">Loading the stack settings</p> : null}
      {view?.unreadable ? <p role="alert" data-testid="stack-unreadable" className="text-danger">The stored stack settings cannot be read by this version, so they are shown as empty and nothing can be changed here. Nothing was written over them.</p> : null}
      {view ? (
        <>
          <Panel title="Selected components" labelId="stack-components" aside={`${components.length} component${components.length === 1 ? '' : 's'}`}>
            {components.length === 0 ? <p className="text-muted">No component yet. Add one, or confirm a detection below.</p> : (
              <fieldset>
                <legend className="text-sm text-muted">Component being edited below</legend>
                <ul className="mt-2 space-y-2">
                  {rows.map((c) => (
                    <li key={c.path} data-testid="stack-component" data-path={c.path} className="flex flex-wrap items-start justify-between gap-2 rounded-chip border border-line p-3">
                      <label className="flex min-w-0 items-start gap-2">
                        <input type="radio" name="stack-editing" className="mt-1" checked={editing === c.path} onChange={() => setEditing(c.path)} />
                        <span className="min-w-0">
                          <span className="block font-medium text-fg wrap-anywhere">{c.name} <span className="font-mono text-mono text-muted">{c.path}</span></span>
                          <span className="block text-sm text-muted">Targets: {c.targets} · {c.decided} decided · {c.undecided} not decided</span>
                          <span className="block text-sm text-muted wrap-anywhere">{c.toolchain}</span>
                          {c.restricted ? <span className="block text-sm text-fg">Restricted: local workers only</span> : null}
                          {c.gates.map((g) => <span key={g.target} className="mt-1 block text-sm text-warning">{STACK_TARGET_LABELS[g.target]} gate incomplete: {g.label}. <span className="text-muted">{g.explanation}</span></span>)}
                        </span>
                      </label>
                      <button type="button" className={buttonQuiet} disabled={!live} onClick={() => act({ kind: 'component.remove', path: c.path }, `Removed the component at ${c.path} from the stack record. Nothing in the repository or any provider changed.`)}>Remove<span className="sr-only"> component {c.path}</span></button>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            {detection && detection.commands.length > 0 ? (
              <div className="mt-4">
                <h3 className="font-medium text-fg">Build and test commands</h3>
                <p className="text-sm text-muted">Proposed from package.json scripts. They need review before they change anything, and nothing runs them: the verifier keeps its own commands.</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {detection.commands.map((c) => (
                    <li key={`${c.componentPath}:${c.kind}`} data-testid="stack-command" className="wrap-anywhere">
                      <span className="font-mono text-mono text-fg">{c.componentPath} · {c.kind}: {c.command}</span> <Chip tone="neutral">{c.status}</Chip>
                      <span className="block text-muted">From {c.evidencePath} scripts.{c.script}: <span className="font-mono text-mono">{c.body}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <AddComponent live={live} onAct={act} taken={components.map((c) => c.path)} />
          </Panel>

          <Panel title="Detected in the repository" labelId="stack-detected" aside={detection?.commit ? <span>Commit <span className="font-mono text-mono">{detection.commit}</span></span> : 'Nothing detected yet'}>
            {!detection || detection.items.length === 0 ? <p className="text-muted">A runner reports what it finds in manifests, lockfiles and config files at a task's base commit. It reads them as data and never runs a script.</p> : (
              <>
                <p className="text-sm text-muted">Read from manifests, lockfiles and config files{detection.detectedAt ? <> on <Exact iso={detection.detectedAt} /></> : null}. No script or package manager ran. Each is a proposal until you confirm it.</p>
                <ul className="mt-2 space-y-2">
                  {detection.items.map((d) => (
                    <li key={d.detectionId} data-testid="stack-detection" data-detection={d.detectionId} data-state={d.state} className="flex flex-wrap items-start justify-between gap-2 rounded-chip border border-line p-2">
                      <div className="min-w-0">
                        <p className="wrap-anywhere text-fg"><span className="font-medium">{d.label}</span>{d.version ? <span className="font-mono text-mono text-muted"> {d.version}</span> : null} <span className="text-sm text-muted">for <span className="font-mono text-mono">{d.componentPath}</span> · {d.category}</span></p>
                        <p className="break-all font-mono text-mono text-muted">{d.evidence}</p>
                      </div>
                      <span className="flex flex-wrap items-center gap-2">
                        <Chip tone={d.state === 'confirmed' ? 'success' : 'neutral'}>{d.stateLabel}</Chip>
                        {d.canSettle ? (
                          <>
                            <button type="button" className={buttonPrimary} disabled={!live} onClick={() => act({ kind: 'detection.confirm', detectionId: d.detectionId }, `Confirmed ${d.label} for ${d.componentPath}.`)}>Confirm<span className="sr-only"> {d.label} for {d.componentPath}</span></button>
                            <button type="button" className={buttonQuiet} disabled={!live} onClick={() => act({ kind: 'detection.dismiss', detectionId: d.detectionId }, `Dismissed ${d.label}.`)}>Dismiss<span className="sr-only"> {d.label}</span></button>
                          </>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {detection.skipped.length > 0 ? <p className="mt-2 text-sm text-muted">Not read: {detection.skipped.join('; ')}.</p> : null}
              </>
            )}
          </Panel>

          {component ? (
            <>
              <SectionPanel section="frameworks" component={component} live={live} native={view.native} onAct={act} />
              <SectionPanel section="services" component={component} live={live} native={view.native} onAct={act} />
            </>
          ) : null}
          <p className="text-sm text-muted">Revision {view.revision} · catalog {view.catalogVersion}{view.updatedAt ? <> · changed <Exact iso={view.updatedAt} /></> : null}. Skills appear here only once a reviewed binding exists; none does yet.</p>
        </>
      ) : null}
    </section>
  );
}
