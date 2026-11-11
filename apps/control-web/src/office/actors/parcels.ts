// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Candidates on the belt, on their way to the verifier. Their place follows the recorded state only: a live candidate not yet verified waits at
// the gate (scanned while a task verifies), a verified one waits past it, and one whose pull request was merged runs on into the server room
// and leaves. A rejected or replaced candidate is not on the belt at all.

import type { OfficeParcel } from '../model.ts';
import type { OfficeLayout } from '../layout/layout.ts';

export interface Parcel {
  id: string;
  label: string;
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
  readonly hLen: number;
  readonly len: number;
  readonly gateEntry: number;
  readonly gateCentre: number;
  readonly gateExit: number;

  constructor(private l: OfficeLayout) {
    const b = l.belt;
    this.hLen = b.x1 - b.x0;
    this.len = this.hLen + (b.topY !== null ? b.y - b.topY : 0);
    const gate = l.gate ?? { x: b.x0 + this.hLen / 2, w: 0 };
    this.gateEntry = gate.x - 6 - b.x0;
    this.gateCentre = gate.x + gate.w / 2 - b.x0;
    this.gateExit = gate.x + gate.w + 10 - b.x0;
  }

  pos(s: number): Pt {
    const b = this.l.belt;
    return s <= this.hLen ? { x: b.x0 + s, y: b.y } : { x: b.x1, y: b.y - (s - this.hLen) };
  }
}

/** Where a candidate rests for its stage. */
export function restingPlace(p: OfficeParcel, path: BeltPath, scanning: boolean): number {
  if (p.stage === 'merged') return path.len;
  if (p.stage === 'verified') return path.gateExit;
  return scanning ? path.gateCentre : path.gateEntry;
}

export function updateParcels(parcels: Parcel[], stages: ReadonlyMap<string, OfficeParcel>, path: BeltPath, dt: number, scanning: boolean, onMerged: (p: Parcel) => void): void {
  const onBelt = parcels.filter((p) => p.mode === 'belt').sort((a, b) => b.s - a.s);
  let ahead: Parcel | null = null;
  let scanned = false;
  for (const p of onBelt) {
    const stage = stages.get(p.id);
    if (!stage) continue;
    // One candidate in the gate at a time.
    const inGate = scanning && stage.stage === 'to_gate' && !scanned;
    if (inGate) scanned = true;
    let target = restingPlace(stage, path, inGate);
    if (ahead && stage.stage !== 'merged') target = Math.min(target, ahead.s - GAP);
    if (p.s < target) p.s = Math.min(target, p.s + BELT_SPEED * (stage.stage === 'merged' ? 2.5 : 1) * dt);
    if (stage.stage === 'merged' && p.s >= path.len - 0.5) {
      p.mode = 'gone';
      onMerged(p);
      continue;
    }
    ahead = p;
  }
}
