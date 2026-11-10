# Checks before finishing

Run these from the repository root and read the output. A passing run of your own tests is not the verifier's result; it only tells you the change is worth handing over.

1. `pnpm typecheck` finishes with no errors.
2. `pnpm build` finishes and writes `dist/`.
3. `pnpm test` passes. Add tests for what you changed under your role's test directory.
4. Start the app with a temporary database and check it by hand when your task touches the server:
   - `FEEDBACK_DB_PATH=/tmp/fb-check.sqlite PORT=3005 pnpm start`
   - `GET /health` answers 200 once it is ready.
   - Stop it when you are done.
5. Read your diff. Every changed file must be under a path your task file allows.

If a check fails and you cannot fix it inside your allowed paths, say so in your final message rather than changing files outside them.
