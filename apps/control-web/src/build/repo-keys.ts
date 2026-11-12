/**
 * H9 fix round 2: the tracked files that hold a web API key literal, from `git grep`. Its exit status 1 means no match: no files. Any other failure (git
 * missing, not a repository, a bad pattern) is thrown, so the check can never pass by not running. `git` runs the given arguments and returns stdout.
 */
export function trackedKeyFiles(git: (args: readonly string[]) => string): string[] {
  let out: string;
  try {
    out = git(['grep', '-lE', 'AIza[0-9A-Za-z_-]{35}']);
  } catch (e) {
    if ((e as { status?: unknown }).status === 1) return [];
    throw e;
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
