import {
  AuthorizedTerminalRequestSchema, AuthorizedViewCommandSchema, CursorSchema, DataSourceException, ProjectViewEventSchema, REJECTION_REASONS, RunFailuresViewSchema,
  AttemptContextViewSchema, BrainSourceRevisionViewSchema, BrainViewSchema, StackViewSchema,
  type AuthorizedTerminalRequest, type AuthorizedViewCommand, type TerminalControlChannel, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type ProjectViewEvent, type ProjectViewSnapshot, type RejectionReason, type RunFailuresView,
} from '@selarikru/view-protocol';
import { toViewSnapshot, type RawSnapshot } from './snapshot.ts';
import { openLiveControl, type WebSocketFactory } from './control.ts';
import { openLiveTerminal } from './terminal.ts';

/** Marks a 404 that a caller reads as nothing recorded. Never leaves this module. */
const NOT_RECORDED = Symbol('not recorded');

export interface LiveDataSourceOptions {
  readonly baseUrl: string;
  /** Returns a fresh Firebase ID token for the signed-in owner, on every request. */
  readonly getToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** No bytes for this long means the connection is gone, even if the socket never says so. The server sends a keepalive inside this. Default 45 000. */
  readonly streamIdleMs?: number;
  /** Test seam for control mode's WebSocket. */
  readonly makeSocket?: WebSocketFactory;
}

export interface LiveDataSource extends EngineeringDataSource {
  readonly mode: 'live';
  /** Resolves once no request is in flight and every open stream has gone quiet for `quietMs`. Tests use it; the product never waits on it. */
  settled(quietMs?: number): Promise<void>;
}

const DEFAULT_IDLE_MS = 45_000;
const CLOSED: DataSourceError = { code: 'disconnected', message: 'this data source was closed', retryable: false };
const DROPPED: DataSourceError = { code: 'disconnected', message: 'the connection to the server dropped', retryable: true };
const AUTH_CODES: readonly string[] = ['unauthenticated', 'invalid_token', 'not_owner', 'wrong_principal_type', 'origin_not_allowed', 'host_not_allowed'];
const NOT_FOUND_CODES: readonly string[] = ['task_not_found', 'run_not_found', 'approval_not_found', 'not_found', 'project_not_found', 'runner_not_found'];
/** Reasons the route carries in `details.reason` on a 403, and the pull-request route's refusals. */
const DETAIL_REASONS: readonly string[] = ['not_budget_stopped', 'already_accepted', 'nothing_to_reverify', 'reverify_limit_reached', 'resource_conflict', 'run_not_ready', 'reduced_scope_not_accepted', 'run_already_merged', 'candidate_changed', 'no_valid_record', 'record_not_passing', 'no_candidate'];

interface WireError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown> | undefined;
}

async function readWireError(res: Response): Promise<WireError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
  return { status: res.status, code: body?.error?.code ?? 'internal_error', message: body?.error?.message ?? res.statusText, details: body?.error?.details };
}

/** A request the server timed out, throttled or could not serve. Nothing about the request was refused, so it can be tried again. */
const isTransient = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** Status and code as the view's error. A server that is restarting or unreachable is a drop, so it is retryable; only what no retry can fix is not. */
function toDataSourceError(e: WireError): DataSourceError {
  if (e.status === 401 || e.status === 403 || AUTH_CODES.includes(e.code)) return { code: 'unauthorized', message: e.message, retryable: false };
  if (e.code === 'project_not_found') return { code: 'unknown_project', message: e.message, retryable: false };
  if (e.code === 'cursor_ahead') return { code: 'invalid_cursor', message: e.message, retryable: false };
  if (isTransient(e.status)) return { ...DROPPED, message: `the server responded ${e.status}` };
  return { code: 'unavailable', message: e.message, retryable: false };
}

/** Firebase Auth codes a retry can fix. Any other `auth/` code (signed out, expired account, revoked token) needs a person. */
const TRANSIENT_AUTH_CODES: readonly string[] = ['auth/network-request-failed', 'auth/too-many-requests', 'auth/internal-error', 'auth/timeout'];

/** A failed fetch is a drop. A Firebase Auth error is read by its code, never by its wording. */
function fromThrown(e: unknown): DataSourceError {
  if (e instanceof DataSourceException) return e.detail;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('auth/') && !TRANSIENT_AUTH_CODES.includes(code)) return { code: 'unauthorized', message: `the owner's sign-in cannot be used (${code})`, retryable: false };
  return DROPPED;
}

function rejectionOf(e: WireError): RejectionReason {
  if (NOT_FOUND_CODES.includes(e.code)) return 'unknown_target';
  const reason = typeof e.details?.['reason'] === 'string' ? e.details['reason'] : null;
  if (reason !== null && DETAIL_REASONS.includes(reason)) return reason as RejectionReason;
  if (e.code === 'pull_request_not_allowed') return 'pull_request_refused';
  if (e.code === 'invalid_request' || e.code === 'plan_invalid' || e.code === 'idempotency_key_conflict') return 'invalid_command';
  if ((REJECTION_REASONS as readonly string[]).includes(e.code)) return e.code as RejectionReason;
  if (e.code === 'command_not_allowed' || e.code === 'command_not_supported') return 'not_allowed';
  return 'not_allowed';
}

interface Route {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** Each command's route and body. The names and fields are the control API's own; the idempotency key always goes through. */
function routeOf(c: AuthorizedViewCommand): Route {
  const enc = encodeURIComponent;
  const key = { idempotencyKey: c.idempotencyKey };
  switch (c.command) {
    case 'task.cancel': return { path: `/v1/tasks/${enc(c.args.taskId)}/commands`, body: { command: 'cancel', expectedRevision: c.expectedRevision, ...key } };
    case 'task.retry': return { path: `/v1/tasks/${enc(c.args.taskId)}/commands`, body: { command: 'retry', expectedRevision: c.expectedRevision, ...key } };
    case 'approval.grant': return { path: `/v1/approvals/${enc(c.args.approvalId)}/resolve`, body: { decision: 'grant', scopeHash: c.args.scopeHash, expectedRevision: c.expectedRevision, ...key } };
    case 'approval.deny': return { path: `/v1/approvals/${enc(c.args.approvalId)}/resolve`, body: { decision: 'deny', scopeHash: c.args.scopeHash, expectedRevision: c.expectedRevision, ...key } };
    case 'run.accept_reduced_scope': return { path: `/v1/runs/${enc(c.args.runId)}/accept-reduced-scope`, body: { expectedPlanRevision: c.expectedRevision, notDeliveredHash: c.args.notDeliveredHash, ...(c.args.note !== undefined ? { note: c.args.note } : {}), ...key } };
    case 'run.reverify': return { path: `/v1/runs/${enc(c.args.runId)}/reverify`, body: { expectedPlanRevision: c.expectedRevision, ...key } };
    case 'run.open_pull_request': return { path: `/v1/runs/${enc(c.args.runId)}/pull-request`, body: {} };
    // Needs the project's recorded setup first, so `execute` builds this route itself.
    case 'run.start_new': throw new Error('run.start_new is routed by execute');
    case 'assignment.set': return { path: `/v1/projects/${enc(c.args.projectId)}/model-assignments`, body: { scope: c.args.scope, key: c.args.key, selection: c.args.selection, expectedRevision: c.expectedRevision, ...key } };
    case 'setting.set': return { path: `/v1/projects/${enc(c.args.projectId)}/settings`, body: { key: c.args.key, change: c.args.change, expectedRevision: c.expectedRevision, ...key } };
    case 'run.cancel': return { path: `/v1/runs/${enc(c.args.runId)}/cancel`, body: { expectedPlanRevision: c.expectedRevision, ...key } };
  }
}

/** The placement a project's recorded execution choice gets: the same mapping onboarding used for its first run. Local gets none. */
const PLACEMENT_FOR: Readonly<Record<string, string | null>> = { local: null, cloud: 'C1', hybrid: 'H2' };

interface Accepted { readonly operationId: string | null; readonly execution: CommandReceipt['execution'] }

function acceptedOf(c: AuthorizedViewCommand, body: Record<string, unknown>): Accepted {
  const op = (k: string): string | null => (typeof body[k] === 'string' ? (body[k] as string) : null);
  if (c.command === 'task.cancel' || c.command === 'task.retry') return { operationId: op('operationId'), execution: body['state'] === 'cancel_requested' ? 'cancel_requested' : 'applied' };
  if (c.command === 'run.accept_reduced_scope') return { operationId: op('decisionId'), execution: 'applied' };
  if (c.command === 'run.start_new') return { operationId: op('runId'), execution: 'applied' };
  // A saved setting or model is in force only once its enforcer says so: a runner-acknowledged one is pending until then, never applied by the save.
  if (c.command === 'setting.set' || c.command === 'assignment.set') return { operationId: null, execution: body['state'] === 'applied' ? 'applied' : 'pending' };
  if (c.command === 'run.cancel') return { operationId: op('operationId'), execution: body['state'] === 'applied' ? 'applied' : 'cancel_requested' };
  return { operationId: null, execution: 'applied' };
}

/**
 * The live source: every call goes to the control API with the owner's ID token, and every answer is validated against the view schema. The token lives only in the request
 * headers, the event stream is read with fetch so no credential ever reaches a URL, and a failed stream tells its caller exactly once. It imports no mock.
 */
export function createLiveDataSource(options: LiveDataSourceOptions): LiveDataSource {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const idleMs = options.streamIdleMs ?? DEFAULT_IDLE_MS;
  const streams = new Set<() => void>();
  // The attempts the last snapshots named, and the project of each: a terminal request carries only the attempt and task, and the path is project-scoped.
  const attemptOwners = new Map<string, { readonly taskId: string; readonly projectId: string }>();
  // Keys this source has seen accepted. The server replays by key and does not say it did, so a second acceptance of the same key here is a replay.
  const acceptedKeys = new Set<string>();
  let closed = false;
  let inFlight = 0;
  let lastFrameAt = 0;
  let opening = 0;

  const fail = (detail: DataSourceError): DataSourceException => new DataSourceException(detail);
  const assertOpen = (): void => {
    if (closed) throw fail(CLOSED);
  };
  const track = async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
    }
  };

  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    track(async () => {
      const token = await options.getToken();
      return doFetch(`${base}${path}`, { ...init, cache: 'no-store', headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
    });

  /** A GET (or, with a body, a POST) read through a schema. `missingIsNull`: a 404 rejects with `NOT_RECORDED` for the caller to turn into null. */
  async function readJson<T>(path: string, parser: { parse(v: unknown): T }, what: string, missingIsNull = false, body?: unknown): Promise<T> {
    assertOpen();
    let res: Response;
    try {
      res = await request(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw fail(fromThrown(e));
    }
    if (missingIsNull && res.status === 404) throw NOT_RECORDED;
    if (!res.ok) throw fail(toDataSourceError(await readWireError(res)));
    try {
      return parser.parse(await res.json());
    } catch {
      throw fail({ code: 'invalid_event', message: `the server sent ${what} this build cannot read`, retryable: false });
    }
  }

  return {
    mode: 'live',

    async getSnapshot(projectId) {
      assertOpen();
      let res: Response;
      try {
        res = await request(`/v1/projects/${encodeURIComponent(projectId)}/snapshot`);
      } catch (e) {
        throw fail(fromThrown(e));
      }
      if (!res.ok) throw fail(toDataSourceError(await readWireError(res)));
      let snapshot: ProjectViewSnapshot;
      try {
        snapshot = toViewSnapshot((await res.json()) as RawSnapshot);
      } catch (e) {
        throw fail({ code: 'invalid_event', message: `the server sent a snapshot this build cannot read: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`, retryable: false });
      }
      for (const a of Object.values(snapshot.attempts)) attemptOwners.set(a.attemptId, { taskId: a.taskId, projectId });
      return snapshot;
    },

    async getRunFailures(projectId, runId): Promise<RunFailuresView> {
      assertOpen();
      let res: Response;
      try {
        res = await request(`/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/failures`);
      } catch (e) {
        throw fail(fromThrown(e));
      }
      if (!res.ok) throw fail(toDataSourceError(await readWireError(res)));
      try {
        return RunFailuresViewSchema.parse(await res.json());
      } catch {
        throw fail({ code: 'invalid_event', message: 'the server sent failure details this build cannot read', retryable: false });
      }
    },

    getBrain: (projectId) => readJson(`/v1/projects/${encodeURIComponent(projectId)}/brain`, BrainViewSchema, 'the Project Brain'),
    getBrainSource: (projectId, sourceId, revision) =>
      readJson(`/v1/projects/${encodeURIComponent(projectId)}/brain/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(String(revision))}`, BrainSourceRevisionViewSchema, 'a source revision'),
    async getAttemptContext(projectId, attemptId) {
      try {
        return await readJson(`/v1/projects/${encodeURIComponent(projectId)}/attempts/${encodeURIComponent(attemptId)}/context`, AttemptContextViewSchema, 'a context bundle', true);
      } catch (e) {
        if (e === NOT_RECORDED) return null;
        throw e;
      }
    },
    brainAction(projectId, action) {
      const base = `/v1/projects/${encodeURIComponent(projectId)}/brain`;
      return action.kind === 'revoke'
        ? readJson(`${base}/sources/${encodeURIComponent(action.sourceId)}/revoke`, BrainViewSchema, 'the Project Brain', false, { reason: action.reason })
        : readJson(`${base}/conflicts/${encodeURIComponent(action.conflictId)}/keep`, BrainViewSchema, 'the Project Brain', false, {});
    },

    getStack: (projectId) => readJson(`/v1/projects/${encodeURIComponent(projectId)}/stack`, StackViewSchema, 'the stack settings'),
    stackAction: (projectId, req) => readJson(`/v1/projects/${encodeURIComponent(projectId)}/stack`, StackViewSchema, 'the stack settings', false, { expectedRevision: req.expectedRevision, action: req.action }),

    subscribe(projectId, afterCursor, onEvent, onError) {
      if (closed) {
        queueMicrotask(() => onError(CLOSED));
        return () => {};
      }
      if (!CursorSchema.safeParse(afterCursor).success) {
        queueMicrotask(() => onError({ code: 'invalid_cursor', message: 'the cursor is not a position in the event stream', retryable: false }));
        return () => {};
      }
      const abort = new AbortController();
      let active = true;
      let last = Number(afterCursor);
      let idle: ReturnType<typeof setTimeout> | undefined;
      /** The single exit of a stream: `error` is null when the caller unsubscribed, and tells it otherwise, once. */
      const end = (error: DataSourceError | null): void => {
        if (!active) return;
        active = false;
        streams.delete(stop);
        if (idle !== undefined) clearTimeout(idle);
        abort.abort();
        if (error) onError(error);
      };
      const stop = (): void => end(null);
      streams.add(stop);
      const watchdog = (): void => {
        if (idle !== undefined) clearTimeout(idle);
        idle = setTimeout(() => end(DROPPED), idleMs);
      };

      const deliver = (data: string): void => {
        let event: ProjectViewEvent;
        try {
          event = ProjectViewEventSchema.parse({ ...(JSON.parse(data) as object), provenance: 'observed' });
        } catch {
          end({ code: 'invalid_event', message: 'the event stream sent a record this build cannot read', retryable: false });
          return;
        }
        // A replay can start at or before what was already handed over: nothing is delivered twice.
        if (event.sequence <= last) return;
        last = event.sequence;
        onEvent(event);
      };

      const read = async (): Promise<void> => {
        let res: Response;
        opening += 1;
        let opened = false;
        const markOpened = (): void => {
          if (!opened) opening -= 1;
          opened = true;
        };
        try {
          res = await request(`/v1/projects/${encodeURIComponent(projectId)}/events?after=${afterCursor}`, { signal: abort.signal, headers: { accept: 'text/event-stream' } });
        } catch (e) {
          markOpened();
          end(fromThrown(e));
          return;
        }
        if (!active) {
          markOpened();
          void res.body?.cancel();
          return;
        }
        if (!res.ok || !res.body) {
          markOpened();
          end(res.ok ? DROPPED : toDataSourceError(await readWireError(res)));
          return;
        }
        watchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            markOpened();
            if (!active) return;
            if (done) break;
            watchdog();
            lastFrameAt = Date.now();
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
            for (let i = buffer.indexOf('\n\n'); i >= 0 && active; i = buffer.indexOf('\n\n')) {
              const frame = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data !== '') deliver(data);
            }
          }
        } catch {
          markOpened();
          if (active) end(DROPPED);
          return;
        }
        // The server closed the stream (a restart, a deploy). Nothing here is fatal: the session reconnects.
        end(DROPPED);
      };
      void read();
      return stop;
    },

    async execute(command) {
      const parsed = AuthorizedViewCommandSchema.safeParse(command);
      const key = (command as { idempotencyKey?: unknown } | null)?.idempotencyKey;
      const refuse = (idempotencyKey: string, rejection: RejectionReason): CommandReceipt => ({ idempotencyKey, operationId: null, accepted: false, execution: 'rejected', rejection, replayed: false, simulated: false });
      if (!parsed.success) return refuse(typeof key === 'string' ? key : 'invalid', 'invalid_command');
      assertOpen();
      const c = parsed.data;
      let route: Route;
      try {
        if (c.command === 'run.start_new') {
          // The ceiling and the location are the owner's recorded setup. Read here, and sent as the run's own limits; the route checks them again.
          const setup = await request(`/v1/onboarding/${encodeURIComponent(c.args.projectId)}`);
          type Setup = { costPlan?: { agentBudgetUsd?: unknown } | null; execution?: { execution?: unknown } | null } | null;
          let view = null as Setup;
          if (setup.ok) view = (await setup.json().catch(() => null)) as Setup;
          else {
            const wire = await readWireError(setup);
            if (setup.status === 401 || isTransient(setup.status) || AUTH_CODES.includes(wire.code)) throw fail(toDataSourceError(wire));
          }
          const ceiling = view?.costPlan?.agentBudgetUsd;
          const execution = view?.execution?.execution;
          // No recorded ceiling or location is a refusal here, not a guess: a missing limit is never unlimited.
          if (typeof ceiling !== 'number' || typeof execution !== 'string' || !Object.hasOwn(PLACEMENT_FOR, execution)) return refuse(c.idempotencyKey, 'outside_recorded_limits');
          const mode = PLACEMENT_FOR[execution];
          route = { path: `/v1/projects/${encodeURIComponent(c.args.projectId)}/runs`, body: { idempotencyKey: c.idempotencyKey, title: c.args.title, budgetLimitUsd: ceiling, ...(mode ? { placement: { mode } } : {}) } };
        } else {
          route = routeOf(c);
        }
      } catch (e) {
        throw e instanceof DataSourceException ? e : fail(fromThrown(e));
      }
      let res: Response;
      try {
        res = await request(route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) });
      } catch (e) {
        throw fail(fromThrown(e));
      }
      if (!res.ok) {
        const wire = await readWireError(res);
        // No retry changes a refusal. A login problem or an unreachable server is not a refusal: the caller must not read it as one.
        if (res.status === 401 || isTransient(res.status) || AUTH_CODES.includes(wire.code)) throw fail(toDataSourceError(wire));
        return refuse(c.idempotencyKey, rejectionOf(wire));
      }
      const accepted = acceptedOf(c, ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {});
      const replayed = acceptedKeys.has(c.idempotencyKey);
      acceptedKeys.add(c.idempotencyKey);
      return { idempotencyKey: c.idempotencyKey, operationId: accepted.operationId, accepted: true, execution: accepted.execution, rejection: null, replayed, simulated: false };
    },

    /** Authenticated exactly like every other call: the owner's token goes in the header, and never in the URL. */
    async openTerminal(session: AuthorizedTerminalRequest) {
      const req = AuthorizedTerminalRequestSchema.safeParse(session);
      if (!req.success) throw fail({ code: 'unauthorized', message: 'invalid terminal request', retryable: false });
      assertOpen();
      const owner = attemptOwners.get(req.data.attemptId);
      if (owner?.taskId !== req.data.taskId) throw fail({ code: 'unknown_project', message: 'no such attempt', retryable: false });
      const channel = openLiveTerminal({
        channelId: `term_${req.data.attemptId}`,
        path: `/v1/projects/${encodeURIComponent(owner.projectId)}/attempts/${encodeURIComponent(req.data.attemptId)}/terminal`,
        request,
        idleMs,
        onClose: (close) => streams.delete(close),
      });
      streams.add(channel.closeNow);
      return channel;
    },

    openTerminalControl(session: AuthorizedTerminalRequest): TerminalControlChannel {
      const owner = attemptOwners.get(session.attemptId);
      if (!owner || owner.taskId !== session.taskId) {
        const refused: TerminalControlChannel = { simulated: false, onState: (h) => { queueMicrotask(() => h({ phase: 'refused', reason: 'attempt_not_running', echo: null })); return () => undefined; }, onInput: () => () => undefined, send: () => undefined, interrupt: () => undefined, close: () => undefined };
        return refused;
      }
      const channel = openLiveControl({ baseUrl: options.baseUrl, request: { ...session, projectId: owner.projectId }, fetchAuthed: request, makeSocket: options.makeSocket ?? ((url) => new WebSocket(url)) });
      const close = (): void => channel.close();
      streams.add(close);
      return { ...channel, close: () => { streams.delete(close); channel.close(); } };
    },

    disconnect() {
      closed = true;
      for (const stop of [...streams]) stop();
    },

    async settled(quietMs = 80) {
      const asked = Date.now();
      for (let i = 0; i < 400; i += 1) {
        // Quiet is measured from the later of the call and the last byte: the server polls, so an event committed just now may not have reached the wire yet.
        if (inFlight === 0 && opening === 0 && Date.now() - Math.max(lastFrameAt, asked) >= quietMs) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('the live data source did not go quiet');
    },
  };
}
