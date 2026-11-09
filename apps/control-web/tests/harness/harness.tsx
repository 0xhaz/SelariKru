// Test harness: mounts the assistant with a fake adapter and fake API chosen by `window.__scenario`
// (set by Playwright before load). Served by the dev server only; not a production build input.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RestrictedDraftHold, type AssistRequest, type AssistantProposal, type Readiness } from '@selarikru/inference-firebase-web';
import { AssistantPanel, createApiClient, useAssistantStore, type ApiResult, type AssistantApi, type AssistantPort } from '../../src/features/assistant/index.ts';
import { AppShell } from '../../src/shell/AppShell.tsx';
import { createProjectionStore } from '../../src/shell/projection-store.ts';
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
}

declare global {
  interface Window {
    __scenario?: Scenario;
    __calls: { adapter: unknown[]; api: unknown[] };
    __releaseDownload?: () => void;
    __releaseGenerate?: () => void;
    __store: typeof useAssistantStore;
    __hold: RestrictedDraftHold;
  }
}

const sc: Scenario = window.__scenario ?? {};
window.__calls = { adapter: [], api: [] };
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

const panel = <AssistantPanel adapter={adapter} api={sc.noApi ? null : api} hold={hold} defaults={{ projectId: 'proj-1', runId: 'run-1' }} />;
const store = createProjectionStore({ source: null, projectId: 'proj-1', clock: { nowMs: () => Date.now() }, every: () => () => {} });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {sc.shell ? <AppShell store={store} mode="live" projectLabel="proj-1" account={{ label: 'owner@example.test', onSignOut: () => {} }} assistant={panel} /> : panel}
  </StrictMode>,
);
