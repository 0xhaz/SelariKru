import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolchainSpec } from '@selarikru/protocol';
import { gitEnv } from './bundle.ts';

const execFileP = promisify(execFile);

/**
 * Which exact Node a major-only `.nvmrc` means. It is a table, not a lookup of "latest", so every attempt on a base commit gets the same bytes and a release
 * upstream cannot change a verified run. 24.22.1 is the version the platform and the Feedback Board starter are built and tested with. A bump is a deliberate edit here.
 * An `.nvmrc` that already names an exact version is used as written.
 */
export const NODE_MAJOR_PINS: Readonly<Record<string, string>> = { '24': '24.22.1' };

/** The only shape a version may have by the time it reaches a command line. */
export const EXACT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const NVMRC = /^v?(\d{1,4})(?:\.(\d{1,4})\.(\d{1,6}))?$/;
/** An exact pnpm, with corepack's optional `+sha512.<hash>` suffix, which is not used: npm checks the package's integrity itself. */
const PACKAGE_MANAGER = /^pnpm@(\d{1,4}\.\d{1,4}\.\d{1,6})(?:\+[A-Za-z0-9.]+)?$/;

export type ToolchainResolution =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'pinned' } & ToolchainSpec)
  | { readonly kind: 'unresolved'; readonly reason: string };

async function readBaseFile(repo: string, sha: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', repo, 'cat-file', 'blob', `${sha}:${path}`], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: gitEnv() });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Decides the toolchain from the base commit, which is fixed before any worker runs, so nothing a worker writes can reach these values. A repository that names no
 * Node toolchain has nothing to set up. One that names it badly is refused: retrying would repeat the same answer, and guessing would run something other than what it pinned.
 */
export async function resolveToolchain(repo: string, sha: string): Promise<ToolchainResolution> {
  const [nvmrc, pkgText, lock] = await Promise.all([readBaseFile(repo, sha, '.nvmrc'), readBaseFile(repo, sha, 'package.json'), readBaseFile(repo, sha, 'pnpm-lock.yaml')]);
  let packageManager: unknown;
  if (pkgText !== null) {
    try {
      packageManager = (JSON.parse(pkgText) as { packageManager?: unknown } | null)?.packageManager;
    } catch {
      if (nvmrc === null) return { kind: 'none' };
      return { kind: 'unresolved', reason: 'package.json is not valid JSON' };
    }
  }
  if (nvmrc === null && packageManager === undefined) return { kind: 'none' };
  if (nvmrc === null) return { kind: 'unresolved', reason: '.nvmrc is missing, so the Node version is unknown' };

  const m = NVMRC.exec(nvmrc.trim());
  if (m === null) return { kind: 'unresolved', reason: '.nvmrc must name a Node major or an exact version such as 24.22.1' };
  const nodeVersion = m[2] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : NODE_MAJOR_PINS[m[1]!];
  if (nodeVersion === undefined) return { kind: 'unresolved', reason: `no pinned Node version for major ${m[1]} (pinned: ${Object.keys(NODE_MAJOR_PINS).join(', ')})` };

  const pm = typeof packageManager === 'string' ? PACKAGE_MANAGER.exec(packageManager) : null;
  if (pm === null) return { kind: 'unresolved', reason: 'packageManager in package.json must be pnpm at an exact version, such as pnpm@9.12.2' };
  if (lock === null) return { kind: 'unresolved', reason: 'pnpm-lock.yaml is missing, so a frozen install cannot run' };
  return { kind: 'pinned', nodeVersion, pnpmVersion: pm[1]! };
}

/** Where the toolchain lives in the guest: outside the workspace, so nothing it creates can join a change set. */
const TOOLCHAIN_BIN = '$HOME/.node/bin';
/** Prepended to the launch wrapper. A constant: no value from a workspace or a worker reaches it. */
export const PATH_EXPORT = `export PATH="${TOOLCHAIN_BIN}:$PATH";`;

/** The first line names the step, which is how the fake sbx tells them apart. Versions arrive as positional arguments only; `$1` is never spliced into a command by the host. */
export const PROVISION_NODE_SCRIPT = `# selarikru-provision:node
set -eu
v="$1"
case "$(uname -m)" in
  x86_64|amd64) a=x64 ;;
  aarch64|arm64) a=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 64 ;;
esac
f="node-v$v-linux-$a.tar.gz"
u="https://nodejs.org/dist/v$v"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
curl -fsSL --connect-timeout 15 --max-time 240 -o "$t/$f" "$u/$f" || exit 65
curl -fsSL --connect-timeout 15 --max-time 30 -o "$t/SHASUMS256.txt" "$u/SHASUMS256.txt" || exit 65
w="$(awk -v f="$f" '$2 == f { print $1; exit }' "$t/SHASUMS256.txt")"
[ -n "$w" ] || { echo "no checksum listed for $f" >&2; exit 66; }
h="$(sha256sum "$t/$f" | cut -d' ' -f1)"
[ "$h" = "$w" ] || { echo "checksum mismatch for $f" >&2; exit 66; }
d="$HOME/.node"
rm -rf "$d"
mkdir -p "$d"
tar -xzf "$t/$f" -C "$d" --strip-components=1 || exit 67
line='${PATH_EXPORT}'
for p in "$HOME/.profile" "$HOME/.bashrc"; do
  grep -qxF "$line" "$p" 2>/dev/null || printf '%s\\n' "$line" >> "$p"
done
printf '%s\\n' "$a"
`;

export const PROVISION_PNPM_SCRIPT = `# selarikru-provision:pnpm
set -eu
${PATH_EXPORT}
npm install -g --no-audit --no-fund --ignore-scripts "pnpm@$2" >/dev/null || exit 70
[ "$(node --version)" = "v$1" ] || { echo "node reports $(node --version)" >&2; exit 71; }
[ "$(pnpm --version)" = "$2" ] || { echo "pnpm reports $(pnpm --version)" >&2; exit 71; }
`;

export const PROVISION_DEPS_SCRIPT = `# selarikru-provision:deps
set -eu
${PATH_EXPORT}
CI=1 pnpm install --frozen-lockfile
`;
