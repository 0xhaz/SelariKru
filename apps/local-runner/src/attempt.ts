import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '@selarikru/artifacts';
import type { TaskSpec } from '@selarikru/domain';
import { ClaudeHarnessAdapter } from '@selarikru/harness-claude';
import { redactSecrets, type RuntimeAdapter, type SandboxHandle } from '@selarikru/protocol';
import { buildTaskBundle, checkAllowedPaths, computeChanges, readRegularFile, RuntimeHarnessLauncher, validateAllowedPaths, type FileChange } from '@selarikru/runtime-docker-local';
import { createHash } from 'node:crypto';
import { LeaseLostError, leaseRef, type ClaimedLease, type RunnerApi, type RunnerResult } from './api.ts';

export interface AttemptDeps {
  readonly api: RunnerApi;
  readonly runtime: RuntimeAdapter;
  readonly artifacts: ArtifactStore;
  /** The runner's work root. Per-attempt directories live in `<workRoot>/attempts/<attemptId>`. */
  readonly workRoot: string;
  /** Local source repositories by project id. A project without one cannot run here. */
  readonly repos: Readonly<Record<string, string>>;
  /** 10 s in production (docs/architecture.md section 8). */
  readonly heartbeatMs: number;
  /** After this many consecutive failed heartbeats the lease is presumed lost (60 s expiry / 10 s interval = 6). */
  readonly maxMissedHeartbeats: number;
  readonly maxTurns?: number;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly log: (line: string) => void;
  /** Aborted on SIGTERM/SIGINT: the running attempt gets a bounded stop and destroy, and publishes nothing (the lease lapses). */
  readonly signal?: AbortSignal;
  /** Built-in tools the agent may use. Default: file and shell tools only, no WebFetch/WebSearch/Task. */
  readonly tools?: readonly string[];
  /** Multiplier on the attempt timeout, for tests only. */
  readonly timeoutScale?: number;
}

export interface AttemptReport {
  readonly outcome: 'completed' | 'failed' | 'blocked' | 'lease_lost' | 'aborted';
  readonly reason: string | null;
  /** sha256 of the stored change manifest (artifact store), when a diff was captured. */
  readonly changeManifest: string | null;
}

const safeSegment = (id: string): string => {
  const s = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return s === '' || s === '.' || s === '..' ? '_' : s;
};
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const clip = (s: string, n = 480): string => redactSecrets(s).slice(0, n);
/** The wire takes whole, bounded counts only. A harness number outside that is unknown; it must not get the whole result refused. */
const wireTokens = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 0 && n <= 1e12 ? n : null);

export function renderTaskFile(task: TaskSpec): string {
  return [
    `# Task: ${task.title}`,
    '',
    `- task: ${task.taskId} (revision ${task.revision}), role: ${task.role}`,
    `- requirements: ${task.requirementIds.join(', ') || 'none listed'}`,
    `- acceptance checks: ${task.acceptanceCheckIds.join(', ') || 'none listed'}`,
    '',
    '## Allowed paths',
    'Change files only under these paths. Any change outside them is rejected after the run.',
    ...(task.allowedPaths.length > 0 ? task.allowedPaths.map((p) => `- ${p}`) : ['- (none: make no changes)']),
    '',
    '## Rules',
    '- Read contract/runtime.md first; it is the contract the result is verified against.',
    '- Do not commit, push, or change git configuration.',
    '- Work only in this directory.',
    '',
  ].join('\n');
}

export const DEFAULT_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export const AGENT_PROMPT =
  'Read TASK.md in the current directory and complete the task it describes. Follow contract/runtime.md. Change only the allowed paths listed in TASK.md. Do not commit.';

interface Flags {
  cancelled: boolean;
  leaseLost: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/** One claimed attempt, end to end. Publishes at most one result, and always cleans up the sandbox and the workspace. */
export async function runAttempt(deps: AttemptDeps, lease: ClaimedLease): Promise<AttemptReport> {
  const ref = leaseRef(lease);
  const flags: Flags = { cancelled: false, leaseLost: false, timedOut: false, aborted: false };
  const aborted = (): boolean => flags.cancelled || flags.leaseLost || flags.timedOut || flags.aborted;
  const log = (line: string): void => deps.log(clip(`[${lease.attemptId}] ${line}`, 300));
  const attemptDir = join(deps.workRoot, 'attempts', safeSegment(lease.attemptId));
  const workspace = join(attemptDir, 'workspace');

  let handle: SandboxHandle | null = null;
  let launcher: RuntimeHarnessLauncher | null = null;
  let stopping: Promise<unknown> | null = null;
  const requestStop = (): void => {
    if (stopping === null && launcher?.current) stopping = launcher.stop(lease.attemptId).catch(() => undefined);
  };

  const onAbort = (): void => {
    flags.aborted = true;
    log('runner is shutting down; stopping the agent');
    requestStop();
  };
  if (deps.signal?.aborted) flags.aborted = true;
  else deps.signal?.addEventListener('abort', onAbort, { once: true });

  // Heartbeat from the very start: creating a sandbox can take longer than the lease.
  let missed = 0;
  let beating = false;
  const beat = setInterval(() => {
    if (aborted()) {
      requestStop();
      return;
    }
    if (beating) return;
    beating = true;
    deps.api
      .heartbeat(ref)
      .then((hb) => {
        missed = 0;
        if (hb.cancelRequested) {
          flags.cancelled = true;
          log('cancel requested by the owner; stopping the agent');
          requestStop();
        }
      })
      .catch((err: unknown) => {
        if (err instanceof LeaseLostError) {
          flags.leaseLost = true;
          log('lease is no longer current; stopping the agent');
          requestStop();
          return;
        }
        missed += 1;
        log(`heartbeat failed (${missed}/${deps.maxMissedHeartbeats})`);
        if (missed >= deps.maxMissedHeartbeats) {
          flags.leaseLost = true;
          requestStop();
        }
      })
      .finally(() => {
        beating = false;
      });
  }, deps.heartbeatMs);

  let deadline: ReturnType<typeof setTimeout> | null = null;
  const publish = async (r: RunnerResult): Promise<boolean> => {
    for (let i = 0; i < 3; i++) {
      try {
        await deps.api.result(ref, r);
        return true;
      } catch (err) {
        if (err instanceof LeaseLostError) return false;
        if (i < 2) await new Promise((res) => setTimeout(res, 500 * 2 ** i));
      }
    }
    return false;
  };
  // Sent once the agent started: the harness's own totals and how long setup took. The controller treats these as estimates.
  const startedMs = Date.now();
  let reportedUsage: { readonly reportedUsage: NonNullable<Extract<RunnerResult, { outcome: 'completed' }>['reportedUsage']> } | Record<string, never> = {};
  const finish = async (outcome: 'completed' | 'failed' | 'blocked', reason: string | null, cost: number | null, manifest: string | null): Promise<AttemptReport> => {
    const result: RunnerResult =
      outcome === 'completed'
        ? { outcome, ...(manifest !== null ? { changeManifestSha256: manifest } : {}), ...(cost !== null ? { reportedCostUsd: cost } : {}), ...reportedUsage }
        : { outcome, reason: clip(reason ?? outcome), ...(cost !== null ? { reportedCostUsd: cost } : {}), ...reportedUsage };
    const ok = await publish(result);
    log(`${outcome}${reason ? `: ${clip(reason, 200)}` : ''}${ok ? '' : ' (result not accepted)'}`);
    return ok ? { outcome, reason: reason === null ? null : clip(reason), changeManifest: manifest } : { outcome: 'lease_lost', reason: 'result not accepted', changeManifest: manifest };
  };

  try {
    let task: TaskSpec;
    try {
      task = await deps.api.task(ref);
    } catch (err) {
      if (err instanceof LeaseLostError) return { outcome: 'lease_lost', reason: 'lease not current at start', changeManifest: null };
      throw err;
    }

    const repo = deps.repos[task.projectId];
    if (task.execution === 'cloud') return await finish('blocked', 'task requires cloud execution; this is a local runner', null, null);
    if (repo === undefined) return await finish('blocked', 'no local source repository is configured for this project', null, null);
    const allowed = validateAllowedPaths(task.allowedPaths);
    if (!allowed.ok) return await finish('blocked', allowed.reason, null, null);
    if (!FULL_SHA.test(task.baseSha)) return await finish('blocked', 'task base is not a full commit id', null, null);
    const taskFile = renderTaskFile(task);
    if (redactSecrets(taskFile) !== taskFile || redactSecrets(AGENT_PROMPT) !== AGENT_PROMPT) {
      return await finish('blocked', 'task text contains a secret-shaped value; it was not sent to the agent', null, null);
    }

    const leaseDeadline = Date.parse(lease.deadlineAt);
    const budgetMs = Math.min(task.limits.timeoutSeconds * 1000 * (deps.timeoutScale ?? 1), Number.isFinite(leaseDeadline) ? Math.max(0, leaseDeadline - Date.now()) : Infinity);
    deadline = setTimeout(() => {
      flags.timedOut = true;
      log('attempt timeout reached; stopping the agent');
      requestStop();
    }, budgetMs);

    await mkdir(attemptDir, { recursive: true });
    let baseline;
    try {
      const b = await buildTaskBundle({ repoPath: repo, baseSha: task.baseSha, destDir: workspace, taskFiles: { 'TASK.md': taskFile } });
      baseline = b.baseline;
      log(`bundle ready: ${b.fileCount} files, ${b.excluded.length} excluded`);
    } catch (err) {
      return await finish('failed', `could not build the task bundle: ${err instanceof Error ? err.message : 'error'}`, null, null);
    }
    if (flags.aborted) return { outcome: 'aborted', reason: 'runner shutting down', changeManifest: null };
    if (flags.leaseLost) return { outcome: 'lease_lost', reason: null, changeManifest: null };
    if (flags.cancelled) return await finish('failed', 'cancelled by owner request before the agent started', null, null);

    try {
      handle = await deps.runtime.create({ attemptId: lease.attemptId, taskId: task.taskId, workspacePath: workspace, cpus: deps.cpus, memoryMiB: deps.memoryMiB });
    } catch (err) {
      // No host fallback, ever: the attempt fails.
      return await finish('failed', `sandbox unavailable: ${err instanceof Error ? err.message : 'error'}`, null, null);
    }
    if (flags.aborted) return { outcome: 'aborted', reason: 'runner shutting down', changeManifest: null };
    if (flags.leaseLost) return { outcome: 'lease_lost', reason: null, changeManifest: null };
    if (flags.cancelled || flags.timedOut) return await finish('failed', flags.timedOut ? 'attempt timeout reached before the agent started' : 'cancelled by owner request before the agent started', null, null);

    launcher = new RuntimeHarnessLauncher(deps.runtime, handle, Math.max(1, Math.ceil(budgetMs / 1000)));
    const harness = new ClaudeHarnessAdapter(launcher);
    let resultOk = false;
    let resultNote = 'the agent produced no result';
    let exitFailed = false;
    let exitNote = '';
    let refused: string | null = null;
    let cost: number | null = null;
    let mcpViolation: string[] | null = null;
    const setupSeconds = Math.min(86_400, (Date.now() - startedMs) / 1000);
    reportedUsage = { reportedUsage: { setupSeconds } };
    for await (const ev of harness.run({ attemptId: lease.attemptId, prompt: AGENT_PROMPT, workspacePath: workspace, ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}), mcp: 'none', tools: deps.tools ?? DEFAULT_TOOLS })) {
      if (aborted()) requestStop();
      switch (ev.type) {
        case 'session_started':
          log(`session: mode=${ev.permissionMode ?? 'unknown'} connectedMcp=${ev.connectedMcpServers === null ? 'unreported' : JSON.stringify(ev.connectedMcpServers)}`);
          if (ev.connectedMcpServers !== null && ev.connectedMcpServers.length > 0) {
            mcpViolation = [...ev.connectedMcpServers];
            requestStop();
          }
          break;
        case 'launch_refused':
          refused = `${ev.capability} is ${ev.status}`;
          break;
        case 'usage':
          cost = ev.usage.costUsd;
          reportedUsage = { reportedUsage: { inputTokens: wireTokens(ev.usage.inputTokens), outputTokens: wireTokens(ev.usage.outputTokens), cacheReadTokens: wireTokens(ev.usage.cacheReadTokens), cacheCreationTokens: wireTokens(ev.usage.cacheCreationTokens), setupSeconds } };
          break;
        case 'result':
          resultOk = ev.isError === false && ev.subtype === 'success';
          resultNote = `agent result ${ev.subtype ?? 'unknown'}${ev.terminalReason ? ` (${ev.terminalReason})` : ''}`;
          break;
        case 'exit':
          exitFailed = ev.failed;
          exitNote = `agent exited with code ${ev.code ?? 'none'}${ev.signal ? ` signal ${ev.signal}` : ''}`;
          break;
        case 'stream_error':
          exitFailed = true;
          exitNote = 'agent output stream failed';
          break;
        default:
          break;
      }
    }
    if (stopping) await stopping;

    // Never read a workspace an agent may still be writing to.
    let confirmed = true;
    if (launcher.current) {
      const ack = await deps.runtime.stop(launcher.current);
      confirmed = ack.terminationConfirmed;
      if (!confirmed) log(`stop not confirmed: ${clip(ack.detail ?? '', 120)}`);
    }

    if (flags.aborted) return { outcome: 'aborted', reason: 'runner shutting down', changeManifest: null };
    if (flags.leaseLost) return { outcome: 'lease_lost', reason: null, changeManifest: null };
    if (!confirmed) return await finish('failed', 'agent stop was not confirmed; the workspace is not trusted', cost, null);
    if (mcpViolation !== null) return await finish('failed', `unexpected MCP server connected: ${(mcpViolation as string[]).join(', ')}`, cost, null);
    if (flags.cancelled) return await finish('failed', 'cancelled by owner request; agent stopped and confirmed', cost, null);
    if (flags.timedOut) return await finish('failed', 'attempt timeout reached; agent stopped and confirmed', cost, null);
    if (refused !== null) return await finish('blocked', `harness capability unavailable: ${refused}`, cost, null);
    if (!resultOk) return await finish('failed', exitFailed && exitNote ? `${resultNote}; ${exitNote}` : resultNote, cost, null);
    if (exitFailed) return await finish('failed', exitNote || 'agent exited with an error', cost, null);

    // The real control: the actual diff against the shipped base, not what the agent says it did.
    let changes: FileChange[];
    try {
      changes = await computeChanges(baseline, workspace);
    } catch (err) {
      return await finish('failed', `could not compute the diff: ${err instanceof Error ? err.message : 'error'}`, cost, null);
    }
    let check: ReturnType<typeof checkAllowedPaths>;
    try {
      check = checkAllowedPaths(changes, allowed.normalized);
    } catch (err) {
      return await finish('failed', `completion gate error: ${err instanceof Error ? err.message : 'error'}`, cost, null);
    }
    if (!check.ok) {
      const shown = check.violations.slice(0, 5).map((v) => `${v.path} (${v.reason})`).join(', ');
      return await finish('failed', `diff outside allowedPaths: ${check.violations.length} path(s): ${shown}`, cost, null);
    }
    let manifest: string;
    try {
      manifest = await storeChanges(deps.artifacts, workspace, changes, task);
    } catch (err) {
      return await finish('failed', `change set could not be stored: ${err instanceof Error ? err.message : 'error'}`, cost, null);
    }
    return await finish('completed', null, cost, manifest);
  } finally {
    clearInterval(beat);
    deps.signal?.removeEventListener('abort', onAbort);
    if (deadline) clearTimeout(deadline);
    if (handle) {
      try {
        await deps.runtime.destroy(handle);
      } catch (err) {
        log(`sandbox cleanup failed; the next startup sweep will remove it: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function storeChanges(store: ArtifactStore, workspace: string, changes: readonly FileChange[], task: TaskSpec): Promise<string> {
  const entries: Array<FileChange & { size?: number }> = [];
  for (const c of changes) {
    if (c.kind === 'file' && c.status !== 'deleted') {
      // No-follow read of a regular file, and the bytes must still be the ones the gate hashed: a mismatch is a failure,
      // never a silent overwrite of the checked hash.
      const bytes = await readRegularFile(join(workspace, c.path));
      if (createHash('sha256').update(bytes).digest('hex') !== c.sha256) throw new Error(`${c.path} changed after it was checked`);
      const ref = await store.put(bytes);
      if (ref.sha256 !== c.sha256) throw new Error(`${c.path} stored under an unexpected hash`);
      entries.push({ ...c, size: ref.size });
    } else entries.push(c);
  }
  const body = JSON.stringify({ schema: 1, taskId: task.taskId, revision: task.revision, baseSha: task.baseSha, changes: entries });
  return (await store.put(Buffer.from(body))).sha256;
}
