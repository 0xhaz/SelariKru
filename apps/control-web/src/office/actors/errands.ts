// A robot's errands (H7 fix): walks that follow real events only (office/events.ts says which). SelariKru's own.
//
// An errand is a list of steps. A robot runs one errand at a time, one step at a time: it walks to the step's place, lingers there (showing an emote
// or carrying a tiffin if the step says so), then takes the next step. A held step (the roof during a cloud call) waits until it is released.

/** Where a step goes. `here` stays put; the scene turns the rest into tiles. */
export type ErrandPlace = 'plan' | 'seat' | 'roof' | 'drop' | 'prs' | 'here';
export type ErrandEmote = 'talk' | 'mail' | 'ok' | 'heart';

export interface ErrandStep {
  readonly to: ErrandPlace;
  /** Seconds to stay once there. */
  readonly linger?: number;
  readonly emote?: ErrandEmote;
  /** Carries a tiffin while walking to this step. */
  readonly carry?: boolean;
  /** Waits here until `release(hold)`. */
  readonly hold?: 'cloud';
}

export class ErrandQueue {
  private errands: ErrandStep[][] = [];
  private arrivedAt: number | null = null;

  push(steps: readonly ErrandStep[]): void {
    if (steps.length > 0) this.errands.push([...steps]);
  }

  /** The step in progress, or null when the robot has no errand. */
  current(): ErrandStep | null {
    return this.errands[0]?.[0] ?? null;
  }

  /** True once the robot has reached the current step's place. */
  get there(): boolean {
    return this.arrivedAt !== null;
  }

  arrived(now: number): void {
    if (this.current() && this.arrivedAt === null) this.arrivedAt = now;
  }

  /** Moves on once the current step has lingered long enough, unless it is held. */
  tick(now: number): void {
    const step = this.current();
    if (!step || this.arrivedAt === null || step.hold) return;
    if (now - this.arrivedAt >= (step.linger ?? 0)) this.next();
  }

  /** Lets a held step go: the robot comes back to its seat, then carries on with what is queued. */
  release(hold: 'cloud'): void {
    const first = this.errands[0];
    if (first) {
      const at = first.findIndex((s) => s.hold === hold);
      if (at >= 0) { first.splice(at, 1, { to: 'seat' }); if (at === 0) this.arrivedAt = null; }
    }
    for (const errand of this.errands.slice(1)) {
      const at = errand.findIndex((s) => s.hold === hold);
      if (at >= 0) errand.splice(at, 1);
    }
    this.errands = this.errands.filter((e) => e.length > 0);
  }

  /** A worker that needs you stops its walks and goes back to its desk. A held roof visit is dropped too: the call ended or will be released. */
  needsYou(): void {
    this.errands = [[{ to: 'seat' }]];
    this.arrivedAt = null;
  }

  /**
   * Reduced motion: no walking. Returns where the robot should be placed, which is where its errands end; a held step stays current, since that is
   * where it is until released.
   */
  settle(): ErrandPlace | null {
    let place: ErrandPlace | null = null;
    while (this.errands.length > 0) {
      const errand = this.errands[0]!;
      const held = errand.find((s) => s.hold);
      if (held) { this.errands = [[held]]; this.arrivedAt = 0; return held.to; }
      for (const s of errand) if (s.to !== 'here') place = s.to;
      this.errands.shift();
    }
    this.arrivedAt = null;
    return place;
  }

  private next(): void {
    const first = this.errands[0];
    if (!first) return;
    first.shift();
    if (first.length === 0) this.errands.shift();
    this.arrivedAt = null;
  }
}
