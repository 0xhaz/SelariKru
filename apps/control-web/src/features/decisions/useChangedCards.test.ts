import { describe, expect, it } from 'vitest';
import { createChangedCardsStore } from './useChangedCards.ts';
import type { DecisionCardModel } from './model.ts';

const card = (id: string, fingerprint: string | null) => ({ id, fingerprint }) as DecisionCardModel;

describe('the shared record of changed cards', () => {
  it('holds a card whose fingerprint moved, whichever view saw it first', () => {
    const store = createChangedCardsStore();
    // The drawer shows one card; the Decisions screen shows both.
    store.getState().observe([card('a', '1')]);
    store.getState().observe([card('a', '1'), card('b', '1')]);
    store.getState().observe([card('a', '2')]);
    expect([...store.getState().held]).toEqual(['a']);
    // A view that does not show a card leaves its record alone, so the other view still holds it.
    store.getState().observe([card('b', '1')]);
    expect(store.getState().held.has('a')).toBe(true);
    store.getState().observe([card('a', '2'), card('b', '1')]);
    expect(store.getState().held.has('a')).toBe(true);
  });

  it('is released by an acknowledgement, and the next change holds it again', () => {
    const store = createChangedCardsStore();
    store.getState().observe([card('a', '1')]);
    store.getState().observe([card('a', '2')]);
    store.getState().acknowledge(card('a', '2'));
    expect(store.getState().held.size).toBe(0);
    store.getState().observe([card('a', '2')]);
    expect(store.getState().held.size).toBe(0);
    store.getState().observe([card('a', '3')]);
    expect(store.getState().held.has('a')).toBe(true);
  });

  it('a card not known yet is not a change, and forget treats the next reading as a first one', () => {
    const store = createChangedCardsStore();
    store.getState().observe([card('a', null)]);
    store.getState().observe([card('a', '1')]);
    expect(store.getState().held.size).toBe(0);
    store.getState().forget('a');
    store.getState().observe([card('a', '9')]);
    expect(store.getState().held.size).toBe(0);
    store.getState().markChanged('a');
    expect(store.getState().held.has('a')).toBe(true);
  });
});
