# Testing routes over HTTP

Node 24 has a global `fetch`, so a route test needs no extra HTTP library. Start the app on port 0, read the port it got, and close it afterwards.

```ts
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';

let server: Server;
let base: string;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('creates an item', async () => {
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Dark mode' }),
  });
  expect(res.status).toBe(201);
});
```

Adapt `openDatabase` and `createApp` to what the repository actually exports.

Habits that keep these tests honest:

- One database per test (`:memory:` or a file in a temporary directory), so tests never depend on each other's rows.
- To test persistence across a restart, use a file path, close the first app and its database, then open a second one on the same file.
- Assert on the status code and on the stored state (a follow-up `GET`), not only on the response body.
- Cover the failure paths the contract lists: invalid input, wrong types, unknown ids.
- Control timestamps and ids through seed data when ordering matters, instead of waiting between writes.
