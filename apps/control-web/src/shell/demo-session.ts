import { useEffect, useMemo, useRef, useState } from 'react';
import { createPlayback, type Playback } from './playback.ts';
import { DEMO_FAULTS, loadDemoSession, type DemoFault, type DemoSession } from '../data-source/demo.ts';
import { createProjectionStore, type ProjectionStore } from './projection-store.ts';

/**
 * The demo's session, projection and scripted playback, shared by `?demo` (dev, DemoRoot) and the hosted demo (H9, HostedRoot): both show the same demo data the
 * same way, labelled Demo data.
 */
export interface DemoState {
  readonly session: DemoSession | null;
  readonly project: DemoSession['projects'][number] | null;
  readonly store: ProjectionStore | null;
  readonly playback: Playback | null;
}

const params = (): URLSearchParams => new URLSearchParams(window.location.search);

export function useDemoSession(fixtureId: string): DemoState {
  const [session, setSession] = useState<DemoSession | null>(null);
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
  return { session, project, store, playback };
}
