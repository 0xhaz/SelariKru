---
name: express-api-routes
description: Writing Express 5 JSON routes backed by better-sqlite3, and testing them with Vitest over a real port. Use when adding or changing API routes, validation or persistence in an Express server.
---

# Express 5 routes and their tests

Reference material for API work in an Express 5 server that stores data with better-sqlite3. The API contract your task names decides paths, fields, status codes and the error body; this pack covers how to implement and test them reliably.

## Routes

- Build the app in a factory (for example `createApp(db)`) and start listening somewhere else. Tests can then make a fresh app per test with its own database.
- Parse JSON with `express.json()`. Its default body limit is 100 KB. A body that is not valid JSON reaches the error handler with `err.type === 'entity.parse.failed'` and status 400; answer it with the contract's error body.
- Express 5 passes a rejected promise or a thrown error from a route handler to the error handler, so `async` handlers need no wrapper. Register one error-handling middleware (four arguments: `err, req, res, next`) after the routes, and never let it echo stack traces.
- Validate every field yourself, in the server: type first, then trimming, then length or allowed values. Count lengths the way the contract says (for example in code points with `[...s].length`, not `s.length`).
- Send exactly one response per request and `return` right after it.
- Express 5 route paths use path-to-regexp 8: `/:id` works as before, but a wildcard needs a name, such as `/*rest`.

See `references/validation.md` for a validation shape that keeps the error body consistent.

## SQLite with better-sqlite3

- The API is synchronous: `db.prepare(sql)` returns a statement with `.run()`, `.get()` and `.all()`.
- Always pass values as parameters (`?` or `@name`). Never build SQL from request text.
- Wrap multi-statement writes in `db.transaction(fn)`; it returns a function that runs `fn` atomically.
- Order lists explicitly in SQL (`ORDER BY created_at DESC, id DESC`). Never rely on insertion order.
- Put schema changes in a new migration file rather than in startup code.

## Tests

See `references/testing.md`. Test through HTTP against a real listening server and a throwaway database, so the test checks what a client sees.
