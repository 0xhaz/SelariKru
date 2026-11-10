import { execFile } from 'node:child_process';
import { inScope } from '@selarikru/runtime-docker-local';
import type { AgentState } from './runner.ts';

/**
 * I4, live only: the worker agent's state as sbx shows it, read-only. What was established (read-only `sbx --help`,
 * `sbx create --help`, `sbx secret ls`, `sbx settings get`):
 * - each `sbx create … claude <workspace>` is a new container from the agent image, and the runtime removes it after the
 *   attempt, so Claude config, memory, history and CLAUDE.md inside it do not outlive the attempt;
 * - the runtime passes `--skills off` and mounts only the workspace, so neither the shared skills store nor the host home
 *   (`~/.claude`) reaches the sandbox;
 * - the owner's login reaches every sandbox as sbx's global `anthropic` service secret (OAuth), injected by the sbx proxy:
 *   the credential is shared machine-wide by design, never copied into the sandbox;
 * - `kit.shortcuts.claude`, when set, swaps the agent image for every Claude sandbox on the machine: shared state.
 * Only names and flags come back; no secret value, account or token is read.
 */

export type ReadOnlyExec = (file: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>;

const READ_ONLY: readonly (readonly string[])[] = [['ls', '--json'], ['settings', 'get', 'kit.shortcuts.claude'], ['secret', 'ls']];

const defaultExec: ReadOnlyExec = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ stdout: String(stdout ?? ''), code: err ? 1 : 0 }));
});

/** True when sbx lists a global `anthropic` service secret. Null when the list cannot be read. */
export async function sbxAnthropicSecret(exec: ReadOnlyExec = defaultExec): Promise<boolean | null> {
  const r = await exec('sbx', ['secret', 'ls']).catch(() => null);
  if (r === null || r.code !== 0) return null;
  return r.stdout.split('\n').some((l) => /^\s*\(global\)\s+service\s+anthropic\b/.test(l));
}

export function sbxAgentState(exec: ReadOnlyExec = defaultExec): (scope: string) => Promise<AgentState> {
  return async (scope) => {
    const ls = await exec('sbx', READ_ONLY[0]!);
    if (ls.code !== 0) throw new Error('sbx ls failed');
    const names = (JSON.parse(ls.stdout.trim() === '' ? '[]' : ls.stdout) as { name?: unknown }[]).flatMap((e) => (typeof e.name === 'string' ? [e.name] : []));
    const kit = await exec('sbx', READ_ONLY[1]!);
    return {
      scopedSandboxes: names.filter((n) => inScope(n, scope)),
      kitShortcut: kit.code === 0 && kit.stdout.trim() !== '' ? kit.stdout.trim() : null,
      sandboxSecret: await sbxAnthropicSecret(exec),
    };
  };
}
