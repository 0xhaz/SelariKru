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

  it('P1: after a plan is accepted, the new notes are pinned when the Project Manager reaches the board, not before', () => {
    const born = (n: PlanNotes, id: string) => (n as unknown as { notes: Map<string, { born: number }> }).notes.get(id)!.born;
    const two = [{ taskId: 't', column: 0 as const, status: 'running' as const, ownerId: null }, { taskId: 'u', column: 0 as const, status: 'running' as const, ownerId: null }];
    const n = new PlanNotes();
    n.update(note(0), board, 0.016, 0, false);
    n.hold();
    n.update(two, board, 0.016, 5, false);
    // Not flashing yet: the PM is still on its way.
    expect(born(n, 'u')).toBeLessThan(0);
    n.pin(9);
    expect(born(n, 'u')).toBe(9);
    // A note that was already up is left alone.
    expect(born(n, 't')).toBeLessThan(0);
    // With nothing new, the pin flashes every note on the wall.
    n.hold();
    n.pin(12);
    expect(born(n, 't')).toBe(12);
    expect(born(n, 'u')).toBe(12);
    // Without a hold a new note flashes as it arrives, as before.
    n.update([...two, { taskId: 'v', column: 0, status: 'running', ownerId: null }], board, 0.016, 20, false);
    expect(born(n, 'v')).toBe(20);
  });

  it('P1: a hold the PM never finishes (its errands were cleared) is released, and the waiting notes still flash; nothing else does', () => {
    const born = (n: PlanNotes, id: string) => (n as unknown as { notes: Map<string, { born: number }> }).notes.get(id)!.born;
    const n = new PlanNotes();
    n.update(note(0), board, 0.016, 0, false);
    n.hold();
    n.update([...note(0), { taskId: 'u', column: 0, status: 'running', ownerId: null }], board, 0.016, 5, false);
    expect(born(n, 'u')).toBeLessThan(0);
    n.release(7);
    expect(born(n, 'u')).toBe(7);
    expect(born(n, 't')).toBeLessThan(0);
    // Released: the next new note flashes as it arrives.
    n.update([...note(0), { taskId: 'u', column: 0, status: 'running', ownerId: null }, { taskId: 'v', column: 0, status: 'running', ownerId: null }], board, 0.016, 9, false);
    expect(born(n, 'v')).toBe(9);
    // With nothing held, a release flashes nothing.
    n.release(11);
    expect(born(n, 't')).toBeLessThan(0);
  });
});
