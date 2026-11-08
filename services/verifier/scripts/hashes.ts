// Regenerates suites/feedback-board/HASHES.json:  pnpm --filter @selarikru/verifier hashes
// Verify without writing:                          pnpm --filter @selarikru/verifier hashes:check
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HASH_KEYS, hashTree, verifierHashes } from '../src/hashing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const outPath = join(pkgRoot, 'suites/feedback-board/HASHES.json');

const next = {
  description:
    'verifierSha256 = sha256 over the other verifier hashes: manifest.json, the suite directory (excluding HASHES.json), services/verifier/src, the Dockerfile, package.json and the root pnpm-lock.yaml. The runner refuses to run if any differs. contractSha256 = tree hash of examples/feedback-board-starter/contract.',
  ...verifierHashes(pkgRoot, repoRoot),
  contractSha256: hashTree(join(repoRoot, 'examples/feedback-board-starter/contract')),
};
if (process.argv.includes('--check')) {
  const current = JSON.parse(readFileSync(outPath, 'utf8'));
  const same = [...HASH_KEYS, 'contractSha256'].every((k) => current[k] === (next as any)[k]);
  console.log(same ? 'HASHES.json is up to date' : 'HASHES.json is STALE; run: pnpm --filter @selarikru/verifier hashes');
  process.exit(same ? 0 : 1);
}
writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(JSON.stringify(next, null, 2));
