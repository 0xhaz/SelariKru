import type { HarnessLauncher, LaunchedProcess, LaunchSpec } from '@selarikru/harness-claude';
import type { AttemptHandle, RuntimeAdapter, SandboxHandle } from '@selarikru/protocol';

/**
 * Connects the harness adapter to a sandbox. The harness never decides where it runs: this launcher can only start
 * processes inside the one sandbox it was given, and its `stop` goes through the runtime's bounded stop path.
 */
export class RuntimeHarnessLauncher implements HarnessLauncher {
  private attempt: AttemptHandle | null = null;
  constructor(
    private readonly runtime: RuntimeAdapter,
    private readonly sandbox: SandboxHandle,
  ) {}

  get current(): AttemptHandle | null {
    return this.attempt;
  }

  async launch(spec: LaunchSpec): Promise<LaunchedProcess> {
    const a = await this.runtime.start(this.sandbox, { attemptId: spec.attemptId, command: spec.command, cwd: spec.cwd });
    this.attempt = a;
    return { lines: a.output, stdin: a.stdin, kill: a.killClient, exited: a.exited };
  }

  async stop(_attemptId: string): Promise<{ accepted: boolean; detail: string | null }> {
    if (!this.attempt) return { accepted: false, detail: 'nothing is running' };
    const ack = await this.runtime.stop(this.attempt);
    // If the agent could not be confirmed stopped, at least release the host side so the output loop ends. The caller
    // treats an unconfirmed stop as untrusted and fails the attempt.
    if (!ack.terminationConfirmed) this.attempt.killClient();
    return { accepted: ack.status === 'stopped', detail: ack.detail };
  }
}
