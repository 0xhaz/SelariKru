import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Chip, buttonQuiet } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt } from '@selarikru/view-protocol';
import { CommandNotSent } from '../../shell/projection-store.ts';
import { decisionHref } from '../../shell/route.ts';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';
import { ActionControl } from '../decisions/DecisionCard.tsx';
import { CHANGED_NOT_SENT_MESSAGE, NETWORK_MESSAGE, NOT_SENT_MESSAGE, outcomeMessage, rejectionView } from '../decisions/copy.ts';
import type { DecisionCardModel } from '../decisions/model.ts';
import { RoleModelAssignment, TaskModelOverride } from './ModelAssignments.tsx';
import type { TeamRow } from './model.ts';
import { STOP_CARD, confirmationStale, currentAction, type CommandAction, type PendingConfirm, type WorkerSettingsModel } from './settings.ts';
import { CHANGED_ON_SCREEN, holdActions, useChangedCards } from '../decisions/useChangedCards.ts';

type AssignProps = Omit<Parameters<typeof TaskModelOverride>[0], 'target'>;

export interface WorkerSettingsProps {
  readonly row: TeamRow;
  readonly settings: WorkerSettingsModel;
  readonly assign: AssignProps;
  /** False while the connection is not live: a confirmation open then is dropped and nothing is sent. */
  readonly live: boolean;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
  readonly onTerminal: () => void;
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className="space-y-3">
      <h3 id={id} className="text-sm font-semibold tracking-wide text-fg">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Changes made in place, through the same owner commands as the Team and Decisions screens: each one keeps its server route, its idempotency key across a retry,
 * its confirmation naming the consequence, and stays off with a reason while the connection is not live. A Decisions card that changes while shown is held
 * until reviewed, by the same rule as on the Decisions screen.
 */
export function WorkerSettings({ row, settings, assign, live, onExecute, onRefresh, onResync, onTerminal }: WorkerSettingsProps) {
  const reasonId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'refused'; text: string } | null>(null);
  // The exact command a confirmation will send, captured when it opened.
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const keys = useRef(new Map<string, string>());
  const cards = useMemo(() => settings.cards.map((c) => c.card), [settings.cards]);
  const { changedHere, acknowledge, markChanged, forget } = useChangedCards(cards);

  const stale = confirming !== null && confirmationStale(confirming, settings, live, changedHere);
  useEffect(() => {
    if (!confirming || !stale) return;
    setConfirming(null);
    if (live && confirming.cardId !== STOP_CARD) markChanged(confirming.cardId);
    setFeedback({ kind: 'refused', text: live ? CHANGED_NOT_SENT_MESSAGE : NOT_SENT_MESSAGE });
  }, [confirming, stale, live, markChanged]);

  async function dispatch(cardId: string, card: DecisionCardModel | null, action: CommandAction): Promise<void> {
    const keyId = `${cardId}:${action.id}:${card?.fingerprint ?? action.intent.expectedRevision}`;
    const idempotencyKey = keys.current.get(keyId) ?? `drawer-${crypto.randomUUID()}`;
    keys.current.set(keyId, idempotencyKey);
    const command = { ...action.intent, idempotencyKey } as AuthorizedViewCommand;
    setBusy(action.id);
    setFeedback(null);
    let receipt: CommandReceipt;
    try {
      receipt = await onExecute(command);
    } catch (e) {
      setBusy(null);
      setFeedback({ kind: 'refused', text: e instanceof CommandNotSent ? NOT_SENT_MESSAGE : NETWORK_MESSAGE });
      return;
    }
    setBusy(null);
    keys.current.delete(keyId);
    if (receipt.accepted) {
      if (card) forget(card.id);
      const name = card ?? ({ title: row.task?.title ?? 'this task' } as DecisionCardModel);
      setFeedback({ kind: 'ok', text: outcomeMessage(name, action, command, receipt) });
      onRefresh();
      return;
    }
    const view = rejectionView(receipt.rejection);
    setFeedback({ kind: 'refused', text: view.text });
    if (card && view.changed) markChanged(card.id);
    onResync();
  }

  const request = (cardId: string, card: DecisionCardModel | null, action: CommandAction): void => {
    if (action.confirm) setConfirming({ cardId, action, fingerprint: card?.fingerprint ?? null });
    else void dispatch(cardId, card, action);
  };

  const roleTarget = row.role ? assign.model.roles.find((r) => r.key === row.role) ?? null : null;
  const stop = settings.stop;

  return (
    <div className="space-y-6" data-testid="worker-settings">
      {feedback ? <p role={feedback.kind === 'ok' ? 'status' : 'alert'} data-testid="settings-feedback" className={`rounded-chip border p-2 text-sm wrap-anywhere ${feedback.kind === 'ok' ? 'border-active bg-active-tint text-fg' : 'border-danger bg-danger-tint text-fg'}`}>{feedback.text}</p> : null}
      {settings.cards.length > 0 ? (
        <Section title="Decisions about this task" testId="settings-decisions">
          <ul className="space-y-3">
            {settings.cards.map(({ card, actions: own }) => {
              const held = changedHere.has(card.id);
              const actions = holdActions(own, held);
              const changed = card.changed ?? (held ? CHANGED_ON_SCREEN : null);
              const reasons = [...new Set(actions.map((a) => a.disabledReason).filter((r): r is string => r !== null))];
              const describedBy = reasons.length > 0 ? `${reasonId}-${card.id.replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined;
              return (
                <li key={card.id} data-testid="settings-card" data-card-id={card.id} data-held={held ? '' : undefined} className="space-y-2 rounded-chip border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2"><Chip tone={card.tone}>{card.chip}</Chip>{held || card.changed ? <Chip tone="warning">Changed</Chip> : null}</div>
                  <p className="font-medium wrap-anywhere text-fg">{card.title}</p>
                  <p className="text-sm text-fg">{card.summary}</p>
                  {changed ? (
                    <div data-testid="request-changed" className="rounded-chip border border-l-4 border-warning bg-warning-tint p-2.5 text-sm">
                      <p className="font-semibold text-warning">{changed.title}</p>
                      <p className="mt-0.5 text-fg">{changed.body}</p>
                      {held && !card.changed ? <button type="button" className={`${buttonQuiet} mt-2`} onClick={() => acknowledge(card)}>I have reviewed the update</button> : null}
                    </div>
                  ) : null}
                  {card.reason ? (
                    <blockquote data-testid="request-reason" data-source={card.reason.source} className="border-l-2 border-line-strong pl-3 text-sm">
                      <p className="font-medium text-muted">{card.reason.label}</p>
                      <p className="wrap-anywhere text-fg">{card.reason.text}</p>
                    </blockquote>
                  ) : null}
                  {card.advisory ? <p data-testid="advisory" className="rounded-chip border border-line-strong bg-panel-2 p-2.5 text-sm text-fg"><span className="font-semibold">Recorded pause. </span>{card.advisory}</p> : null}
                  {card.note ? <p className="text-sm text-muted" data-testid="card-note">{card.note}</p> : null}
                  <p className="text-sm text-muted"><span className="font-medium text-fg">If you do nothing: </span>{card.consequence}</p>
                  {actions.length > 0 ? <div className="grid gap-2 sm:grid-cols-2">{actions.map((a) => <ActionControl key={a.id} action={a} busyId={busy} cardId={card.id} describedBy={describedBy} onCommand={(x) => request(card.id, card, x)} />)}</div> : null}
                  {describedBy ? <p id={describedBy} data-testid="disabled-reason" className="text-sm text-muted">{reasons.join(' ')}</p> : null}
                  <a className="inline-block text-sm font-medium text-active underline underline-offset-2" href={decisionHref(card.id)}>See the full card in Decisions</a>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <Section title="Model" testId="settings-model">
        <p className="text-sm text-muted">A change applies from the next attempt. The attempt running now keeps the model it was started with{row.assignment ? <>: <span className="font-mono text-mono text-fg">{row.assignment.provider} / {row.assignment.model}</span></> : ', which is not recorded'}.</p>
        {row.overrideTarget ? <TaskModelOverride {...assign} target={row.overrideTarget} /> : <p className="text-sm text-muted">{row.task || row.lastTask ? 'This task can take no further attempt, so its model cannot change.' : 'No task, so there is no task model to change.'}</p>}
        {roleTarget && !row.overrideTarget?.pinned ? <RoleModelAssignment {...assign} target={roleTarget} /> : null}
      </Section>

      <Section title="Cancel this task" testId="settings-stop">
        {stop ? (
          <div className="space-y-2 rounded-chip border border-line p-3">
            <p className="text-sm text-fg">Cancelling stops the running attempt and ends <span className="font-medium">{row.task?.title}</span> for good. To keep the task and try another model, change the model above instead.</p>
            <div className="max-w-xs"><ActionControl action={stop} busyId={busy} cardId={STOP_CARD} describedBy={stop.disabledReason !== null ? `${reasonId}-stop` : undefined} onCommand={(a) => request(STOP_CARD, null, a)} /></div>
            {stop.disabledReason !== null ? <p id={`${reasonId}-stop`} data-testid="stop-disabled-reason" className="text-sm text-muted">{stop.disabledReason}</p> : null}
          </div>
        ) : <p className="text-sm text-muted" data-testid="stop-none">{settings.stopNone}</p>}
      </Section>

      <Section title="Control mode" testId="settings-control">
        {row.terminalTarget ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" className={buttonQuiet} onClick={onTerminal}>Open the Terminal to take control</button>
            <p className="min-w-0 flex-1 basis-56 text-sm text-muted">Control mode is entered from the Terminal tab, through a confirmation. It marks the attempt as human-intervened.</p>
          </div>
        ) : <p className="text-sm text-muted">This worker has had no attempt, so there is no shell to control.</p>}
      </Section>

      {confirming && !stale && confirming.action.confirm ? (
        <ConfirmDialog
          copy={confirming.action.confirm}
          confirmLabel={confirming.action.label}
          onKeep={() => setConfirming(null)}
          // Exactly what was confirmed: the captured command, never whatever is on screen by now.
          onConfirm={() => { const p = confirming; setConfirming(null); void dispatch(p.cardId, currentAction(settings, p.cardId, p.action.id).card, p.action); }}
        />
      ) : null}
    </div>
  );
}
