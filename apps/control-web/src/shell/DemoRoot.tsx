import { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYBACK_SPEEDS, createPlayback, usePlayback, type Playback } from './playback.ts';
import { buttonQuiet } from '@selarikru/ui';
import { DEMO_FAULTS, loadDemoSession, type DemoFault, type DemoSession } from '../data-source/demo.ts';
import { AppShell } from './AppShell.tsx';
import { OnboardingView } from '../features/onboarding/OnboardingView.tsx';
import { createDemoOnboardingApi } from '../features/onboarding/demo-api.ts';
import { createProjectionStore } from './projection-store.ts';
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
  const [session, setSession] = useState<DemoSession | null>(null);
  const demoOnboarding = useMemo(createDemoOnboardingApi, []);
  // The task agents run through the real adapter over a stand-in SDK: no model and no network, and every answer is labelled demo data.
  const agentRuntime = useMemo(() => ({ sdk: createDemoSdk(), simulated: true }), []);
  const [fixtureId, setFixtureId] = useState(() => params().get('fixture') ?? 'healthy-parallel-work');
  // Loops the script: a new key loads a fresh session, which starts the fixture over. The old one stays on screen until the new one is ready.
  const [round, setRound] = useState(0);
  const live = useRef<{ session: DemoSession | null; projectId: string | null }>({ session: null, projectId: null });
  // Created in an effect, so a development double mount stops the extra one cleanly.
  const [playback, setPlayback] = useState<Playback | null>(null);
  useEffect(() => {
    const pb = createPlayback({
      advance: (ms) => live.current.session?.advance(ms),
      remaining: () => (live.current.session && live.current.projectId ? live.current.session.remaining(live.current.projectId) : 1),
      restart: () => setRound((r) => r + 1),
      every: (fn, ms) => { const id = window.setInterval(fn, ms); return () => window.clearInterval(id); },
      now: () => performance.now(),
      // Playing at 1x by default; paused under reduced motion (and so in the test suite).
      playing: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    setPlayback(pb);
    // Turning on reduced motion during the session pauses the demo (round 2). Turning it off leaves the choice to the person: Play resumes.
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = (e: MediaQueryListEvent): void => { if (e.matches) pb.pause(); };
    motion.addEventListener('change', onMotion);
    return () => { motion.removeEventListener('change', onMotion); pb.stop(); };
  }, []);
  useEffect(() => {
    const raw = params().get('fault');
    const fault = (DEMO_FAULTS as readonly string[]).includes(raw ?? '') ? (raw as DemoFault) : null;
    let cancelled = false;
    void loadDemoSession(fault).then((s) => {
      if (cancelled) return s?.close();
      // The previous round's session closes only once the new one is on screen.
      setSession((prev) => { prev?.close(); return s; });
    });
    return () => { cancelled = true; };
  }, [round]);
  useEffect(() => () => live.current.session?.close(), []);

  const project = session ? (session.projects.find((p) => p.fixtureId === fixtureId) ?? session.projects[0]!) : null;
  live.current = { session, projectId: project?.projectId ?? null };
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
    <AppShell store={store} mode="mock" agentRuntime={agentRuntime} projectLabel={project.name} assistant={null} onboarding={<OnboardingView api={demoOnboarding} adapter={null} hold={null} mode="mock" leaveDemoHref={leave.href} />} leaveDemoHref={leave.href} playback={playback} devPanel={<DevPanel session={session} fixtureId={project.fixtureId} onFixture={changeFixture} onRestart={store.getState().restart} playback={playback} />} />
  );
}
