import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Stable hash of a directory tree: sha256 over sorted "relative/path NUL sha256(file)\n" lines.
 * Independent of mtimes, permissions and traversal order. Symlinks are refused.
 */
export function hashTree(root: string, opts: { exclude?: (relPath: string) => boolean } = {}): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (name === '.DS_Store' || name === 'node_modules' || opts.exclude?.(relPath)) continue;
      const st = lstatSync(join(root, relPath));
      if (st.isSymbolicLink()) throw new Error(`refusing to hash symlink: ${relPath}`);
      if (st.isDirectory()) walk(relPath);
      else lines.push(`${relPath}\0${sha256(readFileSync(join(root, relPath)))}\n`);
    }
  };
  walk('');
  return sha256(lines.join(''));
}

export const HASH_KEYS = ['manifestSha256', 'suiteSha256', 'runnerSha256', 'dockerfileSha256', 'packageJsonSha256', 'lockfileSha256', 'verifierSha256'] as const;

/**
 * Everything that decides a verdict: the suite (tests, configs, fixtures, manifest), the runner, the Dockerfile
 * (pinned base images), the package manifest and the root lockfile (locked tool versions).
 * `pkgRoot` = services/verifier, `repoRoot` = directory holding pnpm-lock.yaml (same relative layout in the image).
 */
export function verifierHashes(pkgRoot: string, repoRoot: string): Record<(typeof HASH_KEYS)[number], string> {
  const suite = join(pkgRoot, 'suites/feedback-board');
  const parts = {
    manifestSha256: sha256(readFileSync(join(suite, 'manifest.json'))),
    suiteSha256: hashTree(suite, { exclude: (p) => p === 'HASHES.json' }),
    runnerSha256: hashTree(join(pkgRoot, 'src')),
    dockerfileSha256: sha256(readFileSync(join(pkgRoot, 'Dockerfile'))),
    packageJsonSha256: sha256(readFileSync(join(pkgRoot, 'package.json'))),
    lockfileSha256: sha256(readFileSync(join(repoRoot, 'pnpm-lock.yaml'))),
  };
  const verifierSha256 = sha256(Object.entries(parts).map(([k, v]) => `${k}=${v}\n`).join(''));
  return { ...parts, verifierSha256 };
}
