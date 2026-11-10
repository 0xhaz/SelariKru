---
name: react-accessibility-checklist
description: A checklist for accessible React forms, lists and status messages that tests find by role and name. Use when building or changing React UI.
---

# React accessibility checklist

Reference material for React screens that people use with a keyboard or a screen reader, and that tests locate by role and accessible name. The task's contract decides the exact names and roles; this pack covers how to produce them.

## Names

- Every input has a visible label tied to it: `<label htmlFor="title">Title</label><input id="title" />`, or the input wrapped in its `<label>`. A placeholder is not a label.
- A button's name is its text. An icon-only button needs `aria-label`.
- A `<select>` is a combobox with a name from its label, like an input.
- Group related controls with an element that has `role="group"` and `aria-label`, or a `<fieldset>` with a `<legend>`.
- Where a contract gives an exact name (for example `Open 1`), the visible text must produce exactly that name, including spaces.

## State

- A toggle button shows its state with `aria-pressed="true"` or `"false"`.
- Loading and empty states go in an element with `role="status"`.
- Errors go in an element with `role="alert"`, rendered only while an error is active. Remove it, or replace it, when the next action starts.
- Do not mark a write as saved until the server confirms it. On failure, show the error and keep the previous value.

## Keyboard and focus

- Use native elements (`button`, `input`, `select`, `a href`). They are focusable and work with Enter and Space already.
- Never use a positive `tabIndex`. Tab order follows the DOM, so put the controls in the order people should reach them.
- A form submitted with Enter needs a real `<form onSubmit>` with a submit button; call `event.preventDefault()` and handle the request yourself.
- Keep focus where it was after a list re-renders. Use stable `key` values (the item id, never the array index).

## Text

- Render user text as text: `{item.title}` in JSX is escaped. Never use `dangerouslySetInnerHTML` for user content.
- Do not rely on color alone to show a state. Pair it with text.

See `references/testing.md` for testing this without a browser.
