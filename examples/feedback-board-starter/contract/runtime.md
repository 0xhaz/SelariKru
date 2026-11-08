# Feedback Board runtime contract

Frozen with the API contract (`api.ts`, `openapi.yaml`). The independent verifier relies on exactly the behavior below and nothing else. Changing it requires a new cohort.

This file is a contract only. The starter implements none of it.

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
- Text safety: user text is rendered as text, never as HTML.
