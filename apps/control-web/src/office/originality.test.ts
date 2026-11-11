import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * H7 fix I1: a file without the "Adapted from jsm-hq" header claims to be SelariKru's own. When the reference is checked out beside the repo
 * (jsm-hq-main/, never committed), every non-trivial line of each such file under src/office and src/theme is compared with every line of the
 * reference's src. A shared line means reference code under no header. Skips when the reference is not there.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(here, '..');
const REFERENCE = join(here, '../../../../jsm-hq-main/src');
/** At most this many shared lines per original file (short coincidences such as a common guard). */
const THRESHOLD = 2;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** A line reduced to its code: no comments, no spacing, one quote style, no trailing separator. Trivial lines (braces, imports, short ones) drop out. */
export function codeLines(text: string): string[] {
  return text.split('\n').flatMap((raw) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/\s+/g, '').replace(/"/g, "'").replace(/[;,]+$/, '');
    if (line.length < 24 || /^(import|export\{|\}|\)|\]|\*|\/\*)/.test(line)) return [];
    return [line];
  });
}

const original = (path: string): boolean => !/Adapted from jsm-hq/i.test(readFileSync(path, 'utf8').split('\n').slice(0, 4).join('\n'));

describe('files that claim to be original share no code with the reference', () => {
  it('normalises lines so spacing, quotes and comments do not hide a copy', () => {
    expect(codeLines('  p.rect(x + 1, y, "a");  // note\n}\n')).toEqual(["p.rect(x+1,y,'a')"].filter((l) => l.length >= 24));
    expect(codeLines('const widthOfTheBoard = boardWidth * 2 + margin;')).toEqual(['constwidthOfTheBoard=boardWidth*2+margin']);
  });

  it.runIf(existsSync(REFERENCE))('each original file under src/office and src/theme shares at most a couple of lines with the reference', () => {
    const theirs = new Set(files(REFERENCE).flatMap((f) => codeLines(readFileSync(f, 'utf8'))));
    const ours = [...files(join(SRC, 'office')), ...files(join(SRC, 'theme'))].filter(original);
    expect(ours.length).toBeGreaterThan(3);
    const over = ours.flatMap((f) => {
      const shared = codeLines(readFileSync(f, 'utf8')).filter((l) => theirs.has(l));
      return shared.length > THRESHOLD ? [`${relative(SRC, f)}: ${shared.length} shared lines, e.g. ${shared.slice(0, 3).join(' | ')}`] : [];
    });
    expect(over).toEqual([]);
  });
});
