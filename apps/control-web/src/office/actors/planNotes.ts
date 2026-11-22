// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Sticky notes on the plan wall, one per task of the current run. They glide between columns as tasks move.

import { toneShift } from '../../theme/tokens.ts';
import type { OfficeNote } from '../model.ts';
import { C } from '../engine/palette.ts';
import type { Pen } from '../engine/pen.ts';
import type { PxRect } from '../layout/layout.ts';

interface Note {
  x: number;
  y: number;
  tx: number;
  ty: number;
  hidden: boolean;
  born: number;
}

export class PlanNotes {
  private notes = new Map<string, Note>();
  /** P1: set while the Project Manager carries an accepted plan to the board: new notes wait for it to pin them. */
  private held = false;
  private waiting = new Set<string>();

  /** P1: a plan was accepted and the PM is on its way: notes that appear now flash only once it pins them. */
  hold(): void {
    this.held = true;
  }

  /** P1: the PM is at the board: the notes that waited flash now (every note, when none were new). */
  pin(t: number): void {
    const ids = this.waiting.size > 0 ? [...this.waiting] : [...this.notes.keys()];
    for (const id of ids) { const n = this.notes.get(id); if (n) n.born = t; }
    this.held = false;
    this.waiting.clear();
  }

  /** P1: ends a hold the PM will never finish (its errands were cleared): the notes that waited flash now, and nothing else does. */
  release(t: number): void {
    for (const id of this.waiting) { const n = this.notes.get(id); if (n) n.born = t; }
    this.held = false;
    this.waiting.clear();
  }

  update(mine: readonly OfficeNote[], board: PxRect, dt: number, t: number, settle: boolean) {
    const seen = new Set<string>();
    for (let col = 0; col < 4; col++) {
      const list = mine.filter((x) => x.column === col);
      if (col === 3) list.reverse(); // most recent done first
      list.forEach((task, i) => {
        seen.add(task.taskId);
        const tx = board.x + col * 35 + 2 + (i % 4) * 8;
        const ty = board.y + 11 + Math.floor(i / 4) * 7;
        const n = this.notes.get(task.taskId);
        if (n) Object.assign(n, { tx, ty, hidden: i >= 16 });
        else {
          const fresh = this.notes.size > 0;
          if (fresh && this.held) this.waiting.add(task.taskId);
          this.notes.set(task.taskId, { x: tx, y: ty, tx, ty, hidden: i >= 16, born: fresh && !this.held ? t : -10 });
        }
      });
    }
    for (const id of [...this.notes.keys()]) if (!seen.has(id)) this.notes.delete(id);
    const k = settle ? 1 : 1 - Math.exp(-5 * dt);
    for (const n of this.notes.values()) {
      n.x += (n.tx - n.x) * k;
      n.y += (n.ty - n.y) * k;
    }
  }

  draw(p: Pen, tasks: readonly OfficeNote[], colorOf: (id: string | null) => string, t: number) {
    const byId = new Map(tasks.map((x) => [x.taskId, x]));
    const sorted = [...this.notes.entries()].sort(
      ([, a], [, b]) => Math.abs(a.x - a.tx) + Math.abs(a.y - a.ty) - (Math.abs(b.x - b.tx) + Math.abs(b.y - b.ty)),
    );
    for (const [id, n] of sorted) {
      const task = byId.get(id);
      if (!task || n.hidden) continue;
      const color = colorOf(task.ownerId);
      const dist = Math.abs(n.x - n.tx) + Math.abs(n.y - n.ty);
      const lift = dist > 1 ? Math.min(3, dist / 6) : 0;
      const x = Math.round(n.x);
      const y = Math.round(n.y - lift);
      if (lift) p.rect(x + 1, y + lift + 1, 7, 6, C.shadow, 0.25);
      if (task.column === 3) {
        p.rect(x, y, 7, 6, C.tileD);
        p.rect(x, y, 2, 6, color);
        p.rect(x + 3, y + 3, 1, 1, C.leafD);
        p.rect(x + 4, y + 2, 1, 1, C.leafD);
        p.rect(x + 5, y + 1, 1, 1, C.leafD);
      } else {
        p.rect(x, y, 7, 6, color);
        p.rect(x, y, 7, 1, toneShift(color, 0.5));
        p.rect(x + 1, y + 3, 4, 1, toneShift(color, -0.3));
        if (task.column === 2) p.rect(x + 5, y + 4, 1, 1, C.ink);
        if (task.status === 'blocked') p.rect(x + 5, y + 1, 2, 2, C.red);
      }
      if (t - n.born < 0.6 && Math.floor(t * 10) % 2) {
        p.rect(x - 1, y - 1, 9, 1, C.white);
        p.rect(x - 1, y + 6, 9, 1, C.white);
      }
    }
  }
}
