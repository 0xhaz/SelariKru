import { readinessLabel } from './labels.ts';
import { useAssistantStore } from './store.ts';
import { Card, Chip, btnPrimary } from './ui.tsx';

/** On-device model readiness and download. Download starts only from the button. It is not generation. */
export function ModelCard({ onDownload }: { onDownload: () => void }) {
  const { device, download } = useAssistantStore();
  const r = readinessLabel(download.phase === 'running' ? 'downloading' : device);
  const canDownload = (device === 'downloadable' || device === 'evicted') && download.phase !== 'running';
  const pct = download.phase === 'running' && download.fraction !== null ? Math.round(download.fraction * 100) : null;
  return (
    <Card title="On-device model" labelId="model-title" hint="Download is separate from generating a draft. It starts only when you press the button.">
      <Chip tone={r.tone}>{r.text}</Chip>
      {canDownload ? (
        <div className="mt-3">
          <button type="button" className={btnPrimary} onClick={onDownload}>Download on-device model</button>
          <p className="mt-2 text-sm text-muted">The first download can take several minutes and uses disk space.</p>
        </div>
      ) : null}
      {download.phase === 'running' ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-sm">
            <span id="dl-label">On-device model download</span>
            <span className="font-mono text-mono">{pct === null ? 'Waiting for progress' : `${pct}%`}</span>
          </div>
          <div
            role="progressbar"
            aria-labelledby="dl-label"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(pct === null ? {} : { 'aria-valuenow': pct })}
            className="h-2 overflow-hidden rounded-chip bg-bg"
          >
            <div className="progress-fill h-full w-full bg-active" style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} />
          </div>
        </div>
      ) : null}
      {download.phase === 'failed' ? <p className="mt-3 text-sm text-danger">The download did not finish. Try again from the button above.</p> : null}
    </Card>
  );
}
