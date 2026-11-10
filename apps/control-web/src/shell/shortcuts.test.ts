import { describe, expect, it } from 'vitest';
import { shortcutFor, type KeyInput, type KeyTarget } from './shortcuts.ts';

/** A stand-in for an element: `inside` lists the selectors it sits within (closest), `is` the ones it matches itself. */
const el = (inside: readonly string[] = [], is: readonly string[] = []): KeyTarget => ({
  closest: (sel) => (sel.split(',').map((s) => s.trim()).some((s) => inside.includes(s) || is.includes(s)) ? {} : null),
  matches: (sel) => sel.split(',').map((s) => s.trim()).some((s) => is.includes(s)),
});
const key = (k: string, over: Partial<KeyInput> = {}): KeyInput => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, target: el([], ['body']), ...over });

describe('keyboard shortcuts', () => {
  it('1 to 9 open the worker at that place in the team panel', () => {
    expect(shortcutFor(key('1'))).toEqual({ kind: 'open-worker', index: 0 });
    expect(shortcutFor(key('9'))).toEqual({ kind: 'open-worker', index: 8 });
    expect(shortcutFor(key('0'))).toBeNull();
  });

  it('+, = and - zoom the office', () => {
    expect(shortcutFor(key('+'))).toEqual({ kind: 'zoom', delta: 1 });
    expect(shortcutFor(key('='))).toEqual({ kind: 'zoom', delta: 1 });
    expect(shortcutFor(key('-'))).toEqual({ kind: 'zoom', delta: -1 });
  });

  it('never takes a key typed into a field, a combobox, a terminal or an editable region', () => {
    for (const inside of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]', '[role="combobox"]', '[data-terminal]', '[role="log"]']) {
      expect(shortcutFor(key('1', { target: el([inside]) })), inside).toBeNull();
      expect(shortcutFor(key('-', { target: el([inside]) })), inside).toBeNull();
      expect(shortcutFor(key('Escape', { target: el([inside]) })), inside).toBeNull();
    }
  });

  it('never takes a key inside a dialog or a drawer, which own their keys', () => {
    for (const inside of ['dialog', '[role="dialog"]', '[role="alertdialog"]']) expect(shortcutFor(key('2', { target: el([inside]) }))).toBeNull();
  });

  it('leaves browser and system chords alone, and a key something already handled', () => {
    expect(shortcutFor(key('1', { metaKey: true }))).toBeNull();
    expect(shortcutFor(key('-', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('=', { altKey: true }))).toBeNull();
    expect(shortcutFor(key('1', { defaultPrevented: true }))).toBeNull();
  });

  it('Escape goes back to the office only from a resting place: the page, the main landing or the canvas, never from a control', () => {
    expect(shortcutFor(key('Escape'))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: null }))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: el([], ['#main']) }))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: el([], ['[data-office-canvas]']) }))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: el(['nav'], ['a']) }))).toBeNull();
    expect(shortcutFor(key('Escape', { target: el([], ['button']) }))).toBeNull();
  });

  it('Escape on the Settings modal or its main region closes it, though the modal is a dialog; a control inside it keeps its own Escape', () => {
    expect(shortcutFor(key('Escape', { target: el(['[role="dialog"]', '[data-shell-modal]'], ['#main']) }))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: el(['[role="dialog"]'], ['[data-shell-modal]', '[role="dialog"]']) }))).toEqual({ kind: 'escape' });
    expect(shortcutFor(key('Escape', { target: el(['[role="dialog"]', '[data-shell-modal]', '[role="combobox"]'], ['input']) }))).toBeNull();
    expect(shortcutFor(key('Escape', { target: el(['[role="dialog"]', '[data-shell-modal]'], ['button']) }))).toBeNull();
    // Digits stay with the dialog.
    expect(shortcutFor(key('1', { target: el(['[role="dialog"]', '[data-shell-modal]'], ['#main']) }))).toBeNull();
  });

  it('digits on a focused control in the page still open a worker: only text entry is protected', () => {
    expect(shortcutFor(key('3', { target: el(['nav'], ['a']) }))).toEqual({ kind: 'open-worker', index: 2 });
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'Enter', 'Tab', ' ', 'ArrowLeft', 'd']) expect(shortcutFor(key(k))).toBeNull();
  });
});
