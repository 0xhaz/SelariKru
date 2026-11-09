// Test harness: mounts the assistant with a fake adapter and fake API chosen by `window.__scenario`
// (set by Playwright before load). Served by the dev server only; not a production build input.
import { StrictMode, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { RestrictedDraftHold, type AssistRequest, type AssistantProposal, type Readiness } from '@selarikru/inference-firebase-web';
import { AssistantPanel, createApiClient, useAssistantStore, type ApiResult, type AssistantApi, type AssistantPort } from '../../src/features/assistant/index.ts';
import { AppShell } from '../../src/shell/AppShell.tsx';
import { createProjectionStore, type ProjectionStore } from '../../src/shell/projection-store.ts';
import { loadDemoSession } from '../../src/data-source/demo.ts';
import { createLiveDataSource } from '@selarikru/data-source-live';
import type { EngineeringDataSource, TerminalState } from '@selarikru/view-protocol';
import '../../src/index.css';

type Op = 'draftBrief' | 'suggestCriteria' | 'draftTaskPlan';

interface Scenario {
  device?: Readiness['device'];
  downloadProgress?: number[];
  holdDownload?: boolean;
  holdGenerate?: boolean;
  /** Overrides applied to the proposal the fake adapter returns. */
  proposal?: Partial<Record<keyof AssistantProposal, unknown>>;
  /** Replaces the generated `data`. */
  data?: unknown;
  review?: ApiResult<any>[];
  planRevision?: ApiResult<any>;
  planRevisions?: ApiResult<any>[];
  noApi?: boolean;
  report?: ApiResult<any>;
  realApi?: { baseUrl: string; token: string };
  /** Mount inside the app shell with no projection source, as a production build runs today. */
  shell?: boolean;
  /** Makes the assistant route fail, to exercise the route's error boundary. */
  assistantFails?: 'render' | 'chunk';
  /** Replaces the spied source's terminal with a scripted channel: its lines arrive first, then its state. */
  terminal?: { status: TerminalState['status']; reason?: TerminalState['reason']; lastLineAt?: string | null; dropped?: number; simulated?: boolean; lines?: string[] };
  /** Mount the shell on the mock source with its command methods wrapped in spies, recording to `window.__calls.commands`. */
  spiedFixture?: string;
  /** Overrides `dependsOn` by task id in that fixture's snapshots, to show unknown dependencies and cycles. */
  dependsOn?: Record<string, string[] | null>;
  /** Field overrides by task id in that fixture's snapshots, for states fixtures do not reach, such as a superseded dependency. */
  taskPatch?: Record<string, Record<string, unknown>>;
  /** Simulates a transport fault on the spied source, e.g. 'reconnecting'. */
  fault?: 'reconnecting' | 'dead';
  /** Refuses commands with this rejection, to exercise a server refusal. */
  rejectWith?: string;
  /** A command that never answers, to show the busy state. */
  holdExecute?: boolean;
  /** Mounts the shell on the real live data source against a test server, recording every delivered sequence to `window.__calls.sequences`. */
  liveApi?: { baseUrl: string; token: string; projectId: string };
  /** Failure loads on the spied source are refused until the test calls `window.__allowFailureLoads`, to exercise retrying. */
  refuseFailureLoads?: boolean;
  /** Reports the fixture as observed live data, so real links are shown. */
  observed?: boolean;
}

declare global {
  interface Window {
    __scenario?: Scenario;
    __calls: { adapter: unknown[]; api: unknown[]; commands: unknown[]; sequences: number[] };
    __spiedSource?: EngineeringDataSource;
    __allowFailureLoads?: () => void;
    __releaseDownload?: () => void;
    __releaseGenerate?: () => void;
    __store: typeof useAssistantStore;
    __projection?: ProjectionStore;
    __hold: RestrictedDraftHold;
  }
}

const sc: Scenario = window.__scenario ?? {};
window.__calls = { adapter: [], api: [], commands: [], sequences: [] };
let device: Readiness['device'] = sc.device ?? 'available';

const gate = (): { p: Promise<void>; release: () => void } => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

function dataFor(op: Op, ids: readonly string[]): unknown {
  if (op === 'draftTaskPlan') return { tasks: ids.map((id) => ({ title: `Build ${id}`, description: `Implement ${id}`, requirementIds: [id] })) };
  const criteria = ids.map((id) => ({ requirementId: id, text: `Criterion for ${id}` }));
  return op === 'draftBrief' ? { summary: 'A concise summary', acceptanceCriteria: criteria } : { acceptanceCriteria: criteria };
}

async function run(op: Op, req: AssistRequest): Promise<AssistantProposal> {
  window.__calls.adapter.push({ kind: op, projectId: req.projectId, sources: req.sources, mode: req.policy?.preferredMode ?? null, taskTextLength: req.taskText.length });
  if (sc.holdGenerate) {
    const g = gate();
    window.__releaseGenerate = g.release;
    await g.p;
  }
  const requestedMode = req.sources.some((s) => s.classification === 'restricted') ? 'ONLY_ON_DEVICE' : (req.policy?.preferredMode ?? null);
  const base: AssistantProposal = {
    trust: 'untrusted_proposal',
    status: 'ok',
    operation: op,
    data: sc.data ?? dataFor(op, req.allowedRequirementIds),
    requestId: 'req-test-1',
    requestedMode,
    observedSource: 'ON_DEVICE',
    rawInferenceSource: 'on_device',
    model: { cloudModel: 'gemini-3.5-flash-lite', sdkVersion: '13.1.0' },
    timing: { totalMs: 1234, firstOutputMs: null },
    usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    validation: { status: 'passed', errors: [] },
    payloadSha256: 'a'.repeat(64),
    allowedRequirementIds: [...req.allowedRequirementIds],
    blockedReason: null,
    errorName: null,
    errorCode: null,
  };
  const merged = { ...base, ...(sc.proposal ?? {}) } as AssistantProposal;
  if (merged.status !== 'ok') return { ...merged, data: null };
  return merged;
}

const adapter: AssistantPort = {
  draftBrief: (r) => run('draftBrief', r),
  suggestCriteria: (r) => run('suggestCriteria', r),
  draftTaskPlan: (r) => run('draftTaskPlan', r),
  async getReadiness() {
    return { device, cloudModel: 'gemini-3.5-flash-lite', sdkVersion: '13.1.0' };
  },
  async downloadModel(onProgress) {
    window.__calls.adapter.push({ kind: 'download' });
    device = 'downloading';
    for (const f of sc.downloadProgress ?? [1]) onProgress(f);
    if (sc.holdDownload) {
      const g = gate();
      window.__releaseDownload = g.release;
      await g.p;
    }
    device = 'available';
  },
};

const record = (kind: string, body: unknown) => window.__calls.api.push({ kind, body: JSON.parse(JSON.stringify(body)) });
const reviewQueue = [...(sc.review ?? [])];
const fakeApi: AssistantApi = {
  async reviewProposal(a) {
    record('review', a);
    const next = reviewQueue.shift();
    if (next) return next;
    const data = a.envelope.data as { tasks?: { title: string; requirementIds: string[] }[] };
    return {
      ok: true,
      value: {
        expectedRevision: 3,
        needsReview: false,
        droppedFields: ['description'],
        issues: [],
        tasks: (data.tasks ?? []).map((t, i) => ({ taskId: `prop-${i + 1}`, title: t.title, requirementIds: t.requirementIds, revision: 1, classification: 'internal' })),
      },
    };
  },
  async createPlanRevision(a) {
    record('plan-revision', a);
    const q = sc.planRevisions?.shift();
    if (q) return q;
    return sc.planRevision ?? { ok: true, value: { planRevision: a.expectedRevision + 1, taskIds: a.tasks.map((t) => t.taskId) } };
  },
  async postClientReport(a) {
    record('client-report', a);
    return sc.report ?? { ok: true, value: { reportId: 'rpt-1' } };
  },
};

const api: AssistantApi = sc.realApi ? createApiClient({ baseUrl: sc.realApi.baseUrl, getToken: async () => sc.realApi!.token }) : fakeApi;

const hold = new RestrictedDraftHold();
window.__store = useAssistantStore;
window.__hold = hold;

function Boom(): never {
  throw new Error('render failed');
}
const ChunkFail = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
const panel = sc.assistantFails === 'render' ? <Boom /> : sc.assistantFails === 'chunk' ? <ChunkFail /> : <AssistantPanel adapter={adapter} api={sc.noApi ? null : api} hold={hold} defaults={{ projectId: 'proj-1', runId: 'run-1' }} />;
const store = createProjectionStore({ source: null, projectId: 'proj-1', clock: { nowMs: () => Date.now() }, every: () => () => {} });

/** The demo source with `execute` and `openTerminal` spied. Everything else passes through. */
async function spiedShell(fixtureId: string): Promise<{ store: ProjectionStore; label: string }> {
  const session = (await loadDemoSession(sc.fault ?? null))!;
  let refuseFailureLoads = sc.refuseFailureLoads === true;
  window.__allowFailureLoads = () => { refuseFailureLoads = false; };
  const project = session.projects.find((p) => p.fixtureId === fixtureId) ?? session.projects[0]!;
  const source: EngineeringDataSource = {
    ...session.source,
    getSnapshot: async (projectId) => {
      const loaded = await session.source.getSnapshot(projectId);
      const base = sc.observed ? { ...loaded, meta: { ...loaded.meta, provenance: 'observed' as const } } : loaded;
      if (!sc.dependsOn && !sc.taskPatch) return base;
      const patched = (id: string, t: (typeof base.tasks)[string]): (typeof base.tasks)[string] => ({ ...t, ...(sc.dependsOn && id in sc.dependsOn ? { dependsOn: sc.dependsOn[id]! } : {}), ...(sc.taskPatch?.[id] ?? {}) });
      return { ...base, tasks: Object.fromEntries(Object.entries(base.tasks).map(([id, t]) => [id, patched(id, t)])) };
    },
    execute: (command) => {
      window.__calls.commands.push({ method: 'execute', command });
      if (sc.holdExecute) return new Promise(() => {});
      if (sc.rejectWith) return Promise.resolve({ idempotencyKey: command.idempotencyKey, operationId: null, accepted: false, execution: 'rejected', rejection: sc.rejectWith as never, replayed: false, simulated: true });
      return session.source.execute(command);
    },
    getRunFailures: (projectId, runId) => {
      if (refuseFailureLoads) return Promise.reject(new Error('refused by the test'));
      return session.source.getRunFailures(projectId, runId);
    },
    openTerminal: async (request) => {
      window.__calls.commands.push({ method: 'openTerminal', request });
      const script = sc.terminal;
      if (script) {
        let open = true;
        return {
          channelId: 'scripted', simulated: script.simulated ?? false,
          onLine(handler: (line: string) => void) { (window as unknown as { __terminalPush: (l: string) => void }).__terminalPush = handler; queueMicrotask(() => { if (open) for (const line of script.lines ?? []) handler(line); }); return () => {}; },
          onState(handler: (state: TerminalState) => void) { queueMicrotask(() => { if (open) handler({ status: script.status, reason: script.reason ?? null, lastLineAt: script.lastLineAt ?? null, dropped: script.dropped ?? 0 }); }); return () => {}; },
          close() { open = false; window.__calls.commands.push({ method: 'terminalClose' }); },
        };
      }
      const channel = await session.source.openTerminal(request);
      const inner = channel.close.bind(channel);
      return { ...channel, close() { inner(); window.__calls.commands.push({ method: 'terminalClose' }); } };
    },
  };
  window.__spiedSource = source;
  const spied = createProjectionStore({ source, projectId: project.projectId, clock: session.clockFor(project.projectId), every: session.every });
  spied.getState().start();
  window.__projection = spied;
  return { store: spied, label: project.name };
}

const root = createRoot(document.getElementById('root')!);
if (sc.liveApi) {
  const live = sc.liveApi;
  const source = createLiveDataSource({ baseUrl: live.baseUrl, getToken: async () => live.token });
  const recording: EngineeringDataSource = {
    ...source,
    subscribe: (p, after, onEvent, onError) => source.subscribe(p, after, (e) => { window.__calls.sequences.push(e.sequence); onEvent(e); }, onError),
  };
  const shellStore = createProjectionStore({ source: recording, projectId: live.projectId, clock: { nowMs: () => Date.now() }, every: (fn, ms) => { const id = window.setInterval(fn, ms); return () => window.clearInterval(id); } });
  window.__projection = shellStore;
  shellStore.getState().start();
  root.render(<StrictMode><AppShell store={shellStore} mode="live" projectLabel={live.projectId} assistant={null} /></StrictMode>);
} else if (sc.spiedFixture) {
  void spiedShell(sc.spiedFixture).then(({ store: spied, label }) => {
    root.render(
      <StrictMode>
        <AppShell store={spied} mode={sc.observed ? 'live' : 'mock'} projectLabel={label} assistant={null} />
      </StrictMode>,
    );
  });
} else {
  root.render(
    <StrictMode>
      {sc.shell ? <AppShell store={store} mode="live" projectLabel="proj-1" account={{ label: 'owner@example.test', onSignOut: () => {} }} assistant={panel} /> : panel}
    </StrictMode>,
  );
}
