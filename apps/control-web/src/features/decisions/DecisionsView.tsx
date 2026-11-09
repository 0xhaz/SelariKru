import { useCallback, useEffect, useRef, useState } from 'react';
import { Chip, EmptyState, Panel, Timestamp, formatAge } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt, DataSourceError } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DecisionCard } from './DecisionCard.tsx';
import { NETWORK_MESSAGE, outcomeMessage, rejectionView } from './copy.ts';
import type { DecisionAction, DecisionCardModel, DecisionsModel } from './model.ts';

type CommandAction = Extract<DecisionAction, { kind: 'command' }>;

const CHANGED_ON_SCREEN = { title: 'This request changed', body: 'What is shown here changed since you last looked at it. Review it again before deciding.' };

function focusById(id: string): void {
  // Focus after the commit that removes or updates the card.
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function Heading({ count, paused }: { count: number; paused: boolean }) {
  return (
    <div className="mb-5">
      <h1 id="decisions-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">Decisions</h1>
      <p className="mt-1 text-lg text-muted" data-testid="decisions-summary">
        {count === 0 ? 'Nothing is waiting for you.' : `${count} ${count === 1 ? 'decision is' : 'decisions are'} waiting for you.`}
        {paused ? ' Decisions are paused until the connection is live.' : ''}
      </p>
    </div>
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
  readonly onRestart: () => void;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
}

/**
 * The queue of things only a person can decide. Inspecting never resolves anything: a command is sent only by pressing a button that names its outcome, and
 * a button is on only while the session is live and the card still matches what the person last looked at.
 */
export function DecisionsView({ connection, error, model, failure, confirmedAt, nowMs, mode, leaveDemoHref, delivery, onRestart, onExecute, onRefresh, onResync }: DecisionsViewProps) {
  if (failure !== undefined) throw failure;

  // The fingerprint a person last acknowledged per card. A change on screen is held back until they have looked again.
  const seen = useRef(new Map<string, string>());
  const [changedHere, setChangedHere] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<Readonly<Record<string, string>>>({});
  const [confirming, setConfirming] = useState<{ card: DecisionCardModel; action: CommandAction } | null>(null);
  const [status, setStatus] = useState('');
  // One key per intended outcome, kept across a network failure so a retry cannot apply twice.
  const keys = useRef(new Map<string, string>());
  const cards = model?.cards ?? null;

  useEffect(() => {
    if (!cards) return;
    const ids = new Set(cards.map((c) => c.id));
    const next = new Set([...changedHere].filter((id) => ids.has(id)));
    let changed = next.size !== changedHere.size;
    for (const c of cards) {
      const was = seen.current.get(c.id);
      if (was === undefined) seen.current.set(c.id, c.fingerprint);
      else if (was !== c.fingerprint && !next.has(c.id)) {
        next.add(c.id);
        changed = true;
      }
    }
    for (const id of [...seen.current.keys()]) if (!ids.has(id)) seen.current.delete(id);
    if (changed) setChangedHere(next);
    // Depends on the cards only; `changedHere` is read as the latest set and rewritten here.
  }, [cards]);

  // A deep link lands on its card, once per link.
  const hashHandled = useRef<string | null>(null);
  useEffect(() => {
    const query = window.location.hash.split('?')[1] ?? '';
    const target = new URLSearchParams(query).get('card');
    if (target && hashHandled.current !== window.location.hash && cards?.some((c) => c.id === target)) {
      hashHandled.current = window.location.hash;
      requestAnimationFrame(() => {
        document.getElementById(`card-${target}`)?.scrollIntoView({ block: 'center' });
        document.getElementById(`${target}-title`)?.focus();
      });
    }
  }, [cards]);

  const review = useCallback((card: DecisionCardModel) => {
    seen.current.set(card.id, card.fingerprint);
    setChangedHere((s) => { const n = new Set(s); n.delete(card.id); return n; });
    setRefused((r) => { const { [card.id]: _gone, ...rest } = r; return rest; });
    focusById(`${card.id}-title`);
  }, []);

  async function dispatch(card: DecisionCardModel, action: CommandAction): Promise<void> {
    const keyId = `${card.id}:${action.id}:${card.fingerprint}`;
    const idempotencyKey = keys.current.get(keyId) ?? `decision-${crypto.randomUUID()}`;
    keys.current.set(keyId, idempotencyKey);
    const command = { ...action.intent, idempotencyKey } as AuthorizedViewCommand;
    const index = cards?.findIndex((c) => c.id === card.id) ?? -1;
    const nextId = cards?.[index + 1]?.id ?? cards?.[index - 1]?.id ?? null;
    setBusy((b) => ({ ...b, [card.id]: action.id }));
    let receipt: CommandReceipt;
    try {
      receipt = await onExecute(command);
    } catch {
      setBusy((b) => { const { [card.id]: _x, ...rest } = b; return rest; });
      setRefused((r) => ({ ...r, [card.id]: NETWORK_MESSAGE }));
      setStatus(NETWORK_MESSAGE);
      focusById(`feedback-${card.id}`);
      return;
    }
    setBusy((b) => { const { [card.id]: _x, ...rest } = b; return rest; });
    keys.current.delete(keyId);
    if (receipt.accepted) {
      setRefused((r) => { const { [card.id]: _x, ...rest } = r; return rest; });
      // The change this card shows next is the person's own decision, so it is not held back as a surprise.
      seen.current.delete(card.id);
      setChangedHere((s) => { const n = new Set(s); n.delete(card.id); return n; });
      setStatus(outcomeMessage(card, action, command, receipt));
      onRefresh();
      focusById(nextId ? `${nextId}-title` : 'decisions-heading');
      return;
    }
    const view = rejectionView(receipt.rejection);
    setRefused((r) => ({ ...r, [card.id]: view.text }));
    setStatus(view.text);
    if (view.changed) setChangedHere((s) => new Set(s).add(card.id));
    // The screen was wrong about something: show what is true now rather than guessing.
    onResync();
    focusById(`feedback-${card.id}`);
  }

  if (!model) {
    if (connection === 'unavailable') {
      return (
        <>
          <Heading count={0} paused />
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
        <h1 className="text-2xl font-semibold tracking-tight">Decisions</h1>
        <p role="status" className="mt-4 text-muted">Loading project state</p>
      </>
    );
  }

  const live = connection === 'live';
  return (
    <>
      <Heading count={model.waiting} paused={model.paused !== null} />
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      {/* One polite line per decision. Clock ticks and heartbeats write nothing here. */}
      <p role="status" aria-live="polite" data-testid="decision-status" className={status ? 'mb-4 rounded-chip border border-active bg-active-tint p-3 text-fg' : 'sr-only'}>{status}</p>
      {model.empty ? (
        <section aria-label="Queue" className="rounded-card border border-line bg-panel">
          <EmptyState title="No run in this project yet" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} primary />}>
            <p>Decisions appear here once a run needs one.</p>
          </EmptyState>
        </section>
      ) : model.cards.length === 0 ? (
        <section aria-label="Queue" className="rounded-card border border-line bg-panel" data-testid="decisions-empty">
          <EmptyState title="No decisions waiting">
            {live
              ? <p>Work continues without you. {delivery?.criteria ? `${delivery.criteria}.` : ''}{delivery?.blocker ? ` Top blocker: ${delivery.blocker}` : ''}</p>
              : <p>Whether anything is waiting is unknown until the connection returns.</p>}
          </EmptyState>
        </section>
      ) : (
        <ol className="space-y-4" aria-label="Decisions waiting">
          {model.cards.map((card) => {
            const changedOnScreen = changedHere.has(card.id);
            const disabledByChange = changedOnScreen ? 'This request changed. Review the update above before deciding.' : null;
            const actions = disabledByChange ? card.actions.map((a) => (a.kind === 'command' ? { ...a, disabledReason: a.disabledReason ?? disabledByChange } : a)) : card.actions;
            const feedback = refused[card.id] ?? null;
            return (
              <li key={card.id}>
                <DecisionCard
                  card={card}
                  actions={actions}
                  changedNotice={changedOnScreen ? CHANGED_ON_SCREEN : null}
                  busyId={busy[card.id] ?? null}
                  nowMs={nowMs}
                  feedback={feedback}
                  onCommand={(a) => { if (a.confirm) setConfirming({ card, action: a }); else void dispatch(card, a); }}
                  onReview={() => review(card)}
                />
              </li>
            );
          })}
        </ol>
      )}

      {model.history.length > 0 ? (
        <div className="mt-6">
          <Panel title="Recorded in this session" labelId="decisions-history" aside="A grant is a record; the work runs separately">
            <ul className="divide-y divide-line">
              {model.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-testid="history-entry">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Chip tone={h.tone}>{h.outcome}</Chip>
                    <span className="wrap-anywhere text-fg">{h.subject}</span>
                  </span>
                  <span className="text-sm text-muted"><Timestamp iso={h.at}>{`${formatAge(nowMs - Date.parse(h.at))} ago`}</Timestamp></span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          copy={confirming.action.confirm!}
          confirmLabel={confirming.action.label}
          onKeep={() => setConfirming(null)}
          onConfirm={() => { const c = confirming; setConfirming(null); void dispatch(c.card, c.action); }}
        />
      ) : null}
    </>
  );
}
