import type { InferenceMode } from '@selarikru/inference-firebase-web';
import { MODES, POLICY_HINT, POLICY_LABEL } from './labels.ts';
import { BRIEFS, OPERATIONS, briefById } from './fixtures.ts';
import { useAssistantStore } from './store.ts';
import { Card, btnPrimary, field } from './ui.tsx';
import type { ProposalOperation } from '@selarikru/domain';

export interface Target { projectId: string; runId: string }

export function RequestForm({ target, onTarget, onGenerate, recordedMode }: { target: Target; onTarget: (t: Target) => void; onGenerate: () => void; recordedMode?: InferenceMode | null | undefined }) {
  const { mode, operation, briefId, cloudPermitted, demo, generating, download, result, set } = useAssistantStore();
  const brief = briefById(briefId);
  const effectiveDemo = demo && !brief.restricted;
  return (
    <Card title="Request" labelId="request-title" hint="Choose the brief, what to draft, and where the model may run.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onGenerate();
        }}
      >
        <fieldset disabled={generating} className="space-y-4 border-0 p-0">
        <div>
          <label htmlFor="brief" className="mb-1 block text-sm text-muted">Brief</label>
          <select id="brief" className={field} value={briefId} onChange={(e) => set({ briefId: e.target.value })}>
            {BRIEFS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
          {brief.restricted ? (
            <p className="mt-2 text-sm text-muted">Restricted source. Its text is not shown or sent anywhere. Requested policy is raised to {POLICY_LABEL.ONLY_ON_DEVICE}.</p>
          ) : (
            <p className="mt-2 text-sm text-muted">{brief.taskText}</p>
          )}
        </div>

        <div>
          <label htmlFor="operation" className="mb-1 block text-sm text-muted">Operation</label>
          <select id="operation" className={field} value={operation} onChange={(e) => set({ operation: e.target.value as ProposalOperation })}>
            {OPERATIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>

        <fieldset>
          <legend className="mb-1 text-sm text-muted">Requested policy</legend>
          {recordedMode ? <p className="mb-1 text-sm text-muted" data-testid="recorded-mode">Recorded for this project during setup.</p> : null}
          <div className="space-y-2">
            {MODES.map((m) => (
              <label key={m} className={`flex cursor-pointer items-start gap-2 rounded-chip border px-3 py-2 ${mode === m ? 'border-active bg-panel-2' : 'border-line'}`}>
                <input type="radio" name="policy" className="mt-1" checked={mode === m} disabled={recordedMode !== null && recordedMode !== undefined} onChange={() => set({ mode: m })} />
                <span>
                  <span className="block text-sm font-medium">{POLICY_LABEL[m]}</span>
                  <span className="block text-sm text-muted">{POLICY_HINT[m]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cloudPermitted && !brief.restricted} disabled={brief.restricted} onChange={(e) => set({ cloudPermitted: e.target.checked })} />
            <span>This source may use cloud inference<span className="block text-muted">{brief.restricted ? 'Never for restricted sources.' : 'Synthetic brief; approval applies to this session.'}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={effectiveDemo} disabled={brief.restricted} onChange={(e) => set({ demo: e.target.checked })} />
            <span>Use demo output (no model call)<span className="block text-muted">Shows canned data labeled Demo data. Cannot be accepted and is never evidence.</span></span>
          </label>
        </div>

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-1 text-sm text-muted">Workflow target</legend>
          <div>
            <label htmlFor="project-id" className="mb-1 block text-sm text-muted">Project ID</label>
            <input id="project-id" className={`${field} font-mono text-mono`} value={target.projectId} onChange={(e) => onTarget({ ...target, projectId: e.target.value })} />
          </div>
          <div>
            <label htmlFor="run-id" className="mb-1 block text-sm text-muted">Run ID</label>
            <input id="run-id" className={`${field} font-mono text-mono`} value={target.runId} onChange={(e) => onTarget({ ...target, runId: e.target.value })} />
          </div>
        </fieldset>

        </fieldset>

        <div>
          <button type="submit" className={btnPrimary} disabled={generating || download.phase === 'running'}>Generate draft</button>
          <p data-testid="generation-status" role="status" className="mt-2 text-sm text-muted">{generating ? 'Generation: running' : result ? 'Generation: finished' : 'Generation: not started'}</p>
        </div>
      </form>
    </Card>
  );
}
