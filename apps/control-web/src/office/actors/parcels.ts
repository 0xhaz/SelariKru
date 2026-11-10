// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Pull-request parcels on the belt. Their position follows the pull request's recorded state: a verified candidate waits past the gate for
// a human merge, a merged one runs on to main and leaves, and one that no longer holds the run's code waits before the gate.

import type { OfficeParcel } from '../model.ts';
import type { OfficeLayout } from '../layout/layout.ts';

export interface Parcel {
  num: number;
  mode: 'belt' | 'gone';
  s: number; // distance along the belt
}

interface Pt {
  x: number;
  y: number;
}

const BELT_SPEED = 40;
const GAP = 12;

export class BeltPath {
  readonly len: number;
  readonly gateEntry: number;
  readonly gateExit: number;

  constructor(private l: OfficeLayout) {
    const b = l.belt;
    this.len = b.x1 - b.x0;
    this.gateEntry = l.gate.x - 6 - b.x0;
    this.gateExit = l.gate.x + l.gate.w + 10 - b.x0;
  }

  pos(s: number): Pt {
    const b = this.l.belt;
    return { x: b.x0 + Math.min(s, this.len), y: b.y };
  }
}

/** Where a parcel rests for its pull request's state. */
export function restingPlace(pr: OfficeParcel, path: BeltPath): number {
  if (pr.merged) return path.len;
  if (pr.review === 'changes') return path.gateEntry;
  return path.gateExit;
}

export function updateParcels(parcels: Parcel[], prs: ReadonlyMap<number, OfficeParcel>, path: BeltPath, dt: number, onMerged: (p: Parcel) => void): void {
  const onBelt = parcels.filter((p) => p.mode === 'belt').sort((a, b) => b.s - a.s);
  let ahead: Parcel | null = null;
  for (const p of onBelt) {
    const pr = prs.get(p.num);
    if (!pr) continue;
    let target = restingPlace(pr, path);
    if (ahead && !pr.merged) target = Math.min(target, ahead.s - GAP);
    // Merged parcels hurry to main so the belt never lags far behind the recorded state.
    if (p.s < target) p.s = Math.min(target, p.s + BELT_SPEED * (pr.merged ? 2.5 : 1) * dt);
    if (pr.merged && p.s >= path.len - 0.5) {
      p.mode = 'gone';
      onMerged(p);
      continue;
    }
    ahead = p;
  }
}
