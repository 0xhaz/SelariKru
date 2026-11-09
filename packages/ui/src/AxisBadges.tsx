import { EXECUTION_LABELS, MODEL_ROUTE_LABELS, type WorkerView } from '@selarikru/view-protocol';

function Axis({ axis, value, unknown, detail }: { axis: string; value: string; unknown: boolean; detail?: string | null }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 text-sm">
      <span className="max-w-full wrap-anywhere text-muted">{axis}</span>
      <span className={`max-w-full wrap-anywhere ${unknown ? 'text-warning' : 'text-fg'}`}>{value}</span>
      {detail ? <span className="max-w-full wrap-anywhere text-muted" data-testid="inference-model">{detail}</span> : null}
    </span>
  );
}

/** Worker execution and model inference are independent: a local sandbox may call a cloud model. They are never merged into one label. `model`: the id recorded on the attempt. */
export function AxisBadges({ execution, modelRoute, model = null, stacked = false }: { execution: WorkerView['execution']; modelRoute: WorkerView['modelRoute']; model?: string | null | undefined; stacked?: boolean }) {
  return (
    <span className={stacked ? 'flex flex-col gap-y-0.5' : 'flex flex-wrap gap-x-4 gap-y-0.5'}>
      <Axis axis="Execution" value={EXECUTION_LABELS[execution]} unknown={execution === 'unknown'} />
      <Axis axis="Inference" value={MODEL_ROUTE_LABELS[modelRoute]} unknown={modelRoute === 'unknown'} detail={model} />
    </span>
  );
}
