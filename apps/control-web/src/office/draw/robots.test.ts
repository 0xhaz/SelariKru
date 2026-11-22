import { describe, expect, it } from 'vitest';
import { PM_ROWS, ROBOT_H, ROBOT_W } from './robots.ts';

describe('P1: the Project Manager has a frame for every facing, in the crew\'s build', () => {
  it('front, back, typing and side frames, each the size of a worker sprite, all in the PM\'s gold cap', () => {
    expect(Object.keys(PM_ROWS).sort()).toEqual(['back', 'front', 'side', 'type']);
    for (const rows of Object.values(PM_ROWS)) {
      expect(rows).toHaveLength(ROBOT_H);
      for (const row of rows) expect(row).toHaveLength(ROBOT_W);
      expect(rows.slice(0, 3).join('')).toMatch(/K/);
    }
    // Only the front shows the clipboard in full; seen from behind it is hidden.
    expect(PM_ROWS.front.join('')).toMatch(/M/);
    expect(PM_ROWS.back.join('')).not.toMatch(/[PM]/);
  });
});
