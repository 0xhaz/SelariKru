import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Chip, EmptyState, Panel, Timestamp, formatAge } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt, DataSourceError } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import { CommandNotSent, type ConnectionState } from '../../shell/projection-store.ts';
import { hashWith } from '../../shell/route.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ActionControl, DecisionCard } from './DecisionCard.tsx';
import { CHANGED_NOT_SENT_MESSAGE, GONE_NOT_SENT_MESSAGE, NETWORK_MESSAGE, NOT_SENT_MESSAGE, outcomeMessage, rejectionView } from './copy.ts';
import { CHANGED_ON_SCREEN, holdActions, useChangedCards } from './useChangedCards.ts';
import { confirmIsStale, withPrBody, type DecisionAction, type DecisionCardModel, type DecisionsModel } from './model.ts';
import { hybridResults } from '../hybrid/context.tsx';

type CommandAction = Extract<DecisionAction, { kind: 'command' }>;


function Heading({ count, paused, counted, grouped }: { count: number; paused: boolean; counted: number; grouped: boolean }) {
  return (
    <div className="mb-5">
      <h1 id="decisions-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">Action items</h1>
      <p className="mt-1 text-lg text-muted" data-testid="decisions-summary">
        {count === 0 ? 'Nothing is waiting on you.' : `${count} waiting on you.`}
        {paused ? ' Actions are paused until the connection is live.' : ''}
      </p>
      {grouped ? <p className="mt-1 text-sm text-muted" data-testid="decisions-grouped">The header counts {counted} items; some share one decision here.</p> : null}
    </div>
  );
}

/** A group heading in the reference's style. */
function GroupTitle({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</h2>;
}

/**
 * One row in "Also waiting on you": the card's chip, one line, and its primary action, which goes through exactly the same handler, confirmation
 * and rules as the full card. "Details" opens the full card with its other actions.
 */
function CompactRow({ card, actions, primary, open, onToggle, children, onCommand, busyId }: { card: DecisionCardModel; actions: readonly DecisionAction[]; primary: DecisionAction | null; open: boolean; onToggle: () => void; children: ReactNode; onCommand: (a: CommandAction) => void; busyId: string | null }) {
  const reasonId = `${card.id}-row-reason`;
  const off = primary !== null && primary.disabledReason !== null;
  return (
    <li id={`row-${card.id}`}>
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" data-testid="action-row" data-row-kind={card.kind} data-card-id={card.id}>
        <span className="chip shrink-0" style={{ background: 'var(--color-cream-2)' }}>{card.chip}</span>
        {/* A stable place for focus to land, whether or not the row is open. */}
        <span id={`${card.id}-row-title`} tabIndex={-1} className="min-w-0 flex-1 truncate font-semibold text-fg outline-none focus-visible:outline-[3px] focus-visible:outline-solid" title={card.title}>{card.title}</span>
        {/* Once open, the full card below carries every action, this one included. */}
        {primary && !open ? <span className="shrink-0"><ActionControl action={primary} busyId={busyId} cardId={card.id} describedBy={off ? reasonId : undefined} onCommand={onCommand} /></span> : null}
        <button type="button" className="btn shrink-0 text-[13px]" aria-expanded={open} onClick={onToggle}>{open ? 'Hide details' : actions.length > (primary ? 1 : 0) ? 'Details and more actions' : 'Details'}</button>
        {off && !open ? <p id={reasonId} className="basis-full text-sm text-muted" data-testid="row-disabled-reason">{primary.disabledReason}</p> : null}
      </div>
      {open ? <div className="mt-2">{children}</div> : null}
    </li>
  );
}

export interface DecisionsViewProps {
  readonly connection: ConnectionState;
  readonly error: DataSourceError | null;
  readonly model: DecisionsModel | null;
  readonly failure?: unknown;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly mode: 'mock' | 'live';
  readonly leaveDemoHref?: string | undefined;
  /** What the run is doing while the queue is empty, so a quiet screen still answers "are we progressing?". */
  readonly delivery: { readonly criteria: string; readonly blocker: string | null } | null;
  /** What workers ask that has no decision card of its own (a question, a wait on a person): shown under "From workers", with a way to open the worker. */
  readonly fromWorkers?: ReactNode;
  /** How many of those there are, for the count. */
  readonly elsewhere: number;
  /** Records that need nothing from you now, kept visible so nothing that was on the old queue disappears. */
  readonly noted?: ReactNode;
  /** The worker a card's request came from, for the name link; null when the record does not say. */
  readonly workerOf?: (card: DecisionCardModel) => { readonly id: string; readonly label: string } | null;
  /** How many of the attention items that need a person do have a card. Several can share one, such as two tasks stopped by one budget. */
  readonly counted: number;
  readonly onRestart: () => void;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
  /** The Project Brain's open conflicts, Product follow-ups and handover offers, shown under "Also waiting on you". */
  readonly brain?: ReactNode;
}

/** Cards a worker raised: approval requests. Everything else is a decision about the run, under "Also waiting on you". */
const FROM_WORKERS: ReadonlySet<DecisionCardModel['kind']> = new Set(['approval']);

/**
 * The queue of things only a person can decide. Inspecting never resolves anything: a command is sent only by pressing a button that names its outcome, and
 * a button is on only while the session is live and the card still matches what the person last looked at.
 */
export function DecisionsView({ connection, error, model, failure, confirmedAt, nowMs, mode, leaveDemoHref, delivery, elsewhere, counted, onRestart, onExecute, onRefresh, onResync, brain, fromWorkers = null, noted = null, workerOf }: DecisionsViewProps) {
  if (failure !== undefined) throw failure;

  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<Readonly<Record<string, string>>>({});
  // Ids only: the dialog always reads the live card, so it can never confirm something that has changed.
  const [confirming, setConfirming] = useState<{ cardId: string; actionId: string; fingerprint: string | null } | null>(null);
  const [status, setStatus] = useState('');
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const openRow = useCallback((id: string) => setOpenRows((o) => (o.has(id) ? o : new Set(o).add(id))), []);
  // Focus moves after the commit that opens, updates or removes what it lands on: the first of these ids that exists then.
  const [focusNext, setFocusNext] = useState<{ ids: readonly string[]; scroll: boolean } | null>(null);
  const focusById = useCallback((...ids: string[]) => setFocusNext({ ids, scroll: false }), []);
  useEffect(() => {
    if (!focusNext) return;
    const el = focusNext.ids.map((id) => document.getElementById(id)).find((x): x is HTMLElement => x !== null);
    if (focusNext.scroll) el?.scrollIntoView({ block: 'center' });
    el?.focus();
    setFocusNext(null);
  }, [focusNext]);
  /** A card's title, wherever it is: the full card's heading, or its compact row's title. */
  const titleIds = (id: string): string[] => [`${id}-title`, `${id}-row-title`];
  // One key per intended outcome, kept across a network failure so a retry cannot apply twice.
  const keys = useRef(new Map<string, string>());
  const cards = model?.cards ?? null;

  const { changedHere, acknowledge, markChanged, forget } = useChangedCards(cards);

  // A deep link lands on its card, once per link.
  const hashHandled = useRef<string | null>(null);
  useEffect(() => {
    const query = window.location.hash.split('?')[1] ?? '';
    const target = new URLSearchParams(query).get('card');
    if (target && hashHandled.current !== window.location.hash && cards?.some((c) => c.id === target)) {
      hashHandled.current = window.location.hash;
      // A deep link to a compact row opens its full card first; scrolling and focus follow once that has rendered.
      openRow(target);
      setFocusNext({ ids: titleIds(target), scroll: true });
    }
  }, [cards, openRow]);

  // A dialog is only good for the card as it was when opened, and only while the session is live.
  const liveConfirm = confirming ? (cards?.find((c) => c.id === confirming.cardId) ?? null) : null;
  const liveAction = liveConfirm?.actions.find((a): a is CommandAction => a.kind === 'command' && a.id === confirming?.actionId) ?? null;
  const confirmStale = confirming !== null && confirmIsStale(connection, liveConfirm, liveAction, confirming.fingerprint);
  useEffect(() => {
    if (!confirming || !confirmStale) return;
    setConfirming(null);
    if (liveConfirm === null) {
      setStatus(GONE_NOT_SENT_MESSAGE);
      return;
    }
    const offline = connection !== 'live';
    const message = offline ? NOT_SENT_MESSAGE : CHANGED_NOT_SENT_MESSAGE;
    setRefused((r) => ({ ...r, [liveConfirm.id]: message }));
    if (!offline) markChanged(liveConfirm.id);
    openRow(liveConfirm.id);
    setStatus(message);
    focusById(`feedback-${liveConfirm.id}`, ...titleIds(liveConfirm.id));
  }, [confirming, confirmStale, liveConfirm, connection, markChanged, openRow, focusById]);

  const review = useCallback((card: DecisionCardModel) => {
    acknowledge(card);
    setRefused((r) => { const { [card.id]: _gone, ...rest } = r; return rest; });
    focusById(...titleIds(card.id));
  }, [acknowledge, focusById]);

  async function dispatch(card: DecisionCardModel, action: CommandAction): Promise<void> {
    const keyId = `${card.id}:${action.id}:${card.fingerprint}`;
    const idempotencyKey = keys.current.get(keyId) ?? `decision-${crypto.randomUUID()}`;
    keys.current.set(keyId, idempotencyKey);
    // The pull request description chosen in a task's AI actions goes with the open request (H5).
    const command = withPrBody({ ...action.intent, idempotencyKey } as AuthorizedViewCommand, hybridResults.getState().prBody, hybridResults.getState().prBodyFrom);
    // The next item in the order shown: what workers ask first, then the rest.
    const shown = cards ? [...cards.filter((c) => FROM_WORKERS.has(c.kind)), ...cards.filter((c) => !FROM_WORKERS.has(c.kind))] : [];
    const index = shown.findIndex((c) => c.id === card.id);
    const nextId = shown[index + 1]?.id ?? shown[index - 1]?.id ?? null;
    setBusy((b) => ({ ...b, [card.id]: action.id }));
    // A busy, refused or changed card is shown in full, so what happened to it can be read.
    openRow(card.id);
    let receipt: CommandReceipt;
    try {
      receipt = await onExecute(command);
    } catch (e) {
      setBusy((b) => { const { [card.id]: _x, ...rest } = b; return rest; });
      const message = e instanceof CommandNotSent ? NOT_SENT_MESSAGE : NETWORK_MESSAGE;
      setRefused((r) => ({ ...r, [card.id]: message }));
      setStatus(message);
      focusById(`feedback-${card.id}`, ...titleIds(card.id));
      return;
    }
    setBusy((b) => { const { [card.id]: _x, ...rest } = b; return rest; });
    keys.current.delete(keyId);
    if (receipt.accepted) {
      setRefused((r) => { const { [card.id]: _x, ...rest } = r; return rest; });
      // The change this card shows next is the person's own decision, so it is not held back as a surprise.
      forget(card.id);
      setStatus(outcomeMessage(card, action, command, receipt));
      onRefresh();
      focusById(...(nextId ? titleIds(nextId) : []), 'decisions-heading');
      return;
    }
    const view = rejectionView(receipt.rejection);
    setRefused((r) => ({ ...r, [card.id]: view.text }));
    setStatus(view.text);
    if (view.changed) markChanged(card.id);
    // The screen was wrong about something: show what is true now rather than guessing.
    onResync();
    focusById(`feedback-${card.id}`, ...titleIds(card.id));
  }

  if (!model) {
    if (connection === 'unavailable' || connection === 'dead') {
      return (
        <>
          <Heading count={0} paused counted={0} grouped={false} />
          <section aria-label="Connection" className="rounded-card border border-line bg-panel">
            <EmptyState title="Project data is unavailable" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
              <p>{STATE_COPY.unavailable[mode]}</p>
              {error ? <p className="mt-2 text-sm">Error category <span className="font-mono text-mono">{error.code}</span></p> : null}
            </EmptyState>
          </section>
        </>
      );
    }
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Action items</h1>
        <p role="status" className="mt-4 text-muted">Loading project state</p>
      </>
    );
  }

  const live = connection === 'live';
  const renderCard = (card: DecisionCardModel, without: string | null) => {
    const changedOnScreen = changedHere.has(card.id);
    const actions = holdActions(card.actions, changedOnScreen).filter((x) => x.id !== without);
    const who = workerOf?.(card) ?? null;
    return (
      <>
        {who ? <p className="mb-1 text-sm text-muted" data-testid="card-worker">From <a className="font-semibold text-active underline underline-offset-2" href={hashWith('worker', who.id)}>{who.label}</a> · {formatAge(nowMs - Date.parse(card.since))} ago</p> : null}
        <DecisionCard
          card={card}
          actions={actions}
          changedNotice={changedOnScreen ? CHANGED_ON_SCREEN : null}
          busyId={busy[card.id] ?? null}
          nowMs={nowMs}
          feedback={refused[card.id] ?? null}
          onCommand={(x) => onCommand(card, x)}
          onReview={() => review(card)}
        />
      </>
    );
  };
  const onCommand = (card: DecisionCardModel, x: CommandAction): void => { if (x.confirm) setConfirming({ cardId: card.id, actionId: x.id, fingerprint: card.fingerprint }); else void dispatch(card, x); };
  const workerCards = model.cards.filter((c) => FROM_WORKERS.has(c.kind));
  const otherCards = model.cards.filter((c) => !FROM_WORKERS.has(c.kind));
  const waiting = model.waiting + elsewhere;
  const nothing = model.cards.length === 0 && elsewhere === 0;
  return (
    <>
      <Heading count={waiting} paused={model.paused !== null} counted={counted} grouped={counted > model.waiting} />
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      {/* One polite line per decision. Clock ticks and heartbeats write nothing here. */}
      <p role="status" aria-live="polite" data-testid="decision-status" className={status ? 'mb-4 rounded-chip border border-active bg-active-tint p-3 text-fg' : 'sr-only'}>{status}</p>
      {model.empty ? (
        <section aria-label="Queue" className="rounded-card border border-line bg-panel">
          <EmptyState title="No run in this project yet" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} primary />}>
            <p>Action items appear here once a run needs you.</p>
          </EmptyState>
        </section>
      ) : nothing ? (
        <section aria-label="Queue" className="rounded-card border border-line bg-panel" data-testid="decisions-empty">
          <EmptyState title="Nothing is waiting on you.">
            {live
              ? <p>Work continues without you. {delivery?.criteria ? `${delivery.criteria}.` : ''}{delivery?.blocker ? ` Top blocker: ${delivery.blocker}` : ''}</p>
              : <p>Whether anything is waiting is unknown until the connection returns.</p>}
          </EmptyState>
        </section>
      ) : (
        <div className="space-y-6">
          {workerCards.length > 0 || fromWorkers ? (
            <section aria-labelledby="from-workers-title" data-testid="from-workers">
              <GroupTitle id="from-workers-title">From workers</GroupTitle>
              {workerCards.length > 0 ? (
                <ol className="space-y-4" aria-label="Decisions waiting">
                  {workerCards.map((card, i) => <li key={card.id} className={i === 0 ? 'outline-[3px] outline-orange outline-solid' : ''}>{renderCard(card, null)}</li>)}
                </ol>
              ) : null}
              {fromWorkers ? <div className="mt-4">{fromWorkers}</div> : null}
            </section>
          ) : null}
          {otherCards.length > 0 ? (
            <section aria-labelledby="also-waiting-title" data-testid="also-waiting">
              <GroupTitle id="also-waiting-title">Also waiting on you</GroupTitle>
              <ol className="space-y-2" aria-label={workerCards.length > 0 ? 'Also waiting on you' : 'Decisions waiting'}>
                {otherCards.map((card) => {
                  const actions = holdActions(card.actions, changedHere.has(card.id));
                  const primary = actions.find((x) => x.style === 'primary') ?? null;
                  // Open on request, and whenever something landed on the card: a refusal, a change since it was looked at, or a send in flight.
                  const open = openRows.has(card.id) || changedHere.has(card.id) || refused[card.id] !== undefined || busy[card.id] !== undefined;
                  return (
                    <CompactRow key={card.id} card={card} actions={actions} primary={primary} open={open} busyId={busy[card.id] ?? null}
                      onToggle={() => setOpenRows((o) => { const n = new Set(o); if (n.has(card.id)) n.delete(card.id); else n.add(card.id); return n; })}
                      onCommand={(x) => onCommand(card, x)}>
                      {renderCard(card, null)}
                    </CompactRow>
                  );
                })}
              </ol>
            </section>
          ) : null}
        </div>
      )}

      {brain ? <section aria-label="Also waiting on you: Brain, Product and handovers" className="mt-6">{brain}</section> : null}
      {noted ? <div className="mt-6">{noted}</div> : null}

      {model.history.length > 0 ? (
        <div className="mt-6">
          <Panel title="Decision history" labelId="decisions-history" aside="Recent, from the server and this session. A grant is a record; the work runs separately.">
            <ul className="divide-y divide-line">
              {model.history.map((h) => (
                <li key={h.id} className="py-2" data-testid="history-entry">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <Chip tone={h.tone}>{h.outcome}</Chip>
                      <span className="wrap-anywhere text-fg">{h.subject}</span>
                    </span>
                    <span className="text-sm text-muted">{h.at ? <Timestamp iso={h.at}>{`${formatAge(nowMs - Date.parse(h.at))} ago`}</Timestamp> : 'Time not recorded'}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted wrap-anywhere">{h.attribution}. {h.scope ? `${h.scope}. ` : 'Scope not recorded. '}{h.execution}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      {confirming && !confirmStale && liveConfirm && liveAction?.confirm ? (
        <ConfirmDialog
          copy={liveAction.confirm}
          confirmLabel={liveAction.label}
          onKeep={() => setConfirming(null)}
          onConfirm={() => { setConfirming(null); void dispatch(liveConfirm, liveAction); }}
        />
      ) : null}
    </>
  );
}
