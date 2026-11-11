import { useSyncExternalStore } from 'react';
// Demo playback (H7 fix): the mock's scripted timeline advances on a real clock, at 1x, 2x or 4x, and loops back to the start when the script has
// nothing left, so the office keeps living. Demo data only: it never changes live data and none of it counts as evidence. SelariKru's own.

export interface PlaybackDeps {
  /** Moves the demo's virtual clock forward. */
  readonly advance: (ms: number) => void;
  /** How many scripted events are still to come. */
  readonly remaining: () => number;
  /** Starts the script again from the beginning. */
  readonly restart: () => void;
  readonly every: (fn: () => void, ms: number) => () => void;
  readonly now: () => number;
  /** Paused under reduced motion and in tests. */
  readonly playing: boolean;
  /** How long the finished script rests before it loops. */
  readonly restMs?: number;
  readonly tickMs?: number;
}

export interface PlaybackState {
  readonly playing: boolean;
  readonly speed: number;
}

export interface Playback {
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  state(): PlaybackState;
  /** Called with the new state on every change. */
  subscribe(listener: (s: PlaybackState) => void): () => void;
  stop(): void;
}

export const PLAYBACK_SPEEDS = [1, 2, 4] as const;

export function createPlayback(deps: PlaybackDeps): Playback {
  let playing = deps.playing;
  let speed = 1;
  // One object per state, so a React external store sees a stable snapshot.
  let snapshot: PlaybackState = { playing, speed };
  let last = deps.now();
  let emptySince: number | null = null;
  const listeners = new Set<(s: PlaybackState) => void>();
  const tell = (): void => { snapshot = { playing, speed }; for (const l of [...listeners]) l(snapshot); };
  const cancel = deps.every(() => {
    const now = deps.now();
    const elapsed = now - last;
    last = now;
    if (!playing) return;
    if (deps.remaining() > 0) {
      emptySince = null;
      deps.advance(elapsed * speed);
      return;
    }
    emptySince ??= now;
    if (now - emptySince >= (deps.restMs ?? 4000)) {
      emptySince = null;
      deps.restart();
    }
  }, deps.tickMs ?? 250);
  return {
    play() { if (!playing) { playing = true; last = deps.now(); tell(); } },
    pause() { if (playing) { playing = false; tell(); } },
    setSpeed(s) { if (s !== speed) { speed = s; tell(); } },
    state: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() { cancel(); listeners.clear(); },
  };
}

/** The playback state, followed as it changes; null without a playback (live mode). */
export function usePlayback(playback: Playback | null): PlaybackState | null {
  return useSyncExternalStore((fn) => (playback ? playback.subscribe(fn) : () => undefined), () => playback?.state() ?? null, () => playback?.state() ?? null);
}
