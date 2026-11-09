# Feedback Board runtime contract

Frozen with the API contract (`api.ts`, `openapi.yaml`). The independent verifier relies on the behavior stated in this file and in `api.ts` and `openapi.yaml`. Every rule the tests depend on is stated here or there. Changing it requires a new cohort.

This file is a contract only. The starter implements none of it.

## Acceptance criteria

The verifier judges a candidate on these eight criteria.

- FB-01: Create feedback with a trimmed title of 3–120 characters and an optional trimmed description of at most 1,000 characters. Required evidence: Valid POST returns 201 and a persisted item; browser displays the saved item.
- FB-02: Reject empty/too-short/too-long titles, oversized descriptions, wrong field types and invalid statuses. Required evidence: API returns 400 without creating/updating a row; UI provides a readable validation error.
- FB-03: List feedback newest first, breaking equal timestamps by descending item ID. Required evidence: Seeded API/browser assertions use controlled timestamps and IDs.
- FB-04: New feedback starts Open; updates permit Open, Planned or Done. Required evidence: PATCH persists the selected status; missing item returns 404.
- FB-05: Filter by All/Open/Planned/Done; status counts describe the full dataset. Required evidence: Three-item seed has one item in each status; filters and counts update after creation/status changes.
- FB-06: Saved feedback and status survive browser reload and API restart. Required evidence: Restart test reuses the same per-run database and checks API plus browser results.
- FB-07: Loading, empty and failed-request states are usable; unsuccessful writes do not appear saved. Required evidence: Controlled delay/failure and empty-database browser cases.
- FB-08: Form controls have accessible names, support keyboard use and render submitted text as text. Required evidence: Browser checks including a synthetic HTML/script-like title that never executes.

## Launch

1. `pnpm install --frozen-lockfile`, then `pnpm build`, then `pnpm start`.
2. `pnpm start` serves the API (`/api/feedback`, `/health`) and the built frontend (`GET /` returns the app) from the **same origin**, on the port given by the `PORT` environment variable.
3. `GET /health` returns 200 once the app is ready to serve requests.

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | TCP port to listen on. |
| `FEEDBACK_DB_PATH` | Path of the SQLite file. The app creates it (and its schema) if absent. |
| `FEEDBACK_SEED_FILE` | Optional path to a JSON file shaped like `{ "items": [{ "id", "title", "description", "status", "createdAt" }] }`. At startup, **only if the `feedback` data has no rows**, the app inserts those `items` verbatim (same `id`, `title`, `description`, `status`, `createdAt`), so that tests control IDs and timestamps. When the variable is unset, no rows are inserted. |

Data written through the API must survive a process restart on the same `FEEDBACK_DB_PATH`. The app may be stopped at any moment (SIGTERM or SIGKILL) after a write has been acknowledged.

## User interface

The verifier locates controls by accessible role and name only. No test IDs or CSS classes are used.

- Form: a textbox named **Title**, a textbox named **Description**, and a button named **Submit feedback**. Pressing Enter in Title submits the form.
- Filters: a group named **Filter by status** containing four buttons whose accessible names are the label followed by the global count, separated by one space: `All 3`, `Open 1`, `Planned 1`, `Done 1`. The selected filter has `aria-pressed="true"`. Counts always describe the full dataset, never the filtered view.
- List: a list named **Feedback list**. Each feedback card is one list item showing the item's title and description as plain text, and a combobox named **Status** whose option values are `open`, `planned`, `done` and whose value is the item's status. Changing it persists the status.
- Loading: while the initial list request is pending, an element with `role="status"` contains the text "Loading".
- Empty: when there are no items at all, an element with `role="status"` contains the text "No feedback".
- Errors: any failed request (list, create, update) or validation failure is shown in an element with `role="alert"` with non-empty readable text. A title validation error mentions "title". A failed write must never show the item as saved.
- Validation lives in the server and is shown by the UI. Title and Description must not carry native constraint attributes (`required`, `minlength`, `maxlength`, `pattern`) and the form must not rely on browser validation to block submission, so that invalid values reach the API and the UI shows the resulting `role="alert"`.
- The "Feedback list" list element is always present in the DOM, including when it has no items, while loading and after a load failure.
- Focus order: from page load, the first three focusable controls are Title, Description and Submit feedback, in that order, with nothing focusable between them. Every other control (filter buttons, each card's Status combobox) is reachable with at most 25 Tab key presses from page load.
- Alerts: no `role="alert"` element exists while no error is active. An alert from an earlier failure is removed, or replaced, when the next action starts or the page reloads. After any failed write or validation failure the form and list stay usable: Title, Description and Submit feedback remain enabled, and a valid submission made on the same page afterwards succeeds and removes the alert.
- Failed requests include network failures (a rejected `fetch`), not only HTTP error statuses. A failed status change leaves the card's Status combobox on its previous saved value.
- Title and Description lengths are counted in Unicode code points after trimming (JavaScript `String.prototype.trim` semantics), with no Unicode normalization of stored or counted text (so `e` plus a combining accent is two code points and stored as sent). Title and Description limits are independent.
- Text safety: user text is rendered as text, never as HTML.
