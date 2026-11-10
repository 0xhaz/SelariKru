---
name: vitest-testing-practices
description: Habits for Vitest tests that stay deterministic and check real behaviour. Use when writing or fixing tests that run with Vitest.
---

# Vitest testing practices

Reference material for tests run with `vitest run`. The task's acceptance criteria say what must be true; tests are how you show yourself it is before the verifier checks.

## Write tests that can fail

- Name each test after the behaviour it checks, in plain words.
- Assert on outcomes a user or client sees: a status code, a stored row, a returned list in order. Avoid asserting on internal calls when an outcome is available.
- Cover the boundaries: the shortest and longest accepted value, one past each, the wrong type, the missing item.
- Never weaken or delete a failing test to make a run pass. Fix the code, or report that you could not.

## Keep them deterministic

- Do not wait a fixed time. Wait for the condition you need (a server's `listening` event, a promise, a returned row).
- Control time: pass a clock into the code, or use `vi.useFakeTimers()` and `vi.setSystemTime()`, and restore real timers afterwards.
- Give each test its own state: a fresh database, a fresh app, no module-level variables that leak between tests.
- Avoid real network calls. Listen on `127.0.0.1` with port 0 when a test needs a server.

## Run them

- `pnpm test` runs the whole suite once. `pnpm exec vitest run tests/backend` runs one directory.
- Put new tests where your task allows you to change files.
- Read failures fully: the first error is usually the cause, and later ones follow from it.

See `references/patterns.md` for small examples.
