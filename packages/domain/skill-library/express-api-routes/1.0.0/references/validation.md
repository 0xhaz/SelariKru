# A validation shape

Validate into a result instead of throwing from deep inside a handler. One function per request body keeps the rules in one place and makes them easy to test without HTTP.

```ts
type Check<T> = { ok: true; value: T } | { ok: false; fields: Record<string, string> };

function checkCreate(body: unknown): Check<{ title: string; description: string }> {
  const fields: Record<string, string> = {};
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.title !== 'string') fields.title = 'title must be a string';
  if (b.description !== undefined && typeof b.description !== 'string') fields.description = 'description must be a string';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!fields.title && ([...title].length < 3 || [...title].length > 120)) fields.title = 'title must be 3 to 120 characters';
  if (!fields.description && [...description].length > 1000) fields.description = 'description must be at most 1000 characters';
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value: { title, description } };
}
```

The limits above are an example. Take the real ones from the contract.

In the handler, a failed check becomes the contract's error response, written in one place:

```ts
const sendInvalid = (res: Response, fields: Record<string, string>) =>
  res.status(400).json({ error: { code: 'validation_failed', message: Object.values(fields)[0], fields } });
```

Use the error code and field names the contract defines, if it defines them.

Things that are easy to miss:

- A field of the wrong type (a number for `title`) is a validation error, not a crash.
- An unknown status value in a query string or body is a 400, before any database work.
- A missing row is a 404 with the same error body shape.
- Nothing is written when validation fails: check first, then write.
