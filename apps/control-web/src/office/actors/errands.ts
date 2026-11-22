// A robot's errands (H7 fix): walks that follow real events only (office/events.ts says which). SelariKru's own.
//
// An errand is a list of steps. A robot runs one errand at a time, one step at a time: it walks to the step's place, lingers there (showing an emote
// or carrying a tiffin if the step says so), then takes the next step. A held step (a roof box while the worker's AI call is in flight) waits until it is released.

import { officeEvents } from '../events.ts';
import type { OfficeWorld } from '../model.ts';

/**
 * Where a step goes. `here` stays put; the scene turns the rest into tiles. P1: the Project Manager's own places are `pmTable` (its place at the shared
 * table), `pmBoard` (in front of the plan board), `pmDelegate` (beside the worker named by the step) and `pmHome` (the shared table while a meeting is on,
 * else its seat at the PLAN desk).
 */
export type ErrandPlace = 'plan' | 'table' | 'seat' | 'roofDevice' | 'roofCloud' | 'drop' | 'prs' | 'here' | 'pmTable' | 'pmBoard' | 'pmDelegate' | 'pmHome';
export type ErrandEmote = 'talk' | 'mail' | 'ok' | 'heart';

export interface ErrandStep {
  readonly to: ErrandPlace;
  /** Seconds to stay once there. */
  readonly linger?: number;
  readonly emote?: ErrandEmote;
  /** Carries a tiffin while walking to this step. */
  readonly carry?: boolean;
  /** Waits here until `release(hold)`: on the roof while the worker's AI call is in flight. */
  readonly hold?: 'call';
  /** P1: the worker a `pmDelegate` step walks to. */
  readonly agentId?: string;
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
  release(hold: 'call'): void {
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

  /** Drops every errand, held ones included (round 3: a new epoch starts with no errand at all). */
  clear(): void {
    this.errands = [];
    this.arrivedAt = null;
  }

  /** Follows the world: a held roof step whose call is no longer in flight is released (round 3), so no robot is left on the roof. */
  follow(world: { readonly cloudCall: boolean; readonly deviceCall?: boolean }): void {
    if (!world.cloudCall && !world.deviceCall && this.errands.some((e) => e.some((s) => s.hold === 'call'))) this.release('call');
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

  /** P1: how many queued errands go to this place (the PM's delegation trips, for their cap). */
  count(place: ErrandPlace): number {
    return this.errands.filter((e) => e.some((s) => s.to === place)).length;
  }

  /**
   * P1: drops the current errand's last step when it is a walk to this place and another errand is queued, so the PM goes from one trip straight to the
   * next instead of home in between. Returns true when it dropped one.
   */
  skipTrailing(place: ErrandPlace): boolean {
    const first = this.errands[0];
    if (!first || this.errands.length < 2 || first.length !== 1 || first[0]!.to !== place) return false;
    this.errands.shift();
    this.arrivedAt = null;
    return true;
  }

  private next(): void {
    const first = this.errands[0];
    if (!first) return;
    first.shift();
    if (first.length === 0) this.errands.shift();
    this.arrivedAt = null;
  }
}

/** P1: at most this many delegation trips are queued for the PM; a delegation past it gets only its envelope, sent from the PM's desk. */
export const PM_TRIP_CAP = 4;

export interface PmPlan {
  /** The PM's new errands, in order. */
  readonly errands: ErrandStep[][];
  /** Workers whose delegation is past the cap: an envelope from the PM's desk, and no walk. */
  readonly deskEnvelopes: string[];
}

/**
 * P1: the Project Manager's errands for what changed between two worlds in a row. Every one follows a real change: a meeting at the shared table starting
 * or ending, a plan revision accepted for the same run, or a delegation recorded for a worker in the office. The first world and a new epoch replay nothing.
 * `queuedTrips` is how many delegation trips are already queued, so the cap holds across worlds.
 */
export function pmErrands(prev: OfficeWorld | null, next: OfficeWorld, queuedTrips = 0): PmPlan {
  const errands: ErrandStep[][] = [];
  const deskEnvelopes: string[] = [];
  if (prev === null || prev.epoch !== next.epoch) return { errands, deskEnvelopes };
  const was = prev.meeting?.pm === true;
  const now = next.meeting?.pm === true;
  if (now && !was) errands.push([{ to: 'pmTable' }]);
  if (was && !now) errands.push([{ to: 'pmHome' }]);
  const events = officeEvents(prev, next);
  if (events.some((e) => e.kind === 'planAccepted')) errands.push([{ to: 'pmBoard', linger: 2, emote: 'talk' }, { to: 'pmHome' }]);
  // One trip per worker, in the order the delegations were recorded.
  const workers: string[] = [];
  for (const e of events) if (e.kind === 'delegated' && !workers.includes(e.agentId)) workers.push(e.agentId);
  let room = Math.max(0, PM_TRIP_CAP - queuedTrips);
  for (const agentId of workers) {
    if (room > 0) { errands.push([{ to: 'pmDelegate', agentId, linger: 1.6, emote: 'talk' }, { to: 'pmHome' }]); room -= 1; }
    else deskEnvelopes.push(agentId);
  }
  return { errands, deskEnvelopes };
}
