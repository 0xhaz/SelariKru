import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const solution = join(here, 'feedback-board-solution');
const overlay = join(solution, 'overlay');
const starter = resolve(here, '../../examples/feedback-board-starter');
const HEADER = 'Private verifier calibration. Never provide to workers. Not evidence of platform generation.';

function files(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel)).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist' || n === '.DS_Store') return [];
    const r = rel ? `${rel}/${n}` : n;
    return lstatSync(join(dir, r)).isDirectory() ? files(dir, r) : [r];
  });
}

describe('calibration solution is kept out of the starter', () => {
  it('has the required header as the first line of its README', () => {
    expect(readFileSync(join(solution, 'README.md'), 'utf8').split('\n')[0]).toBe(HEADER);
  });

  it('lives outside examples/ and services/', () => {
    expect(solution.includes('/examples/') || solution.includes('/services/')).toBe(false);
  });

  it('adds only files the starter does not have, and changes every file it replaces', () => {
    for (const f of files(overlay)) {
      const inStarter = join(starter, f);
      if (existsSync(inStarter)) expect(readFileSync(inStarter, 'utf8'), `${f} is identical in the starter`).not.toBe(readFileSync(join(overlay, f), 'utf8'));
    }
    expect(files(overlay).length).toBeGreaterThan(0);
  });

  it('starter tree contains none of the overlay-only files, its header text, or its implementation', () => {
    const overlayOnly = files(overlay).filter((f) => !existsSync(join(starter, f)));
    // overlay-only files are, by construction, absent; this fails if someone copies them in later
    expect(overlayOnly.length).toBeGreaterThan(0);
    const starterFiles = files(starter);
    const overlayBodies = files(overlay).map((f) => readFileSync(join(overlay, f), 'utf8'));
    for (const f of starterFiles) {
      const text = readFileSync(join(starter, f), 'utf8');
      expect(text, f).not.toContain('Private verifier calibration');
      expect(overlayBodies, `${f} duplicates an overlay file`).not.toContain(text);
    }
    expect(starterFiles.filter((f) => f.endsWith('.sql'))).toEqual([]);
    for (const f of starterFiles.filter((f) => /^(server|src)\//.test(f))) {
      expect(readFileSync(join(starter, f), 'utf8'), f).not.toMatch(/INSERT INTO feedback|FEEDBACK_SEED_FILE|Submit feedback/);
    }
  });
});
