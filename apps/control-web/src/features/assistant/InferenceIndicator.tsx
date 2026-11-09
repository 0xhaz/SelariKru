import { POLICY_LABEL, STATUS_LABEL, formatElapsed, readinessLabel, sourceText } from './labels.ts';
import { useAssistantStore, type ResultMeta } from './store.ts';
import { Card, Chip } from './ui.tsx';
import type { InferenceMode } from '@selarikru/inference-firebase-web';

export type SemanticStatus = 'valid' | 'needs_review' | 'rejected';

function validationText(r: ResultMeta | null, semantic: SemanticStatus | null): string {
  if (!r) return 'Not run';
  if (r.demo) return 'Demo output: no model result was checked';
  if (r.status === 'blocked' || r.status === 'error') return 'Not run';
  if (r.status === 'route_violation' || r.status === 'unverified_source') return 'Withheld: output was not examined';
  const schema = r.schemaStatus === 'passed' ? 'Schema check passed' : r.schemaStatus === 'failed' ? 'Schema check failed' : 'Schema check not run';
  const scope = semantic === 'valid' ? 'Scope check: no findings' : semantic === 'needs_review' ? 'Scope check: needs review' : semantic === 'rejected' ? 'Scope check: rejected' : '';
  return scope ? `${schema} · ${scope}` : schema;
}

/**
 * Assistant inference indicator. Always separate from worker execution badges: it describes only where this
 * browser draft came from. Source comes from the SDK response, never from a setting or the page origin.
 */
export function InferenceIndicator({ semantic }: { semantic: SemanticStatus | null }) {
  const { mode, device, cloudModel, sdkVersion, generating, result, download } = useAssistantStore();
  const phase = generating ? 'generating' : result ? (result.demo ? 'demo' : result.status) : 'idle';
  const applied: InferenceMode | null = result && !result.demo ? (result.requestedMode ?? result.selectedMode) : mode;
  const readiness = readinessLabel(download.phase === 'running' ? 'downloading' : device);
  const source = sourceText(result?.observedSource ?? 'UNKNOWN', phase);
  const status = generating ? { text: 'Generating', tone: 'active' as const } : result ? (result.demo ? { text: 'Demo data', tone: 'neutral' as const } : STATUS_LABEL[result.status]) : { text: 'No request yet', tone: 'neutral' as const };
  const changed = result && !result.demo && result.requestedMode && result.requestedMode !== result.selectedMode;

  return (
    <Card title="Assistant inference" labelId="inference-title" hint="Where this draft came from. Separate from where workers run.">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
        <dt className="text-muted">Requested policy</dt>
        <dd data-testid="inf-policy">
          {applied ? <Chip tone="neutral">{POLICY_LABEL[applied]}</Chip> : <span className="text-muted">None</span>}
          {changed && result?.requestedMode ? <span className="mt-1 block text-muted">Selected {POLICY_LABEL[result.selectedMode]}; this source requires {POLICY_LABEL[result.requestedMode]}.</span> : null}
        </dd>
        <dt className="text-muted">Model readiness</dt>
        <dd data-testid="inf-readiness">
          <Chip tone={readiness.tone}>{readiness.text}</Chip>
          {cloudModel ? <span className="mt-1 block font-mono text-mono text-muted">cloud {cloudModel} · SDK {sdkVersion}</span> : null}
        </dd>
        <dt className="text-muted">Response source</dt>
        <dd data-testid="inf-source"><Chip tone={source.tone}>{source.text}</Chip></dd>
        <dt className="text-muted">Response</dt>
        <dd data-testid="inf-status"><Chip tone={status.tone}>{status.text}</Chip></dd>
        <dt className="text-muted">Validation</dt>
        <dd data-testid="inf-validation">{validationText(result, semantic)}</dd>
        <dt className="text-muted">Elapsed time</dt>
        <dd data-testid="inf-elapsed" className="font-mono text-mono">{result && !result.demo && result.status !== 'blocked' ? formatElapsed(result.totalMs) : generating ? 'Running' : 'Not measured'}</dd>
      </dl>
    </Card>
  );
}
