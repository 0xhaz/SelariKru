import { createStore, type StoreApi } from 'zustand/vanilla';
import { startProjection, type AuthorizedTerminalRequest, type TerminalChannel, type TerminalControlChannel, type AuthorizedViewCommand, type Clock, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type ProjectionSession, type ProjectionState, type RunFailuresView, type SessionStatus, type AttemptContextView, type BrainAction, type BrainSourceRevisionView, type BrainView, type StackActionRequestView, type StackView, type AttemptSkillsView, type SkillActionView, type SkillsView, type ProductAction, type ProductActionResult, type ProductView, type HandoverAction, type HandoverDiffView, type HandoversView } from '@selarikru/view-protocol';

/** Repeats `fn` every `ms` and returns the cancel function. Live uses timers; the demo drives it from the virtual clock. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

/**
 * What the shell tells the operator about the data under it. `connecting`: a first snapshot is on its way. `unavailable`: there is no source,
 * or no snapshot has ever loaded, so there is nothing to show. `reconnecting`: last confirmed state, retrying. `dead`: frozen; needs a restart.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'unavailable' | 'dead';

export interface ProjectionStoreState {
  readonly projection: ProjectionState | null;
  readonly status: SessionStatus;
  /** True once this session has delivered state. A restart clears it, so the old projection reads as last-confirmed until a fresh one lands. */
  readonly loaded: boolean;
  readonly hasSource: boolean;
  readonly error: DataSourceError | null;
  readonly livenessAsOfMs: number | null;
  readonly nowMs: number;
  /** Liveness to pass to `effectiveWorkerHealth`: null unless the session is live, so workers cannot look healthy over frozen state. */
  livenessForHealth(): number | null;
  start(): void;
  stop(): void;
  restart(): void;
  /** Sends a command. It refuses to send while the session is not live, so a stale screen can never decide anything. */
  execute(command: AuthorizedViewCommand): Promise<CommandReceipt>;
  /** Pulls the facts events do not carry now, rather than at the next scheduled refresh. */
  refresh(): void;
  /** Replaces the projection from a fresh snapshot, after a command was refused. */
  resync(): void;
  /** Why a run's criteria failed, from the current verification record. */
  loadFailures(runId: string): Promise<RunFailuresView>;
  /** Opens a live output channel for one attempt. Read-only; closing it stops the connection. */
  openTerminal(request: AuthorizedTerminalRequest): Promise<TerminalChannel>;
  /** Opens control mode on one attempt. Absent when the source has none. */
  readonly openTerminalControl: ((request: AuthorizedTerminalRequest) => TerminalControlChannel) | undefined;
  /** The Project Brain. Null when the source has none. */
  readonly brain: BrainPort | null;
  /** The project's stack settings. Null when the source has none. */
  readonly stack: StackPort | null;
  /** The project's skill library. Null when the source has none. */
  readonly skills: SkillsPort | null;
  /** The project's product-learning records. Null when the source has none. */
  readonly product: ProductPort | null;
  /** Checkpoint continuation: which running tasks may continue on a cloud runner, and each handover's state. Null when the source has none. */
  readonly handover: HandoverPort | null;
  /** The project this store reads. */
  readonly projectId: string;
  /** What the task agents read: a task's route and context, and the replan path for criteria. Null when the source has no route reads or no context reads. */
  readonly agentSource: AgentSource | null;
}

/** The reads the task agents need from the source. */
export type AgentSource = Pick<EngineeringDataSource, 'planBriefSample' | 'getTaskRoute' | 'getTaskContext' | 'getTaskContextSize' | 'reviseTaskCriteria' | 'acceptPatchProposal' | 'getTaskFiles' | 'listTaskFiles' | 'getProposalState' | 'delegate' | 'assign' | 'acceptPmPlan' | 'saveAiCheckpoint' | 'listAiCheckpoints' | 'claimAiCheckpointEscalation' | 'claimAiCheckpointSend' | 'deleteAiCheckpoint'>;

/** Reads of the handovers, and the owner's two actions. An action refuses to send while the session is not live, as a command does. */
export interface HandoverPort {
  load(): Promise<HandoversView>;
  act(action: HandoverAction): Promise<HandoversView>;
  /** One file's review diff of a checkpoint waiting for the owner. Absent when the source has none. */
  diff?(taskId: string, checkpointId: string, path: string): Promise<HandoverDiffView>;
}

/** Reads and writes of the product-learning records. A write refuses to send while the session is not live, as a command does. */
export interface ProductPort {
  load(): Promise<ProductView>;
  act(action: ProductAction): Promise<ProductActionResult>;
}

/** Reads and writes of the skill library. An action refuses to send while the session is not live, as a command does. */
export interface SkillsPort {
  load(): Promise<SkillsView>;
  act(action: SkillActionView): Promise<SkillsView>;
  attempt(attemptId: string): Promise<AttemptSkillsView>;
}

/** Reads and writes of the stack settings. A write refuses to send while the session is not live, as a command does. */
export interface StackPort {
  load(): Promise<StackView>;
  act(request: StackActionRequestView): Promise<StackView>;
}

/** Reads of the Project Brain, and its two actions. An action refuses to send while the session is not live, as a command does. */
export interface BrainPort {
  load(): Promise<BrainView>;
  source(sourceId: string, revision: number): Promise<BrainSourceRevisionView>;
  context(attemptId: string): Promise<AttemptContextView | null>;
  act(action: BrainAction): Promise<BrainView>;
}

export type ProjectionStore = StoreApi<ProjectionStoreState>;

/** The store refused to send a command because the session is not live. Nothing left the browser, unlike a request that went out and got no answer. */
export class CommandNotSent extends Error {
  constructor() {
    super('the session is not live, so the command was not sent');
    this.name = 'CommandNotSent';
  }
}

export function connectionOf(s: Pick<ProjectionStoreState, 'hasSource' | 'status' | 'loaded' | 'projection'>): ConnectionState {
  if (!s.hasSource) return 'unavailable';
  if (s.status === 'dead') return 'dead';
  if (s.status === 'reconnecting') return s.projection ? 'reconnecting' : 'unavailable';
  if (!s.loaded) return s.projection ? 'reconnecting' : 'connecting';
  return 'live';
}

const NOW_TICK_MS = 1000;

/**
 * The single projection store that every monitoring view reads (design section 12). It owns one `startProjection` session at a time; the
 * source is injected, and is null when no live source exists yet, which is an honest unavailable state and never mock data.
 */
export function createProjectionStore(options: { source: EngineeringDataSource | null; projectId: string; clock: Clock; every: Scheduler }): ProjectionStore {
  const { source, projectId, clock, every } = options;
  let session: ProjectionSession | null = null;
  let cancelTick: (() => void) | null = null;

  return createStore<ProjectionStoreState>()((set, get) => {
    function open(): void {
      if (!source) return;
      const mine: { current: ProjectionSession | null } = { current: null };
      set({ loaded: false, status: 'live', error: null });
      const guard = (fn: () => void): void => {
        // Callbacks can fire while `startProjection` is still returning; only a replaced session is ignored.
        if (mine.current === null || session === mine.current) fn();
      };
      mine.current = startProjection(source, projectId, {
        onState: (projection) => guard(() => set({ projection, loaded: true, error: null, livenessAsOfMs: mine.current?.livenessAsOfMs() ?? get().livenessAsOfMs, nowMs: clock.nowMs() })),
        onError: (error) => guard(() => set({ error })),
        onStatus: (status) => guard(() => set({ status })),
      }, { every, clock });
      session = mine.current;
      set({ status: session.status() });
    }

    function close(): void {
      session?.stop();
      session = null;
    }

    return {
      projection: null, status: 'live', loaded: false, hasSource: source !== null, error: null, livenessAsOfMs: null, nowMs: clock.nowMs(),
      livenessForHealth() {
        return connectionOf(get()) === 'live' ? get().livenessAsOfMs : null;
      },
      start() {
        if (!source || session) return;
        open();
        // A restarted session has no time of its own yet: keep the last confirmed one, so a labelled loss does not vanish while retries fail.
        cancelTick = every(() => set({ nowMs: clock.nowMs(), livenessAsOfMs: session?.livenessAsOfMs() ?? get().livenessAsOfMs }), NOW_TICK_MS);
      },
      stop() {
        close();
        cancelTick?.();
        cancelTick = null;
      },
      /** A dead session cannot revive: stop it and start a new projection. Last state stays on screen, marked as last-confirmed, until the new one lands. */
      restart() {
        close();
        open();
      },
      async execute(command) {
        if (!source || connectionOf(get()) !== 'live') throw new CommandNotSent();
        return source.execute(command);
      },
      refresh() {
        void session?.refresh();
      },
      resync() {
        void session?.resync();
      },
      async loadFailures(runId) {
        if (!source) throw new CommandNotSent();
        return source.getRunFailures(projectId, runId);
      },
      async openTerminal(request) {
        if (!source) throw new CommandNotSent();
        return source.openTerminal(request);
      },
      openTerminalControl: source?.openTerminalControl ? (request) => source.openTerminalControl!(request) : undefined,
      brain: source?.getBrain && source.getBrainSource && source.getAttemptContext && source.brainAction ? {
        load: () => source.getBrain!(projectId),
        source: (sourceId, revision) => source.getBrainSource!(projectId, sourceId, revision),
        context: (attemptId) => source.getAttemptContext!(projectId, attemptId),
        act: async (action) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.brainAction!(projectId, action);
        },
      } : null,
      skills: source?.getSkills && source.skillAction && source.getAttemptSkills ? {
        load: () => source.getSkills!(projectId),
        attempt: (attemptId) => source.getAttemptSkills!(projectId, attemptId),
        act: async (action) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.skillAction!(projectId, action);
        },
      } : null,
      product: source?.getProduct && source.productAction ? {
        load: () => source.getProduct!(projectId),
        act: async (action) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.productAction!(projectId, action);
        },
      } : null,
      handover: source?.getHandovers && source.handoverAction ? {
        load: () => source.getHandovers!(projectId),
        ...(source.getHandoverDiff ? { diff: (taskId: string, checkpointId: string, path: string) => source.getHandoverDiff!(projectId, taskId, checkpointId, path) } : {}),
        act: async (action) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.handoverAction!(projectId, action);
        },
      } : null,
      projectId,
      agentSource: source?.getTaskRoute && source.getTaskContext ? {
        getTaskRoute: source.getTaskRoute.bind(source),
        getTaskContext: source.getTaskContext.bind(source),
        ...(source.planBriefSample ? { planBriefSample: source.planBriefSample.bind(source) } : {}),
        ...(source.reviseTaskCriteria ? { reviseTaskCriteria: source.reviseTaskCriteria.bind(source) } : {}),
        ...(source.getTaskContextSize ? { getTaskContextSize: source.getTaskContextSize.bind(source) } : {}),
        // H5: the accept path for a checked patch, and the task's base files for the patch agent. An accept refuses to send while the session is not live, as a command does.
        ...(source.acceptPatchProposal ? { acceptPatchProposal: async (p: string, proposal: Parameters<NonNullable<EngineeringDataSource['acceptPatchProposal']>>[1], key: string) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.acceptPatchProposal!(p, proposal, key);
        } } : {}),
        // H12: AI step checkpoints. Not gated on a live session: a checkpoint is what keeps a step while the connection is down.
        ...(source.saveAiCheckpoint ? { saveAiCheckpoint: source.saveAiCheckpoint.bind(source) } : {}),
        ...(source.listAiCheckpoints ? { listAiCheckpoints: source.listAiCheckpoints.bind(source) } : {}),
        ...(source.claimAiCheckpointEscalation ? { claimAiCheckpointEscalation: source.claimAiCheckpointEscalation.bind(source) } : {}),
        ...(source.claimAiCheckpointSend ? { claimAiCheckpointSend: source.claimAiCheckpointSend.bind(source) } : {}),
        ...(source.deleteAiCheckpoint ? { deleteAiCheckpoint: source.deleteAiCheckpoint.bind(source) } : {}),
        ...(source.getTaskFiles ? { getTaskFiles: source.getTaskFiles.bind(source) } : {}),
        ...(source.listTaskFiles ? { listTaskFiles: source.listTaskFiles.bind(source) } : {}),
        ...(source.getProposalState ? { getProposalState: source.getProposalState.bind(source) } : {}),
        // H11: the PM's delegation, sent only while the session is live, as a command is.
        ...(source.delegate ? { delegate: async (p: string, runId: string, request: Parameters<NonNullable<EngineeringDataSource['delegate']>>[2]) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.delegate!(p, runId, request);
        } } : {}),
        // H11 fix round 1: the owner's own assignment (Action items) and accepting a PM plan, sent only while live.
        ...(source.assign ? { assign: async (p: string, runId: string, request: Parameters<NonNullable<EngineeringDataSource['assign']>>[2]) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.assign!(p, runId, request);
        } } : {}),
        ...(source.acceptPmPlan ? { acceptPmPlan: async (p: string, runId: string, request: Parameters<NonNullable<EngineeringDataSource['acceptPmPlan']>>[2]) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.acceptPmPlan!(p, runId, request);
        } } : {}),
      } : null,
      stack: source?.getStack && source.stackAction ? {
        load: () => source.getStack!(projectId),
        act: async (request) => {
          if (connectionOf(get()) !== 'live') throw new CommandNotSent();
          return source.stackAction!(projectId, request);
        },
      } : null,
    };
  });
}
