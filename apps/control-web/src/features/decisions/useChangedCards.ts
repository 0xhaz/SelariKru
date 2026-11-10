import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecisionAction, DecisionCardModel } from './model.ts';

/** The notice on a card whose content changed while it was on screen. */
export const CHANGED_ON_SCREEN = { title: 'This request changed', body: 'What is shown here changed since you last looked at it. Review it again before deciding.' };
/** Why a changed card's commands are off until it is reviewed. */
export const DISABLED_BY_CHANGE = 'This request changed. Review the update above before deciding.';

/** A held card's commands, each off with the reason; links stay as they are. */
export function holdActions(actions: readonly DecisionAction[], held: boolean): readonly DecisionAction[] {
  return held ? actions.map((a) => (a.kind === 'command' ? { ...a, disabledReason: a.disabledReason ?? DISABLED_BY_CHANGE } : a)) : actions;
}

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

/**
 * Tracks the fingerprint a person last acknowledged per card, so a change on screen is held back until they have looked again. Shared by the Decisions screen and the
 * worker drawer, so a card held in one is held by the same rule in the other.
 */
export function useChangedCards(cards: readonly DecisionCardModel[] | null): ChangedCards {
  const seen = useRef(new Map<string, string>());
  const [changedHere, setChangedHere] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!cards) return;
    const ids = new Set(cards.map((c) => c.id));
    const next = new Set([...changedHere].filter((id) => ids.has(id)));
    let changed = next.size !== changedHere.size;
    for (const c of cards) {
      // Nothing known yet means nothing to compare: the first real reading is not a change.
      if (c.fingerprint === null) {
        seen.current.delete(c.id);
        continue;
      }
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

  const acknowledge = useCallback((card: DecisionCardModel) => {
    if (card.fingerprint !== null) seen.current.set(card.id, card.fingerprint);
    setChangedHere((s) => { const n = new Set(s); n.delete(card.id); return n; });
  }, []);
  const markChanged = useCallback((cardId: string) => setChangedHere((s) => (s.has(cardId) ? s : new Set(s).add(cardId))), []);
  const forget = useCallback((cardId: string) => {
    seen.current.delete(cardId);
    setChangedHere((s) => { if (!s.has(cardId)) return s; const n = new Set(s); n.delete(cardId); return n; });
  }, []);
  return { changedHere, acknowledge, markChanged, forget };
}
