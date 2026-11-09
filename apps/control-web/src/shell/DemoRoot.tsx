import { useEffect, useMemo, useState } from 'react';
import { buttonQuiet } from '@selarikru/ui';
import { DEMO_FAULTS, loadDemoSession, type DemoFault, type DemoSession } from '../data-source/demo.ts';
import { AppShell } from './AppShell.tsx';
import { createProjectionStore } from './projection-store.ts';

const params = (): URLSearchParams => new URLSearchParams(window.location.search);

function DevPanel({ session, fixtureId, onFixture, onRestart }: { session: DemoSession; fixtureId: string; onFixture: (id: string) => void; onRestart: () => void }) {
  const current = session.projects.find((p) => p.fixtureId === fixtureId);
  return (
    <aside aria-label="Demo controls" className="rounded-card border border-dashed border-line-strong p-3">
      <p className="text-sm font-medium text-muted">Development only. Not part of the product.</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="demo-fixture" className="mb-1 block text-sm text-muted">Fixture</label>
          <select id="demo-fixture" value={fixtureId} onChange={(e) => onFixture(e.target.value)} className="rounded-chip border border-line-strong bg-bg px-2 py-2 text-fg">
            {session.projects.map((p) => <option key={p.fixtureId} value={p.fixtureId}>{p.name}</option>)}
          </select>
        </div>
        <button type="button" className={buttonQuiet} onClick={() => session.advance(10_000)}>Advance 10 s</button>
        <button type="button" className={buttonQuiet} onClick={onRestart}>Restart projection</button>
      </div>
      {current ? <p className="mt-2 max-w-prose text-sm text-muted">{current.description}</p> : null}
    </aside>
  );
}

/** Dev only (`?demo`). No sign-in and no Firebase: the mock makes no network calls, and the live assistant is not mounted over it. */
export default function DemoRoot() {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [fixtureId, setFixtureId] = useState(() => params().get('fixture') ?? 'healthy-parallel-work');
  useEffect(() => {
    const raw = params().get('fault');
    const fault = (DEMO_FAULTS as readonly string[]).includes(raw ?? '') ? (raw as DemoFault) : null;
    let cancelled = false;
    let loaded: DemoSession | null = null;
    void loadDemoSession(fault).then((s) => {
      if (cancelled) return s?.close();
      loaded = s;
      setSession(s);
    });
    return () => {
      cancelled = true;
      loaded?.close();
    };
  }, []);

  const project = session ? (session.projects.find((p) => p.fixtureId === fixtureId) ?? session.projects[0]!) : null;
  const store = useMemo(() => (session && project ? createProjectionStore({ source: session.source, projectId: project.projectId, clock: session.clockFor(project.projectId), every: session.every }) : null), [session, project?.projectId]);
  useEffect(() => {
    if (!store) return;
    store.getState().start();
    return () => store.getState().stop();
  }, [store]);

  if (!session || !store || !project) return <p role="status" className="p-6 text-muted">Loading demo data</p>;
  function changeFixture(id: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('fixture', id);
    window.history.replaceState(null, '', url);
    setFixtureId(id);
  }
  const leave = new URL(window.location.href);
  leave.search = '';
  return (
    <AppShell store={store} mode="mock" projectLabel={project.name} assistant={null} leaveDemoHref={leave.href} devPanel={<DevPanel session={session} fixtureId={project.fixtureId} onFixture={changeFixture} onRestart={store.getState().restart} />} />
  );
}
