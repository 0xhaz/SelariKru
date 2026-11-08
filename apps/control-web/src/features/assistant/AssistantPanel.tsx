import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistRequest, AssistantProposal, RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { validateProposal, type ProposalValidation } from '@selarikru/domain';
import { demoProposal } from './demo.ts';
import { briefById } from './fixtures.ts';
import { HandoffPanel } from './HandoffPanel.tsx';
import { InferenceIndicator } from './InferenceIndicator.tsx';
import { ModelCard } from './ModelCard.tsx';
import { OutputView } from './OutputView.tsx';
import { buildPolicy } from './policy.ts';
import { RequestForm, type Target } from './RequestForm.tsx';
import { useAssistantStore, type ResultMeta } from './store.ts';
import type { AssistantApi, AssistantPort } from './types.ts';
import { Chip } from './ui.tsx';

export interface AssistantPanelProps {
  readonly adapter: AssistantPort;
  readonly api: AssistantApi;
  readonly hold: RestrictedDraftHold;
  readonly defaults?: { readonly projectId: string; readonly runId: string };
}

const ERROR_PROPOSAL = (op: AssistantProposal['operation'], ids: readonly string[], name: string): AssistantProposal => ({
  trust: 'untrusted_proposal', status: 'error', operation: op, data: null, requestId: 'none', requestedMode: null, observedSource: 'UNKNOWN',
  rawInferenceSource: null, model: { cloudModel: '', sdkVersion: '' }, timing: { totalMs: 0, firstOutputMs: null },
  usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null }, validation: { status: 'not_run', errors: [] },
  payloadSha256: null, allowedRequirementIds: [...ids], blockedReason: null, errorName: name,
});

export function AssistantPanel({ adapter, api, hold, defaults }: AssistantPanelProps) {
  const store = useAssistantStore();
  const { mode, operation, briefId, cloudPermitted, demo, result, set, setResult, setGenerating, setDownload, setReadiness } = store;
  const [target, setTarget] = useState<Target>({ projectId: defaults?.projectId ?? '', runId: defaults?.runId ?? '' });
  const [announce, setAnnounce] = useState('');
  const brief = briefById(briefId);
  const heldRef = useRef<string | null>(null);

  const refreshReadiness = useCallback(async () => {
    try {
      setReadiness(await adapter.getReadiness());
    } catch {
      setReadiness({ device: 'unknown', cloudModel: '', sdkVersion: '' });
    }
  }, [adapter, setReadiness]);

  useEffect(() => {
    void refreshReadiness();
    return () => {
      if (heldRef.current) hold.discard(heldRef.current);
    };
  }, [refreshReadiness, hold]);

  const discard = useCallback(() => {
    if (heldRef.current) hold.discard(heldRef.current);
    heldRef.current = null;
    setResult(null);
  }, [hold, setResult]);

  // Changing the brief or the operation drops the previous result, including any held restricted draft.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    discard();
  }, [briefId, operation, demo, discard]);

  async function onDownload(): Promise<void> {
    setDownload({ phase: 'running', fraction: null });
    setAnnounce('Model download started');
    try {
      await adapter.downloadModel((fraction) => setDownload({ phase: 'running', fraction }));
      setDownload({ phase: 'idle' });
      setAnnounce('Model download finished');
    } catch {
      setDownload({ phase: 'failed' });
      setAnnounce('Model download failed');
    }
    await refreshReadiness();
  }

  async function onGenerate(): Promise<void> {
    discard();
    setGenerating(true);
    setAnnounce('Generating draft');
    const ids = brief.allowedRequirementIds;
    let p: AssistantProposal;
    if (demo && !brief.restricted) {
      p = demoProposal(operation, ids);
    } else {
      const req: AssistRequest = {
        projectId: target.projectId,
        taskText: brief.taskText,
        allowedRequirementIds: ids,
        sources: [{ id: brief.id, classification: brief.classification }],
        policy: buildPolicy(mode, brief, cloudPermitted),
      };
      try {
        p = await adapter[operation](req);
      } catch (e) {
        p = ERROR_PROPOSAL(operation, ids, e instanceof Error ? e.name : 'Error');
      }
    }
    // Restricted output goes to the in-memory hold only. The store gets metadata.
    const draftId = brief.restricted && p.status === 'ok' && !demo ? `draft-${p.requestId}` : null;
    if (draftId) {
      hold.hold({ id: draftId, sourceClassifications: [brief.classification], proposal: p });
      heldRef.current = draftId;
    }
    const meta: ResultMeta = {
      requestId: p.requestId, operation, status: p.status, demo: demo && !brief.restricted, restricted: brief.restricted, briefId: brief.id,
      selectedMode: mode, requestedMode: p.requestedMode, observedSource: p.observedSource, rawInferenceSource: p.rawInferenceSource,
      totalMs: p.timing.totalMs, schemaStatus: p.validation.status, schemaErrors: p.validation.errors, blockedReason: p.blockedReason,
      errorName: p.errorName, cloudModel: p.model.cloudModel, sdkVersion: p.model.sdkVersion, draftId, proposal: brief.restricted ? null : p,
    };
    setResult(meta);
    setGenerating(false);
    setAnnounce(p.status === 'ok' ? 'Draft ready' : 'Request did not produce a draft');
    await refreshReadiness();
  }

  // Semantic checks run on the draft wherever it lives; restricted data is read from the hold at render time.
  const semantic: ProposalValidation | null = useMemo(() => {
    if (!result || result.status !== 'ok') return null;
    const data = result.restricted ? (result.draftId ? hold.get(result.draftId)?.proposal.data : undefined) : result.proposal?.data;
    if (data === undefined) return null;
    const b = briefById(result.briefId);
    return validateProposal(data, { operation: result.operation, allowedRequirementIds: b.allowedRequirementIds, forbiddenMandatoryScope: b.forbiddenMandatoryScope });
  }, [result, hold]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[13px] text-muted">SelariKru</p>
          <h1 className="text-2xl font-semibold">Assistant</h1>
          <p className="mt-1 max-w-prose text-muted">Draft requirements on this device or in the cloud. Every draft says where it came from, and only a checked task plan reaches the workflow.</p>
        </div>
        {demo && !brief.restricted ? <Chip tone="warning">Demo data</Chip> : null}
      </header>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <RequestForm target={target} onTarget={setTarget} onGenerate={() => void onGenerate()} />
          <ModelCard onDownload={() => void onDownload()} />
        </div>
        <div className="space-y-4">
          <InferenceIndicator semantic={semantic?.status ?? null} />
          <OutputView result={result} semantic={semantic} onDiscard={discard} />
          {result ? <HandoffPanel key={result.requestId + result.briefId + String(result.demo)} result={result} semantic={semantic} api={api} runId={target.runId} baseline={brief.allowedRequirementIds} /> : null}
        </div>
      </div>
    </div>
  );
}
