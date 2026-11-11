import { describe, expect, it } from 'vitest';
import { PlanNotes } from './planNotes.ts';

/** H7 fix: the plan notes follow the task's status and glide between columns as the demo plays; under reduced motion they jump. */
describe('plan notes', () => {
  const board = { x: 0, y: 0, w: 140, h: 40 };
  const note = (column: 0 | 1 | 2 | 3) => [{ taskId: 't', column, status: 'running' as const, ownerId: null }];
  const at = (n: PlanNotes) => (n as unknown as { notes: Map<string, { x: number; tx: number }> }).notes.get('t')!;

  it('a status change moves the note toward its new column a little each frame', () => {
    const n = new PlanNotes();
    n.update(note(0), board, 0.016, 0, false);
    const start = at(n).x;
    n.update(note(1), board, 0.016, 1, false);
    const mid = at(n);
    expect(mid.tx).toBe(start + 35);
    expect(mid.x).toBeGreaterThan(start);
    expect(mid.x).toBeLessThan(mid.tx);
    for (let k = 0; k < 120; k++) n.update(note(1), board, 0.016, 1, false);
    expect(Math.round(at(n).x)).toBe(mid.tx);
  });

  it('under reduced motion the note is placed in its column at once', () => {
    const n = new PlanNotes();
    n.update(note(0), board, 0.016, 0, true);
    n.update(note(3), board, 0.016, 1, true);
    expect(at(n).x).toBe(at(n).tx);
  });
});
