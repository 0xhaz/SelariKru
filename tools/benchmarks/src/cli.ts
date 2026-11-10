import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactSecrets } from '@selarikru/protocol';
import { verifierHashes } from '@selarikru/verifier/hashing';
import { FrozenError, ManifestError, StartRecordSchema, TRACKS, freezeOrder, readManifest, recordStart, repairStart, type Manifest, type StartRecord, type StartRecords, type Track } from './manifest.ts';
import { formatPreflight, preflight, type PreflightReport, type VerifierHashPair } from './preflight.ts';
import { PUBLIC_RESULTS_PATH, PublishError, preparePublish, writePublished } from './publish.ts';
import { ExportError, ReportError, buildReport, exportResults, renderReport } from './report.ts';
import { claudeCliLoginProbe, type CliLoginProbe } from './cli-login.ts';
import { RunUsageError } from './run-cli.ts';
import { LiveRefusedError, OrderError } from './trials.ts';

/**
 * `pnpm --filter ./tools/benchmarks benchmark <command>`. Every command except the two runners reads and writes files
 * only: none dispatches a run, calls a model, spends or opens a connection. The runners are gated as described below.
 *
 *   preflight     [--manifest p] [--verifier p] [--repo p] [--starts dir]         checklist; exit 1 when a track is blocked
 *   freeze        --seed s [--manifest p] [--starts dir]                          record the seed and its order; refused after any start
 *   record-start  --track workers|assistant [--manifest p] [--verifier p] [--repo p] [--starts dir] [--repair]
 *                 on a passing preflight for the track, stamp the manifest, then write its cohort-start file;
 *                 with --repair, only reconcile a stamp with no file (or a file with no stamp) for the same cohort
 *   report        --records p [--manifest p] [--starts dir] [--out p]             export raw records and print the report
 *   publish       --results p [--manifest p] [--out p]                            validate, redact, stamp and write for the web panel
 *   run-workers   --dry-run|--live --records p --starter repo [--work dir] [--evidence dir] [--manifest p] [--starts dir]
 *                 Track B: L1 through the real control API, runner and verifier; C1 and H2 Not measured (cloud_unavailable)
 *   sweep-schemas --older-than-hours h                                           drop stale bench_<time>_<random> schemas (DATABASE_URL); manual only
 *   run-assistant --dry-run|--live --records p [--cdp url --bench-url url] [--manifest p] [--starts dir]
 *                 Track A: both routes through the control web bench page in the owner's Chrome, over CDP
 *
 * The file-only commands above dispatch nothing. The two run commands dispatch only with `--live`, and only after
 * preflight passes for their track and its start is recorded; `--dry-run` uses fakes and records simulated data.
 *
 * `--verifier` is the verifier package (default services/verifier) and `--repo` the directory holding pnpm-lock.yaml;
 * preflight recomputes their hashes with the verifier's own hashing. Start files are `cohort-start-<track>.json` in
 * `--starts`, by default the manifest's directory.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULTS = {
  manifest: join(REPO_ROOT, 'fixtures/benchmarks/manifest.json'),
  verifier: join(REPO_ROOT, 'services/verifier'),
  repo: REPO_ROOT,
  publicOut: join(REPO_ROOT, PUBLIC_RESULTS_PATH),
};
const HASHES_PATH = 'suites/feedback-board/HASHES.json';

export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  /** Relative paths resolve against this. */
  readonly cwd?: string;
  /** Aborted on SIGINT: a running cohort cancels its trial and records the rest not run. */
  readonly signal?: AbortSignal;
  /** D6, `cli_login` mode: the read-only claude CLI login probe. Absent: not checked, and preflight blocks the workers track. */
  readonly cliLogin?: CliLoginProbe;
}

const USAGE = 'usage: benchmark preflight|freeze|record-start|report|publish|run-workers|run-assistant|sweep-schemas [--older-than-hours h] [--manifest p] [--verifier p] [--repo p] '
  + '[--starts dir] [--track t] [--seed s] [--records p] [--results p] [--out p] [--repair] [--live|--dry-run] [--starter repo] [--work dir] [--evidence dir] [--cdp url] [--bench-url url]';
const BOOLEAN_FLAGS = new Set(['repair', 'live', 'dry-run']);
const FLAGS = new Set(['older-than-hours', 'manifest', 'verifier', 'repo', 'starts', 'track', 'seed', 'records', 'results', 'out', 'starter', 'work', 'evidence', 'cdp', 'bench-url']);
const PATH_FLAGS = new Set(['manifest', 'verifier', 'repo', 'starts', 'records', 'results', 'out', 'starter', 'work', 'evidence']);

class UsageError extends Error {}
class BlockedError extends Error {}

function parseArgs(argv: readonly string[], at: (p: string) => string): { command: string | undefined; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const arg = rest[i]!;
    const name = arg.replace(/^--/, '');
    if (arg.startsWith('--') && BOOLEAN_FLAGS.has(name)) {
      flags.set(name, 'true');
      i -= 1;
      continue;
    }
    const value = rest[i + 1];
    if (!arg.startsWith('--') || !FLAGS.has(name) || value === undefined) throw new UsageError(`unexpected argument ${arg}`);
    flags.set(name, PATH_FLAGS.has(name) ? at(value) : value);
  }
  return { command, flags };
}

function readRecorded(verifierRoot: string): VerifierHashPair | null {
  try {
    const h = JSON.parse(readFileSync(join(verifierRoot, HASHES_PATH), 'utf8')) as Record<string, unknown>;
    return typeof h.verifierSha256 === 'string' && typeof h.lockfileSha256 === 'string' ? { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 } : null;
  } catch {
    return null;
  }
}

/** The verifier's own hashing over its files and the lockfile, as its `hashes --check` does. */
function recompute(verifierRoot: string, repoRoot: string): VerifierHashPair | null {
  try {
    const h = verifierHashes(verifierRoot, repoRoot);
    return { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 };
  } catch {
    return null;
  }
}

const startPath = (dir: string, track: Track): string => join(dir, `cohort-start-${track}.json`);

function readStarts(dir: string): StartRecords {
  const read = (t: Track): StartRecord | null => {
    const p = startPath(dir, t);
    return existsSync(p) ? StartRecordSchema.parse(JSON.parse(readFileSync(p, 'utf8'))) : null;
  };
  return { workers: read('workers'), assistant: read('assistant') };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

interface Context {
  readonly flags: Map<string, string>;
  readonly io: Io;
  readonly manifestPath: string;
  readonly startsDir: string;
}

function required(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

async function runPreflight(ctx: Context, manifest: Manifest): Promise<PreflightReport> {
  const verifierRoot = ctx.flags.get('verifier') ?? DEFAULTS.verifier;
  const repoRoot = ctx.flags.get('repo') ?? DEFAULTS.repo;
  // The CLI login is probed only in cli_login mode, and only its presence and logged-in flag come back.
  const cliLogin = manifest.credentials.mode === 'cli_login' && ctx.io.cliLogin ? await ctx.io.cliLogin() : undefined;
  return preflight({
    manifest, env: ctx.io.env, starts: readStarts(ctx.startsDir), ...(cliLogin ? { cliLogin } : {}),
    verifier: { recorded: readRecorded(verifierRoot), recomputed: recompute(verifierRoot, repoRoot) },
  });
}

async function runCommand(ctx: Context, which: 'workers' | 'assistant'): Promise<number> {
  const { runAssistantCommand, runWorkersCommand } = await import('./run-cli.ts');
  const { manifest } = readManifest(ctx.manifestPath);
  const run = which === 'workers' ? runWorkersCommand : runAssistantCommand;
  return run({
    flags: ctx.flags, manifest, repoRoot: REPO_ROOT, env: ctx.io.env, out: ctx.io.out,
    preflight: () => runPreflight(ctx, manifest), starts: () => readStarts(ctx.startsDir), ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
  });
}

const COMMANDS: Readonly<Record<string, (ctx: Context) => number | Promise<number>>> = {
  'run-workers': (ctx) => runCommand(ctx, 'workers'),
  async 'sweep-schemas'(ctx) {
    const url = ctx.io.env['DATABASE_URL'];
    if (!url) throw new UsageError('DATABASE_URL must name the PostgreSQL server');
    const hours = Number(required(ctx.flags, 'older-than-hours'));
    if (!Number.isFinite(hours) || hours <= 0) throw new UsageError('--older-than-hours must be a positive number');
    const { sweepBenchSchemas } = await import('./workers/stack.ts');
    const dropped = await sweepBenchSchemas(url, { olderThanMs: hours * 3_600_000 });
    ctx.io.out(`Dropped ${dropped.length} stale bench_ schema(s) older than ${hours} h. Only bench_<time>_<random> schemas are ever dropped.`);
    return 0;
  },
  'run-assistant': (ctx) => runCommand(ctx, 'assistant'),
  async preflight(ctx) {
    const report = await runPreflight(ctx, readManifest(ctx.manifestPath).manifest);
    ctx.io.out(formatPreflight(report));
    return report.liveDispatch.workers.allowed && report.liveDispatch.assistant.allowed ? 0 : 1;
  },
  freeze(ctx) {
    const seed = required(ctx.flags, 'seed');
    const { manifest } = readManifest(ctx.manifestPath);
    const frozen = freezeOrder(manifest, seed, ctx.io.now(), readStarts(ctx.startsDir));
    writeJson(ctx.manifestPath, frozen);
    ctx.io.out(`Froze seed and ${frozen.randomization.order.length} slots; order sha256 ${frozen.randomization.orderSha256}.`);
    return 0;
  },
  async 'record-start'(ctx) {
    const track = required(ctx.flags, 'track');
    if (!(TRACKS as readonly string[]).includes(track)) throw new UsageError(`--track must be one of ${TRACKS.join(', ')}`);
    const t = track as Track;
    const path = startPath(ctx.startsDir, t);
    const { manifest } = readManifest(ctx.manifestPath);
    if (ctx.flags.has('repair')) {
      const repaired = repairStart(manifest, t, readStarts(ctx.startsDir)[t]);
      if (repaired.manifest !== manifest) writeJson(ctx.manifestPath, repaired.manifest);
      if (!existsSync(path)) writeJson(path, repaired.start);
      ctx.io.out(`Repaired the ${t} start of ${repaired.start.startedAtUtc}; run preflight to confirm the manifest is unchanged since.`);
      return 0;
    }
    if (existsSync(path)) throw new FrozenError(`${t} already has a start recorded at ${path}`);
    const stamp = manifest.starts[t];
    if (stamp !== null) throw new FrozenError(`${t} already started at ${stamp.startedAtUtc}; if its start file is missing, run record-start --repair`);
    const decision = (await runPreflight(ctx, manifest)).liveDispatch[t];
    if (!decision.allowed) throw new BlockedError(`preflight blocks ${t}, so it cannot start: ${decision.blockers.join(', ')}`);
    const { start, manifest: stamped } = recordStart(manifest, t, ctx.io.now());
    // The stamp first: if the file write fails, the manifest still says the track started, so freeze stays refused
    // and preflight reports the missing file until `record-start --repair` writes it.
    writeJson(ctx.manifestPath, stamped);
    writeJson(path, start);
    ctx.io.out(`Recorded the ${t} start at ${start.startedAtUtc}; the seed, order and manifest are now fixed for it.`);
    return 0;
  },
  report(ctx) {
    const records = readJson(required(ctx.flags, 'records'));
    if (!Array.isArray(records)) throw new ExportError(['the records file must be a JSON array of trial records']);
    const { manifest } = readManifest(ctx.manifestPath);
    const file = exportResults({ manifest, starts: readStarts(ctx.startsDir), records, generatedAtUtc: ctx.io.now() });
    const out = ctx.flags.get('out');
    if (out !== undefined) writeJson(out, file);
    ctx.io.out(renderReport(buildReport(file, manifest)));
    return 0;
  },
  publish(ctx) {
    const out = ctx.flags.get('out') ?? DEFAULTS.publicOut;
    const { manifest } = readManifest(ctx.manifestPath);
    const file = preparePublish(readJson(required(ctx.flags, 'results')), ctx.io.now(), manifest);
    writePublished(file, out);
    ctx.io.out(`Published ${file.records.length} records to ${out}, generated ${file.generatedAtUtc}.`);
    return 0;
  },
};

const KNOWN_ERRORS = [ManifestError, ExportError, ReportError, PublishError, FrozenError, BlockedError, SyntaxError, LiveRefusedError, OrderError];

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(io.cwd ?? process.cwd(), p));
  try {
    const { command, flags } = parseArgs(argv, at);
    const run = command === undefined ? undefined : COMMANDS[command];
    if (run === undefined) throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${command}`);
    const manifestPath = flags.get('manifest') ?? DEFAULTS.manifest;
    return await run({ flags, io, manifestPath, startsDir: flags.get('starts') ?? dirname(manifestPath) });
  } catch (e) {
    if (e instanceof UsageError || e instanceof RunUsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    const known = KNOWN_ERRORS.some((k) => e instanceof k);
    io.err(redactSecrets(known ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const io: Io = {
    out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env,
    now: () => new Date().toISOString(), cwd: process.env.INIT_CWD ?? process.cwd(), signal: stop.signal, cliLogin: async () => ({ ...(await claudeCliLoginProbe()()), sandboxSecret: await (await import('./workers/agent-state.ts')).sbxAnthropicSecret() }),
  };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
