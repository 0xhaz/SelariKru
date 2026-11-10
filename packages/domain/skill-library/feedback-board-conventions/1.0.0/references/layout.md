# Feedback Board starter layout

| Path | What it is |
| --- | --- |
| `contract/runtime.md` | Acceptance criteria FB-01 to FB-08, launch steps, environment variables and the screen's required roles and names. Frozen. |
| `contract/api.ts` | TypeScript types for every request and response, the status values and the error body. Frozen. |
| `contract/openapi.yaml` | The same API as an OpenAPI document. Frozen. |
| `server/app.ts` | `createApp()` returns the Express app. Routes belong here or in modules it imports. |
| `server/db.ts` | `openDatabase(path)` opens better-sqlite3 with WAL journaling and runs migrations. `FEEDBACK_DB_PATH` overrides the path; `:memory:` gives a throwaway database. |
| `server/migrate.ts` | `runMigrations(db, dir)` applies `migrations/*.sql` in filename order, once each, recording them in `schema_migrations`. |
| `server/index.ts` | Opens the database, then listens on `PORT` (3001 when unset). |
| `migrations/` | SQL migration files. The baseline ships none. Name new ones so they sort after existing ones, for example `0001_feedback.sql`. |
| `src/main.tsx`, `src/App.tsx` | The React entry point and root component. |
| `vite.config.ts` | Builds the screen into `dist/`. |
| `fixtures/feedback-fixtures.json` | Example seed data in the shape `FEEDBACK_SEED_FILE` expects. |
| `tests/backend/`, `tests/frontend/` | Vitest tests for each side. |

Scripts in `package.json`:

- `pnpm build` runs `tsc --noEmit` and then `vite build`.
- `pnpm start` runs `tsx server/index.ts`.
- `pnpm test` runs `vitest run --passWithNoTests`.
- `pnpm typecheck` runs `tsc --noEmit`.
