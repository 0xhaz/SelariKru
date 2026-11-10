import { RunnerConfigSchema, type RunnerConfig, type RunnerConfigAck } from '@selarikru/domain';

/**
 * The owner's settings for this runner, as the server last sent them, and what this runner has applied. The server gates claims on the saved values from
 * the moment they are saved; this is the runner's side of the acknowledgement. A config is applied as soon as it is read, and the next claim poll or
 * heartbeat says so by sending its revision back. The runner never runs more slots than it was started with.
 */
export class RunnerSettings {
  private config: RunnerConfig | null = null;

  constructor(private readonly launchedSlots: number, private readonly log: (line: string) => void) {}

  /** Applies a config from a claim or heartbeat answer. An older revision, or one this build cannot read, changes nothing. */
  apply(raw: unknown): void {
    const parsed = RunnerConfigSchema.safeParse(raw);
    if (!parsed.success) return;
    const next = parsed.data;
    if (this.config !== null && next.revision <= this.config.revision) return;
    const before = this.config;
    this.config = next;
    const slots = this.activeSlots();
    if (before === null || before.enabled !== next.enabled || before.slots !== next.slots || before.pausedRunIds.join(',') !== next.pausedRunIds.join(',')) {
      // Numbers and run ids from the server only: nothing a worker wrote reaches this line.
      this.log(`config revision ${next.revision}: ${next.enabled ? `${slots} of ${this.launchedSlots} slot(s) claiming` : 'disabled by the owner; finishing current work and claiming nothing'}${next.pausedRunIds.length > 0 ? `; paused: ${next.pausedRunIds.join(', ')}` : ''}`);
    }
  }

  /** How many slots claim work now. Zero once the owner disabled this worker. */
  activeSlots(): number {
    if (this.config === null) return this.launchedSlots;
    if (!this.config.enabled) return 0;
    return Math.min(this.config.slots ?? this.launchedSlots, this.launchedSlots);
  }

  /** What the next request acknowledges. Revision 0 until a config has been read. */
  ack(): RunnerConfigAck {
    return { revision: this.config?.revision ?? 0, slots: this.activeSlots() };
  }

  /**
   * Whether a slot may ask for work. The first slot always polls, even with every slot taken away, because the poll is how this runner hears the next change;
   * the server refuses its claims while it is disabled. A slot already running an attempt finishes it: work in flight keeps the settings it started with.
   */
  mayClaim(slot: number): boolean {
    return slot === 0 || slot < this.activeSlots();
  }
}
