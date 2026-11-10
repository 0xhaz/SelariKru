---
name: feedback-board-conventions
description: How the Feedback Board starter is laid out and what it expects of a change. Use when working in a repository with contract/runtime.md, server/ and src/ from the Feedback Board starter.
---

# Feedback Board conventions

This pack describes the Feedback Board starter: an Express 5 and SQLite API with a React 19 screen built by Vite, tested with Vitest. It is reference material. Your task file and the contract decide what to build.

## Read first

1. `contract/runtime.md`: the acceptance criteria, how the app starts, its environment variables and the exact accessible names the screen must use.
2. `contract/api.ts` and `contract/openapi.yaml`: the request and response shapes, including the error body.

The contract is frozen. Do not edit anything under `contract/`. If the contract and this pack disagree, the contract is right.

## Layout

See `references/layout.md` for what each directory holds. In short:

- `server/` is the API. `server/app.ts` builds the Express app (`createApp`), `server/db.ts` opens the SQLite database, `server/migrate.ts` applies migrations, `server/index.ts` starts listening.
- `migrations/` holds SQL files that `runMigrations` applies once each, in filename order.
- `src/` is the React screen. `src/main.tsx` mounts `App` from `src/App.tsx`.
- `tests/backend/` and `tests/frontend/` hold Vitest tests for each side.

## Rules that save a failed attempt

- Keep the dependency set as it is. `package.json` and `pnpm-lock.yaml` are fixed for the run.
- Change only the paths your task file allows. The other half of the app may be built by another worker at the same time.
- Validation lives in the server. The screen shows the error the API returns.
- One process serves the API and the built screen on the same origin, on the port in `PORT`.
- Data must survive a restart on the same `FEEDBACK_DB_PATH`, so write it to SQLite, never only to memory.
- Tests run in Node with Vitest. There is no jsdom and no browser in the test run.

## Before you finish

Follow `references/checks.md`. A change that does not build fails verification whatever its tests say.
