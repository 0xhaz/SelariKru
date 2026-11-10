# Testing UI logic without a browser

When the test run has no jsdom and no browser, keep the parts that decide behaviour out of components so plain Vitest tests can reach them.

- Put state changes in pure functions (a reducer, or functions that take the current state and an event). Test them directly: creating an item, a failed save restoring the previous status, a filter changing the visible list while counts stay global.
- Put request code in a small module that takes `fetch` as a parameter. Test it with a fake `fetch` that resolves, rejects, or answers with an error status, and check what the module reports.
- Keep formatting helpers (labels such as `Open 1`) pure and test the exact strings.
- `react-dom/server`'s `renderToStaticMarkup` runs in Node. It can check that markup contains the labels, roles and attributes you expect, for example that a toggle carries `aria-pressed="true"` or that user text appears escaped.

The verifier still runs its own browser checks. These tests are there so you find mistakes before it does.
