import { useId } from 'react';
import { Chip, RAIL_SHADOW, Timestamp, buttonPrimary, buttonQuiet, formatAge, type Tone } from '@selarikru/ui';
import type { DecisionAction, DecisionCardModel, Fact, NotDeliveredModel } from './model.ts';

const dangerButton = 'inline-flex items-center justify-center rounded-chip border border-danger px-3 py-2 text-sm font-medium text-danger hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-50';
const STYLE: Readonly<Record<DecisionAction['style'], string>> = { primary: buttonPrimary, quiet: buttonQuiet, danger: dangerButton };

function ActionControl({ action, busyId, cardId, describedBy, onCommand }: { action: DecisionAction; busyId: string | null; cardId: string; describedBy: string | undefined; onCommand: (a: Extract<DecisionAction, { kind: 'command' }>) => void }) {
  const cls = `${STYLE[action.style]} w-full text-center`;
  if (action.kind === 'link') {
    if (action.disabledReason !== null) return <button type="button" disabled data-action={action.id} aria-describedby={describedBy} className={cls}>{action.label}</button>;
    return action.external
      ? <a data-action={action.id} href={action.href} target="_blank" rel="noreferrer" className={cls}>{action.label}<span className="sr-only"> (opens in a new tab)</span><span aria-hidden="true" className="ml-1.5">↗</span></a>
      : <a data-action={action.id} href={action.href} className={cls}>{action.label}</a>;
  }
  const busy = busyId === action.id;
  // A busy button stays focusable, so a keyboard user's place is not lost mid-request; a turned-off one is truly disabled.
  return (
    <button
      type="button"
      data-action={action.id}
      disabled={action.disabledReason !== null}
      aria-disabled={busyId !== null ? true : undefined}
      aria-describedby={describedBy}
      className={cls}
      onClick={() => { if (busyId === null) onCommand(action); }}
    >
      {action.label}{busy ? <span className="sr-only"> (working)</span> : null}
    </button>
  );
}

function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-muted">{f.label}</dt>
          <dd className={`m-0 wrap-anywhere text-fg ${f.mono ? 'font-mono text-mono' : ''}`}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function NotDeliveredList({ model }: { model: NotDeliveredModel }) {
  return (
    <section aria-label="Not delivered" data-testid="not-delivered" className="rounded-chip border border-line bg-panel-2 p-3">
      <h3 className="text-sm font-semibold text-fg">Not delivered</h3>
      <ul className="mt-2 divide-y divide-line">
        {model.tasks.map((t) => (
          <li key={t.taskId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
            <span className="min-w-0 wrap-anywhere text-fg">{t.title}</span>
            <Chip tone={t.budgetStopped ? 'warning' : 'neutral'}>{t.budgetStopped ? 'Stopped for budget' : t.status}</Chip>
          </li>
        ))}
      </ul>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted">Requirements</dt>
        <dd className="m-0 wrap-anywhere font-mono text-mono text-fg">{model.requirementIds.join(', ') || 'None'}</dd>
        <dt className="text-muted">Acceptance checks</dt>
        <dd className="m-0 wrap-anywhere font-mono text-mono text-fg">{model.acceptanceCheckIds.join(', ') || 'None'}</dd>
      </dl>
    </section>
  );
}

const STATE_CHIP: Readonly<Record<string, { tone: Tone; text: string } | undefined>> = {
  changed: { tone: 'warning', text: 'Changed' },
};

export interface DecisionCardProps {
  readonly card: DecisionCardModel;
  /** The card's actions with any server or on-screen refusal applied. */
  readonly actions: readonly DecisionAction[];
  /** Set when what was shown has changed since this person last looked. Null when the model itself already reports it. */
  readonly changedNotice: { readonly title: string; readonly body: string } | null;
  readonly busyId: string | null;
  readonly nowMs: number;
  readonly feedback: string | null;
  readonly onCommand: (a: Extract<DecisionAction, { kind: 'command' }>) => void;
  readonly onReview: () => void;
}

export function DecisionCard({ card, actions, changedNotice, busyId, nowMs, feedback, onCommand, onReview }: DecisionCardProps) {
  const reasonId = useId();
  const changed = card.changed ?? changedNotice;
  // One line per distinct reason a control is off, so the panel never repeats itself.
  const reasons = [...new Set(actions.map((a) => a.disabledReason).filter((r): r is string => r !== null))];
  const describedBy = reasons.length > 0 ? reasonId : undefined;
  const chip = STATE_CHIP[card.state];
  return (
    <article id={`card-${card.id}`} data-testid="decision-card" data-card-id={card.id} data-kind={card.kind} data-state={card.state} aria-labelledby={`${card.id}-title`} className={`rounded-card border border-line bg-panel ${RAIL_SHADOW[card.tone]}`}>
      <div className="grid gap-x-6 gap-y-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={card.tone}>{card.chip}</Chip>
            {chip ? <Chip tone={chip.tone}>{chip.text}</Chip> : null}
            <span className="text-sm text-muted">Waiting <Timestamp iso={card.since}>{formatAge(nowMs - Date.parse(card.since))}</Timestamp></span>
          </div>
          <h2 id={`${card.id}-title`} tabIndex={-1} className="mt-2 text-lg font-semibold wrap-anywhere text-fg outline-none">{card.title}</h2>
          <p className="mt-1 text-fg">{card.summary}</p>

          {changed ? (
            <div data-testid="request-changed" className="mt-3 rounded-chip border border-l-4 border-warning bg-warning-tint p-3">
              <p className="font-semibold text-warning">{changed.title}</p>
              <p className="mt-0.5 text-fg">{changed.body}</p>
              {changedNotice && !card.changed ? <button type="button" className={`${buttonQuiet} mt-2`} onClick={onReview}>I have reviewed the update</button> : null}
            </div>
          ) : null}

          {card.reason ? (
            <blockquote data-testid="request-reason" data-source={card.reason.source} className="mt-3 border-l-2 border-line-strong pl-3">
              <p className="text-sm font-medium text-muted">{card.reason.label}</p>
              <p className="wrap-anywhere text-fg">{card.reason.text}</p>
            </blockquote>
          ) : null}

          {card.advisory ? (
            <p data-testid="advisory" className="mt-3 rounded-chip border border-line-strong bg-panel-2 p-3 text-sm text-fg">
              <span className="font-semibold">Recorded pause. </span>{card.advisory}
            </p>
          ) : null}

          {card.notDelivered ? <div className="mt-3"><NotDeliveredList model={card.notDelivered} /></div> : null}
          {card.kind === 'budget_stop' && !card.notDelivered ? <p className="mt-3 text-sm text-muted">What this run has not delivered is not known yet. It is not read as nothing.</p> : null}

          <div className="mt-4"><FactList facts={card.facts} /></div>

          <details className="mt-3 text-sm text-muted">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <div className="mt-2"><FactList facts={card.details.map((d) => ({ ...d, mono: true }))} /></div>
          </details>
        </div>

        <div role="group" aria-label={`Your decision: ${card.title}`} className="flex flex-col gap-3 rounded-chip border border-line bg-panel-2 p-3 lg:self-start">
          <div>
            <h3 className="text-sm font-semibold text-fg">If you do nothing</h3>
            <p className="mt-0.5 text-sm text-fg">{card.consequence}</p>
          </div>
          {card.note ? <p className="text-sm text-muted" data-testid="card-note">{card.note}</p> : null}
          {feedback ? <p id={`feedback-${card.id}`} tabIndex={-1} data-testid="card-feedback" className="rounded-chip border border-warning p-2 text-sm text-fg outline-none">{feedback}</p> : null}
          {actions.length > 0 ? <div className="flex flex-col gap-2">{actions.map((a) => <ActionControl key={a.id} action={a} busyId={busyId} cardId={card.id} describedBy={describedBy} onCommand={onCommand} />)}</div> : null}
          {reasons.length > 0 ? <p id={reasonId} data-testid="disabled-reason" className="text-sm text-muted">{reasons.join(' ')}</p> : null}
        </div>
      </div>
    </article>
  );
}
