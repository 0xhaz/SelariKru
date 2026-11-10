import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { DecisionAction, DecisionCardModel } from './model.ts';

/** The notice on a card whose content changed while it was on screen. */
export const CHANGED_ON_SCREEN = { title: 'This request changed', body: 'What is shown here changed since you last looked at it. Review it again before deciding.' };
/** Why a changed card's commands are off until it is reviewed. */
export const DISABLED_BY_CHANGE = 'This request changed. Review the update above before deciding.';

/** A held card's commands, each off with the reason; links stay as they are. */
export function holdActions(actions: readonly DecisionAction[], held: boolean): readonly DecisionAction[] {
  return held ? actions.map((a) => (a.kind === 'command' ? { ...a, disabledReason: a.disabledReason ?? DISABLED_BY_CHANGE } : a)) : actions;
}

export interface ChangedCardsState {
  /** The fingerprint a person last acknowledged, by card id. */
  readonly seen: Readonly<Record<string, string>>;
  /** Cards whose content changed since the person last looked, held until acknowledged. */
  readonly held: ReadonlySet<string>;
  /** Reads cards as shown now: a first reading is remembered, a different one holds the card. Cards not shown are left as they were. */
  readonly observe: (cards: readonly DecisionCardModel[]) => void;
  readonly acknowledge: (card: DecisionCardModel) => void;
  readonly markChanged: (cardId: string) => void;
  readonly forget: (cardId: string) => void;
}

/**
 * One record per page of what the person has looked at, shared by every view that shows a card: a card held in the drawer is held on the Decisions screen, and
 * following "See the full card" keeps the hold. A view shows only some cards, so nothing here is dropped because a view does not show it.
 */
export function createChangedCardsStore() {
  return createStore<ChangedCardsState>()((set, get) => ({
    seen: {},
    held: new Set(),
    observe: (cards) => {
      const { seen, held } = get();
      let nextSeen: Record<string, string> | null = null;
      let nextHeld: Set<string> | null = null;
      for (const c of cards) {
        // Nothing known yet means nothing to compare: the first real reading is not a change.
        if (c.fingerprint === null) {
          if (c.id in seen) { nextSeen ??= { ...seen }; delete nextSeen[c.id]; }
          continue;
        }
        const was = seen[c.id];
        if (was === undefined) { nextSeen ??= { ...seen }; nextSeen[c.id] = c.fingerprint; }
        else if (was !== c.fingerprint && !held.has(c.id)) { nextHeld ??= new Set(held); nextHeld.add(c.id); }
      }
      if (nextSeen || nextHeld) set({ ...(nextSeen ? { seen: nextSeen } : {}), ...(nextHeld ? { held: nextHeld } : {}) });
    },
    acknowledge: (card) => {
      const { seen, held } = get();
      const nextHeld = new Set(held);
      nextHeld.delete(card.id);
      set({ seen: card.fingerprint !== null ? { ...seen, [card.id]: card.fingerprint } : seen, held: nextHeld });
    },
    markChanged: (cardId) => { const { held } = get(); if (!held.has(cardId)) set({ held: new Set(held).add(cardId) }); },
    forget: (cardId) => {
      const { seen, held } = get();
      const nextSeen = { ...seen };
      delete nextSeen[cardId];
      const nextHeld = new Set(held);
      nextHeld.delete(cardId);
      set({ seen: nextSeen, held: nextHeld });
    },
  }));
}

/** The page's one record. */
export const changedCards = createChangedCardsStore();

export interface ChangedCards {
  /** Cards whose content changed since the person last looked. Their commands are held until `acknowledge`. */
  readonly changedHere: ReadonlySet<string>;
  /** The person has looked at the card as it is now. */
  readonly acknowledge: (card: DecisionCardModel) => void;
  /** Holds a card, as when the server says it changed or a confirmation went stale under it. */
  readonly markChanged: (cardId: string) => void;
  /** The next change to this card is the person's own decision, so it is not held as a surprise. */
  readonly forget: (cardId: string) => void;
}

/** Reads and updates the page's shared record for the cards a view shows, so the Decisions screen and the worker drawer hold a changed card by the same rule. */
export function useChangedCards(cards: readonly DecisionCardModel[] | null, store = changedCards): ChangedCards {
  const held = useStore(store, (s) => s.held);
  useEffect(() => {
    if (cards) store.getState().observe(cards);
  }, [cards, store]);
  const { acknowledge, markChanged, forget } = store.getState();
  return { changedHere: held, acknowledge, markChanged, forget };
}
