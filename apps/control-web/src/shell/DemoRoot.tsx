import { useMemo, useState } from 'react';
import { PLAYBACK_SPEEDS, usePlayback, type Playback } from './playback.ts';
import { buttonQuiet } from '@selarikru/ui';
import type { DemoSession } from '../data-source/demo.ts';
import { useDemoSession } from './demo-session.ts';
import { AppShell } from './AppShell.tsx';
import { OnboardingView } from '../features/onboarding/OnboardingView.tsx';
import { createDemoOnboardingApi } from '../features/onboarding/demo-api.ts';
import { createDemoSdk } from '../features/hybrid/demo-sdk.ts';

const params = (): URLSearchParams => new URLSearchParams(window.location.search);

/** Play/Pause and 1x/2x/4x for the demo's scripted timeline (the top bar's speed buttons drive the same control). Demo data only. */
function PlaybackControls({ playback }: { playback: Playback }) {
  const state = usePlayback(playback);
  if (!state) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Demo playback">
      <button type="button" className={buttonQuiet} aria-pressed={state.playing} onClick={() => (state.playing ? playback.pause() : playback.play())} data-testid="demo-play">{state.playing ? 'Pause' : 'Play'}</button>
      {PLAYBACK_SPEEDS.map((s) => <button key={s} type="button" className={buttonQuiet} aria-pressed={state.speed === s} onClick={() => playback.setSpeed(s)}>{s}x</button>)}
      <span className="text-sm text-muted">{state.playing ? `Playing the demo script at ${state.speed}x; it loops at the end.` : 'Paused.'} Demo data, never evidence.</span>
    </div>
  );
}

function DevPanel({ session, fixtureId, onFixture, onRestart, playback }: { session: DemoSession; fixtureId: string; onFixture: (id: string) => void; onRestart: () => void; playback: Playback | null }) {
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
      {playback ? <div className="mt-2"><PlaybackControls playback={playback} /></div> : null}
      {current ? <p className="mt-2 max-w-prose text-sm text-muted">{current.description}</p> : null}
    </aside>
  );
}

/** Dev only (`?demo`). No sign-in and no Firebase: the mock makes no network calls, and the live assistant is not mounted over it. */
export default function DemoRoot() {
  const demoOnboarding = useMemo(() => createDemoOnboardingApi(), []);
  // The task agents run through the real adapter over a stand-in SDK: no model and no network, and every answer is labelled demo data.
  const agentRuntime = useMemo(() => ({ sdk: createDemoSdk(), simulated: true }), []);
  const [fixtureId, setFixtureId] = useState(() => params().get('fixture') ?? 'healthy-parallel-work');
  const { session, project, store, playback } = useDemoSession(fixtureId);

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
    <AppShell store={store} mode="mock" agentRuntime={agentRuntime} projectLabel={project.name} assistant={null} onboarding={<OnboardingView api={demoOnboarding} adapter={null} hold={null} mode="mock" leaveDemoHref={leave.href} />} leaveDemoHref={leave.href} playback={playback} devPanel={<DevPanel session={session} fixtureId={project.fixtureId} onFixture={changeFixture} onRestart={store.getState().restart} playback={playback} />} />
  );
}
