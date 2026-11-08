/**
 * Runtime adapter contract (docs/techstack.md section 5). Types only; no I/O. Local (`sbx`) and cloud adapters
 * implement the same interface and run the same conformance suite (tests/conformance/runtime.ts).
 */
export type RuntimeLocation = 'local' | 'cloud';

export interface RuntimeCapabilities {
  readonly location: RuntimeLocation;
  /** Versions as observed from the runtime, or null when it could not be read. Never assumed. */
  readonly runtimeVersion: string | null;
  /** Always true for sandbox runtimes: a failed sandbox never falls back to host execution. */
  readonly hostFallback: false;
  readonly stopAcknowledgement: 'confirmed' | 'requested_only';
}

export interface SandboxSpec {
  readonly attemptId: string;
  readonly taskId: string;
  /** Host directory that becomes the only workspace mount. Never a home directory, a credential store or the platform repo. */
  readonly workspacePath: string;
  readonly cpus: number;
  readonly memoryMiB: number;
}

export interface SandboxHandle {
  /** Stable, derived from task and attempt identity; this is what reconciliation looks up. */
  readonly sandboxId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly workspacePath: string;
}

/** What to run inside the sandbox. The bundle's files are already in the workspace; the runtime never reads secrets into it. */
export interface TaskBundle {
  readonly attemptId: string;
  readonly command: readonly string[];
  /** Working directory inside the sandbox. */
  readonly cwd: string;
  /** In-guest hard limit in seconds (SIGTERM, then SIGKILL 10 s later). The host timer alone cannot stop a guest process. */
  readonly timeoutSeconds?: number;
}

export interface AttemptExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface AttemptHandle {
  readonly attemptId: string;
  readonly sandboxId: string;
  readonly startedAt: string;
  /** Raw output chunks, decoded as a UTF-8 stream. Need not align with lines. */
  readonly output: AsyncIterable<string>;
  readonly stdin: { write(data: string): void; end(): void };
  /** Resolves when the run ends, whether it exited, was stopped, or its client was killed. */
  readonly exited: Promise<AttemptExit>;
  /** Kills the host-side client only. It does NOT stop the agent in the sandbox: use `RuntimeAdapter.stop`. */
  readonly killClient: () => void;
}

export interface RuntimeStopAcknowledgement {
  readonly attemptId: string;
  readonly sandboxId: string;
  /** `stopped`: termination confirmed by inspection. `stop_failed`: bounded attempts exhausted and not confirmed. */
  readonly status: 'stopped' | 'stop_failed';
  readonly terminationConfirmed: boolean;
  /** True when signalling inside the sandbox was not enough and the sandbox itself was stopped. */
  readonly escalated: boolean;
  readonly detail: string | null;
}

export type SandboxState = 'running' | 'stopped' | 'absent' | 'unknown';

export interface RuntimeSnapshot {
  readonly sandboxId: string;
  readonly state: SandboxState;
  /** A stopped sandbox is normal (sandboxes auto-stop when the last exec ends), not a failure. */
  readonly exists: boolean;
  readonly observedAt: string;
}

export interface RuntimeAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  /** Idempotent by `spec` identity: an existing sandbox under the same stable name is reconciled (destroyed) first. */
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  start(handle: SandboxHandle, task: TaskBundle): Promise<AttemptHandle>;
  /** Bounded in time. Never throws on a slow or stuck stop: returns `stop_failed` with the reason. */
  stop(attempt: AttemptHandle): Promise<RuntimeStopAcknowledgement>;
  inspect(handle: SandboxHandle): Promise<RuntimeSnapshot>;
  /** Idempotent: destroying an absent sandbox succeeds. */
  destroy(handle: SandboxHandle): Promise<void>;
}
