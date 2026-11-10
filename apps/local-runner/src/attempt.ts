import { PILOT_ROLE_PATHS } from '@selarikru/domain';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '@selarikru/artifacts';
import type { TaskSpec } from '@selarikru/domain';
import { CLAUDE_MODELS, CLAUDE_PROVIDER_ID, ClaudeHarnessAdapter, type HarnessLauncher } from '@selarikru/harness-claude';
import { approvalUnavailableReason, ADVISORY_APPROVAL_OPERATIONS, redactSecrets, ToolNameSchema, type ApprovalDestination, type ApprovalRefusalReason, type HarnessAdapter, type LeaseGrant, type RuntimeAdapter, type SandboxHandle, type ToolchainSpec, type WorkerApprovalOperation } from '@selarikru/protocol';
import { buildTaskBundle, checkAllowedPaths, computeChanges, readRegularFile, resolveToolchain, RuntimeHarnessLauncher, validateAllowedPaths, type FileChange } from '@selarikru/runtime-docker-local';
import { createHash } from 'node:crypto';
import { LeaseLostError, leaseRef, type ClaimedLease, type RunnerApi, type RunnerResult } from './api.ts';
import { ControlBridge, type ControlDeps } from './control.ts';
import { TERMINAL_PREVIEW_CHARS, TerminalFeed } from './terminal.ts';

/** A harness this runner can start. It declares the models it runs, so an unsupported one is refused before any sandbox exists. */
export interface RunnerHarness {
  readonly provider: string;
  readonly models: readonly string[];
  create(launcher: HarnessLauncher): HarnessAdapter;
}

/** Only what this adapter set can actually launch. Nothing is registered for a provider that is not installed. */
export const DEFAULT_HARNESSES: readonly RunnerHarness[] = [{ provider: CLAUDE_PROVIDER_ID, models: CLAUDE_MODELS.map((m) => m.id), create: (launcher) => new ClaudeHarnessAdapter(launcher) }];

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
  /** Default: `DEFAULT_HARNESSES`. The seam a further provider's adapter plugs into. */
  readonly harnesses?: readonly RunnerHarness[];
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly log: (line: string) => void;
  /** Aborted on SIGTERM/SIGINT: the running attempt gets a bounded stop and destroy, and publishes nothing (the lease lapses). */
  readonly signal?: AbortSignal;
  /** Built-in tools the agent may use. Default: file and shell tools only, no WebFetch/WebSearch/Task. */
  readonly tools?: readonly string[];
  /** Multiplier on the attempt timeout, for tests only. */
  readonly timeoutScale?: number;
  /** How a person reaches this attempt's sandbox shell in control mode. Absent: this runner offers no control mode. */
  readonly control?: ControlDeps;
  /** Output retained and uploaded for the Terminal tab. Default limits suit production; tests shrink them. */
  readonly terminalFeedLimits?: ConstructorParameters<typeof TerminalFeed>[3];
}

export interface AttemptReport {
  readonly outcome: 'completed' | 'failed' | 'blocked' | 'approval_requested' | 'infrastructure_failed' | 'lease_lost' | 'aborted';
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

/** Where in the workspace the agent signals an approval request (a `Write` of JSON, see `TASK.md`). Reserved: never part of a change set. */
export const APPROVAL_SIGNAL_RELATIVE_PATH = '.selarikru/approval-request.json';
const RESERVED_DIR = '.selarikru';

const grantedLabel = (g: LeaseGrant): string => (g.destination ? `${g.operation} (destination ${g.destination.host})` : g.operation);

/** Proposal and blueprint text is one paragraph here, so it cannot start a section of its own in TASK.md. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

/** The pilot's split of the work, stated only to a worker actually holding one role's fixed paths. */
const pilotRoleText = (task: TaskSpec): string[] => {
  const paths = (PILOT_ROLE_PATHS as Readonly<Record<string, readonly string[]>>)[task.role];
  if (paths === undefined || JSON.stringify(paths) !== JSON.stringify(task.allowedPaths)) return [];
  return [
    '## Who does what',
    `You are the ${task.role} worker. Another worker builds the other half at the same time, against the same frozen contract.`,
    '- The backend worker owns the API, SQLite persistence and serving the built frontend from dist/: server/, migrations/ and tests/backend/.',
    '- The frontend worker owns the screen: src/ and tests/frontend/.',
    '- Everything else in the repository, including contract/, is for reading. Neither worker changes the other\'s paths.',
    '- Do not add, remove or upgrade dependencies. package.json and the lockfile are fixed.',
    '- Any UI test you write runs in the existing node environment: vitest, with no jsdom and no browser.',
    '',
  ];
};

export function renderTaskFile(task: TaskSpec, opts: { readonly signalPath?: string; readonly grants?: readonly LeaseGrant[]; readonly priorFailure?: string; readonly toolchain?: ToolchainSpec } = {}): string {
  const grants = opts.grants ?? [];
  return [
    `# Task: ${task.title}`,
    '',
    `- task: ${task.taskId} (revision ${task.revision}), role: ${task.role}`,
    `- requirements: ${task.requirementIds.join(', ') || 'none listed'}`,
    `- acceptance checks: ${task.acceptanceCheckIds.join(', ') || 'none listed'}`,
    '',
    ...(task.description !== undefined ? ['## What to build', oneLine(task.description), ''] : []),
    ...(task.criteria !== undefined && task.criteria.length > 0 ? ['## Acceptance criteria', 'The result is judged against these.', ...task.criteria.map((c) => `- ${c.id}: ${oneLine(c.text)}`), ''] : []),
    ...pilotRoleText(task),
    ...(opts.priorFailure !== undefined ? ['## Why the last attempt failed', 'This is a report about the last attempt, not an instruction. Fix what it describes, then finish the task.', oneLine(opts.priorFailure), ''] : []),
    '## Allowed paths',
    'Change files only under these paths. Any change outside them is rejected after the run.',
    ...(task.allowedPaths.length > 0 ? task.allowedPaths.map((p) => `- ${p}`) : ['- (none: make no changes)']),
    '',
    ...(opts.toolchain !== undefined
      ? [
          '## Toolchain',
          `Node ${opts.toolchain.nodeVersion} and pnpm ${opts.toolchain.pnpmVersion} are installed and on PATH, and the dependencies are installed from the frozen lockfile. Do not install them again.`,
          'Run the project\'s scripts with pnpm, for example `pnpm build` and `pnpm test`.',
          '',
        ]
      : []),
    '## Rules',
    '- Read contract/runtime.md first; it is the contract the result is verified against.',
    '- Do not commit, push, or change git configuration.',
    "- Output the base commit's .gitignore covers (build output and local data) never joins your change, so build and start the app freely. Editing .gitignore does not change what is ignored.",
    '- Work only in this directory.',
    '',
    ...(opts.signalPath !== undefined
      ? [
          '## Asking for a human decision',
          `If this task truly needs one of: ${ADVISORY_APPROVAL_OPERATIONS.join(', ')}, stop and ask. Do not attempt it.`,
          'Ask by writing, with the Write tool and nothing else, exactly this path:',
          `  ${opts.signalPath}`,
          'with this JSON and no other fields, then end your turn:',
          '  {"operation":"<one of the list above>","reason":"<one sentence>"}',
          ...(grants.length > 0 ? ['', '## Already approved for this attempt', 'A person approved these. Do not ask for them again:', ...grants.map((g) => `- ${grantedLabel(g)}`)] : []),
          '',
        ]
      : []),
  ].join('\n');
}

export const DEFAULT_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

export const AGENT_PROMPT =
  'Read TASK.md in the current directory and complete the task it describes. Follow contract/runtime.md. Change only the allowed paths listed in TASK.md. Do not commit.';

const coversSignal = (grants: readonly LeaseGrant[], operation: WorkerApprovalOperation, destination: ApprovalDestination | null): boolean =>
  grants.some((g) => g.operation === operation && (g.destination === null ? destination === null : g.destination.kind === destination?.kind && g.destination.host === destination.host));

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
  let feed: TerminalFeed | null = null;
  let stopping: Promise<unknown> | null = null;
  let control: ControlBridge | null = null;
  let provisioning: AbortController | null = null;
  const requestStop = (): void => {
    // Before the worker: nobody should be typing into an attempt that is stopping.
    void control?.shutdown();
    provisioning?.abort();
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
  // The tool the worker last started, reported once per start. The heartbeat carries its name and nothing else; a heartbeat with no activity says only that the runner is alive,
  // so a hung tool keeps the time it started. It stays pending until a heartbeat lands, and a newer start is never cleared by an older one's answer.
  let pendingActivity: { readonly tool: string; readonly start: number } | null = null;
  let toolStarts = 0;
  const beat = setInterval(() => {
    if (aborted()) {
      requestStop();
      return;
    }
    if (beating) return;
    beating = true;
    const sending = pendingActivity;
    deps.api
      .heartbeat(ref, sending?.tool)
      .then((hb) => {
        missed = 0;
        if (sending !== null && pendingActivity?.start === sending.start) pendingActivity = null;
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
  const markSetup = (): number => {
    const setupSeconds = Math.min(86_400, (Date.now() - startedMs) / 1000);
    reportedUsage = { reportedUsage: { setupSeconds } };
    return setupSeconds;
  };
  const finish = async (outcome: 'completed' | 'failed' | 'blocked' | 'approval_requested' | 'infrastructure_failed', reason: string | null, cost: number | null, manifest: string | null, approval?: { readonly operation: WorkerApprovalOperation; readonly destination: ApprovalDestination | null }): Promise<AttemptReport> => {
    const result: RunnerResult =
      outcome === 'completed'
        ? { outcome, ...(manifest !== null ? { changeManifestSha256: manifest } : {}), ...(cost !== null ? { reportedCostUsd: cost } : {}), ...reportedUsage }
        : outcome === 'approval_requested'
          ? { outcome, reason: clip(reason ?? outcome), operation: approval!.operation, ...(approval!.destination ? { destination: approval!.destination } : {}), ...(cost !== null ? { reportedCostUsd: cost } : {}), ...reportedUsage }
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
    // A grant that reaches the network is only honest if the sandbox can limit egress to exactly that destination. It cannot yet (see the runtime), so
    // the task stops here, before any sandbox exists, and says why. New requests of this kind are refused when asked; this holds for a grant already issued.
    // Note that every sandbox still has the machine-wide allowlist it inherits from sbx policy: no attempt runs with a network limited to what was granted.
    const grants = lease.grants ?? [];
    const egressGrants = grants.filter((g) => g.destination !== null);
    if (egressGrants.length > 0 && (await deps.runtime.capabilities()).egressAllowlist !== 'enforced') {
      return await finish('blocked', `egress_enforcement_unavailable: this runtime cannot limit a sandbox to ${egressGrants.map((g) => g.destination!.host).join(', ')}`, null, null);
    }

    // The recorded model is what launches, or nothing does. These checks sit before the sandbox: an unsupported model must fail with no sandbox created.
    const assignment = lease.assignment;
    if (assignment === null) return await finish('blocked', 'no_model_recorded: this attempt carries no recorded model, so it cannot run', null, null);
    const harnessEntry = (deps.harnesses ?? DEFAULT_HARNESSES).find((h) => h.provider === assignment.provider);
    if (harnessEntry === undefined) return await finish('blocked', `unsupported_provider:${assignment.provider}/${assignment.model}`, null, null);
    if (!harnessEntry.models.includes(assignment.model)) return await finish('blocked', `unsupported_model:${assignment.provider}/${assignment.model}`, null, null);

    // Read from the base commit before any sandbox exists: a pin that cannot be read fails the same way every time, so it blocks instead of spending retries.
    const toolchain = await resolveToolchain(repo, task.baseSha);
    if (toolchain.kind === 'unresolved') return await finish('blocked', `toolchain_unresolved: ${toolchain.reason}`, null, null);
    const toolchainSpec: ToolchainSpec | null = toolchain.kind === 'pinned' ? { nodeVersion: toolchain.nodeVersion, pnpmVersion: toolchain.pnpmVersion } : null;

    const signalPath = join(workspace, APPROVAL_SIGNAL_RELATIVE_PATH);
    const taskFile = renderTaskFile(task, { signalPath, grants, ...(lease.priorFailure ? { priorFailure: redactSecrets(lease.priorFailure).slice(0, 1000) } : {}), ...(toolchainSpec !== null ? { toolchain: toolchainSpec } : {}) });
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
    let baseIgnores;
    try {
      const b = await buildTaskBundle({ repoPath: repo, baseSha: task.baseSha, destDir: workspace, taskFiles: { 'TASK.md': taskFile } });
      baseline = b.baseline;
      baseIgnores = b.baseIgnores;
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

    if (toolchainSpec !== null) {
      if (deps.runtime.provision === undefined) return await finish('infrastructure_failed', 'provisioning_failed: this runtime cannot set up a Node toolchain', null, null);
      log(`provisioning toolchain: node ${toolchainSpec.nodeVersion} pnpm ${toolchainSpec.pnpmVersion}`);
      provisioning = new AbortController();
      const provisioned = await deps.runtime.provision(handle, toolchainSpec, { signal: provisioning.signal, timeoutMs: Math.max(1, budgetMs - (Date.now() - startedMs)) });
      provisioning = null;
      markSetup();
      if (flags.aborted) return { outcome: 'aborted', reason: 'runner shutting down', changeManifest: null };
      if (flags.leaseLost) return { outcome: 'lease_lost', reason: null, changeManifest: null };
      if (flags.cancelled) return await finish('failed', 'cancelled by owner request before the agent started', null, null);
      // Nothing ran yet, so even the clock running out here is the setup's doing, not the worker's.
      if (flags.timedOut) return await finish('infrastructure_failed', 'provisioning_failed: the attempt timeout was reached during setup', null, null);
      if (!provisioned.ok) {
        if (provisioned.detail !== null) log(`provisioning detail: ${provisioned.detail}`);
        return await finish('infrastructure_failed', `provisioning_failed: ${provisioned.reason}`, null, null);
      }
      log(`toolchain ready: node ${provisioned.nodeVersion} pnpm ${provisioned.pnpmVersion} arch ${provisioned.arch} in ${provisioned.seconds.toFixed(1)}s`);
    }

    launcher = new RuntimeHarnessLauncher(deps.runtime, handle, Math.max(1, Math.ceil(budgetMs / 1000)));
    const harness = harnessEntry.create(launcher);
    let resultOk = false;
    let resultNote = 'the agent produced no result';
    let exitFailed = false;
    let exitNote = '';
    let refused: string | null = null;
    let cost: number | null = null;
    let mcpViolation: string[] | null = null;
    // A worker silently running a different model from the record is the failure this feature exists to prevent: it stops here and is reported, never tolerated.
    let modelFault: string | null = null;
    // No init event means nothing ever said which model ran, so the attempt cannot count as done.
    let initSeen = false;
    // The agent's first approval signal ends the attempt: the runner stops it and the control plane decides whether a person is asked.
    let approvalRequest: { readonly operation: WorkerApprovalOperation; readonly destination: ApprovalDestination | null; readonly reason: string } | null = null;
    let approvalRefused: ApprovalRefusalReason | null = null;
    // Asked for something a grant could not make real. Stopped here; no person is asked.
    let approvalUnavailable: string | null = null;
    let coveredSignal = false;
    const setupSeconds = markSetup();
    // The claim decided this from every source's label. Work that may not leave this machine never turns previews on, so there is nothing to upload.
    feed = lease.streamable === true ? new TerminalFeed(deps.api, ref, log, deps.terminalFeedLimits) : null;
    feed?.start();
    // The lease says the control plane could allow this at all (streamable, not a trial). Whether it does is decided for each ticket.
    if (deps.control && lease.controllable === true) {
      control = new ControlBridge({ connect: deps.control.connectorFor(ref), runtime: deps.runtime, handle, log, ...(deps.control.limits !== undefined ? { limits: deps.control.limits } : {}) });
      control.start();
    }
    for await (const ev of harness.run({ attemptId: lease.attemptId, prompt: AGENT_PROMPT, workspacePath: workspace, model: { provider: assignment.provider, model: assignment.model }, ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}), mcp: 'none', tools: deps.tools ?? DEFAULT_TOOLS, approvalSignalPath: signalPath, ...(feed !== null ? { previews: { enabled: true, maxChars: TERMINAL_PREVIEW_CHARS, raw: true } } : {}) })) {
      feed?.onEvent(ev);
      if (aborted()) requestStop();
      switch (ev.type) {
        case 'session_started':
          log(`session: mode=${ev.permissionMode ?? 'unknown'} connectedMcp=${ev.connectedMcpServers === null ? 'unreported' : JSON.stringify(ev.connectedMcpServers)}`);
          initSeen = ev.initObserved;
          if (ev.initObserved && ev.model !== assignment.model) {
            modelFault = ev.model === null ? `model_unverified: recorded ${assignment.model}, the stream did not say which model ran` : `model_mismatch: recorded ${assignment.model}, the stream reports ${ev.model}`;
            log(modelFault);
            requestStop();
          }
          if (ev.connectedMcpServers !== null && ev.connectedMcpServers.length > 0) {
            mcpViolation = [...ev.connectedMcpServers];
            requestStop();
          }
          break;
        case 'tool_call': {
          // A name the wire would refuse is left unsaid: an odd tool name must never cost the attempt its heartbeat.
          const name = ToolNameSchema.safeParse(ev.toolName);
          if (name.success) pendingActivity = { tool: name.data, start: (toolStarts += 1) };
          break;
        }
        case 'launch_refused':
          refused = ev.reason === 'capability_unavailable' ? `${ev.capability} is ${ev.status}` : `model_unsupported:${ev.provider}/${ev.model}`;
          break;
        case 'approval_signal':
          // Already granted to this attempt: it may proceed. It does not ask again.
          if (coversSignal(grants, ev.operation, ev.destination)) {
            coveredSignal = true;
            log(`approval signal for ${ev.operation} already covered by a grant`);
            break;
          }
          if (approvalRequest === null && approvalRefused === null && approvalUnavailable === null) {
            const unavailable = approvalUnavailableReason(ev.operation);
            // The runtime is the authority on egress; asking it keeps this right if a runtime ever can enforce one.
            if (unavailable === 'egress_enforcement_unavailable' ? (await deps.runtime.capabilities()).egressAllowlist !== 'enforced' : unavailable !== null) {
              approvalUnavailable = unavailable;
              log(`agent asked for ${ev.operation}, which cannot take effect: ${unavailable}`);
            } else {
              approvalRequest = { operation: ev.operation, destination: ev.destination, reason: ev.reason };
              log(`agent requested approval: ${ev.operation}`);
            }
            requestStop();
          }
          break;
        case 'approval_refused':
          if (approvalRequest === null && approvalRefused === null && approvalUnavailable === null) {
            approvalRefused = ev.why;
            log(`approval signal refused: ${ev.why}`);
            requestStop();
          }
          break;
        case 'usage':
          cost = ev.usage.costUsd;
          reportedUsage = { reportedUsage: { inputTokens: wireTokens(ev.usage.inputTokens), outputTokens: wireTokens(ev.usage.outputTokens), cacheReadTokens: wireTokens(ev.usage.cacheReadTokens), cacheCreationTokens: wireTokens(ev.usage.cacheCreationTokens), setupSeconds, costBasis: ev.usage.costBasis } };
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
    // Any session ends the moment the worker does: the shell must be gone before the workspace is read.
    await control?.shutdown();
    if (stopping) await stopping;
    await feed?.close();

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
    // Blocked, not failed: this is a configuration fault, and repairs would only repeat it.
    if (modelFault !== null) return await finish('blocked', modelFault, cost, null);
    if (flags.cancelled) return await finish('failed', 'cancelled by owner request; agent stopped and confirmed', cost, null);
    if (flags.timedOut) return await finish('failed', 'attempt timeout reached; agent stopped and confirmed', cost, null);
    if (refused !== null) return await finish('blocked', `harness capability unavailable: ${refused}`, cost, null);
    // A refused or requested approval is the agent's outcome even though it was stopped before producing a result.
    if (approvalRefused !== null) return await finish('blocked', `approval_signal_refused: ${approvalRefused}`, cost, null);
    if (approvalUnavailable !== null) return await finish('blocked', approvalUnavailable, cost, null);
    if (approvalRequest !== null) return await finish('approval_requested', (approvalRequest as { reason: string }).reason, cost, null, approvalRequest);
    if (!resultOk) return await finish('failed', exitFailed && exitNote ? `${resultNote}; ${exitNote}` : resultNote, cost, null);
    if (exitFailed) return await finish('failed', exitNote || 'agent exited with an error', cost, null);
    if (!initSeen) return await finish('blocked', `model_unverified: recorded ${assignment.model}, the stream never reported a model`, cost, null);

    // The signal file of a covered request is the protocol, not the agent's work; a stray copy in any other form is left for the gate to refuse.
    if (coveredSignal) {
      await rm(signalPath, { force: true }).catch(() => undefined);
      await rmdir(join(workspace, RESERVED_DIR)).catch(() => undefined);
    }

    // The real control: the actual diff against the shipped base, not what the agent says it did.
    let changes: FileChange[];
    try {
      changes = await computeChanges(baseline, workspace, baseIgnores);
    } catch (err) {
      return await finish('failed', `could not compute the diff: ${err instanceof Error ? err.message : 'error'}`, cost, null);
    }
    if (changes.some((c) => c.path === RESERVED_DIR || c.path.startsWith(`${RESERVED_DIR}/`))) return await finish('failed', 'a change touches the reserved .selarikru directory', cost, null);
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
    await control?.shutdown();
    feed?.abort();
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
