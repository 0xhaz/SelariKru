import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CatalogModel, CatalogProvider, HarnessCatalog, RunnerHarnessReport } from '@selarikru/protocol';

export const CLAUDE_PROVIDER_ID = 'anthropic';

/**
 * Pinned from the installed Claude Code 2.1.316 binary: its model catalog gives these exact ids (`provider_ids.first_party`) and display names, and its `pricing` table
 * these list prices. `claude-sonnet-5-5` is also the id the spike observed in a real init event. A rate here is a list price from that table, never an observed cost.
 */
const RATE_SOURCE = 'Claude Code 2.1.316 pricing table (list prices)';
export const CLAUDE_MODELS: readonly CatalogModel[] = Object.freeze([
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', route: 'cloud', rate: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, source: RATE_SOURCE } },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', route: 'cloud', rate: { inputUsdPerMTok: 4, outputUsdPerMTok: 20, source: RATE_SOURCE } },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', route: 'cloud', rate: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5, source: RATE_SOURCE } },
]);

/** What this build can launch, with no claim that any machine has it. The control plane uses this; only a runner's report says a harness is installed. */
export const declaredHarnessCatalog = (): HarnessCatalog => ({ status: 'detected', detail: null, providers: [claudeProvider(null)] });

/** What this adapter declares, given the version actually found on the machine. */
export function claudeProvider(harnessVersion: string | null): CatalogProvider {
  return { provider: CLAUDE_PROVIDER_ID, label: 'Claude', harnessVersion, models: CLAUDE_MODELS, modelSelection: 'supported' };
}

const exec = promisify(execFile);

/** Reads the installed CLI's version and nothing else. It starts no session, makes no model call, and never touches credentials. */
export type VersionProbe = () => Promise<string>;
const probeClaude: VersionProbe = async () => (await exec('claude', ['--version'], { timeout: 20_000 })).stdout;

/** Real availability: Claude is offered only when the `claude` CLI on this machine answers. If it cannot be read, the catalog says so and offers nothing. */
export async function detectClaude(probe: VersionProbe = probeClaude): Promise<HarnessCatalog> {
  let answer: string;
  try {
    answer = await probe();
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    return missing
      ? { status: 'none', detail: 'Claude Code (the `claude` CLI) was not found on this machine, so no provider can be offered.', providers: [] }
      : { status: 'unknown', detail: '`claude --version` did not answer, so whether a provider is available is unknown.', providers: [] };
  }
  const version = /^\s*(\d+\.\d+\.\d+)/.exec(answer)?.[1];
  if (version === undefined) return { status: 'unknown', detail: '`claude --version` gave an unexpected answer, so whether a provider is available is unknown.', providers: [] };
  return { status: 'detected', detail: null, providers: [claudeProvider(version)] };
}

/**
 * The seam for further adapters: each detector reports only itself, and the first non-empty answer wins here until there is a second adapter to merge. A provider with no
 * detector in this list is never offered.
 */
export async function detectHarnesses(detectors: readonly (() => Promise<HarnessCatalog>)[] = [detectClaude]): Promise<HarnessCatalog> {
  const results = await Promise.all(detectors.map((d) => d()));
  const providers = results.flatMap((r) => r.providers);
  if (providers.length > 0) return { status: 'detected', detail: null, providers };
  const unknown = results.find((r) => r.status === 'unknown');
  return unknown ?? results[0] ?? { status: 'none', detail: 'No harness adapter is registered in this process.', providers: [] };
}

export const reportOf = (catalog: HarnessCatalog): RunnerHarnessReport[] => catalog.providers.map((p) => ({ provider: p.provider, harnessVersion: p.harnessVersion, models: p.models.map((m) => m.id) }));

/**
 * The runner's probe, cached. A probe that could not finish is retried soon rather than sticking until a restart, and it does not discard the last good answer; a clear "not
 * installed" does. A good answer is refreshed now and then, so a harness removed later stops being reported. Never throws.
 */
export function cachedHarnessReport(detect: () => Promise<HarnessCatalog> = detectHarnesses, opts: { readonly now?: () => number; readonly retryMs?: number; readonly refreshMs?: number } = {}): () => Promise<RunnerHarnessReport[]> {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? 30_000;
  const refreshMs = opts.refreshMs ?? 600_000;
  let last: RunnerHarnessReport[] = [];
  let nextAt = 0;
  return async () => {
    if (now() < nextAt) return last;
    let found: HarnessCatalog;
    try {
      found = await detect();
    } catch {
      found = { status: 'unknown', detail: null, providers: [] };
    }
    if (found.status === 'detected') {
      last = reportOf(found);
      nextAt = now() + refreshMs;
    } else {
      if (found.status === 'none') last = [];
      nextAt = now() + retryMs;
    }
    return last;
  };
}
