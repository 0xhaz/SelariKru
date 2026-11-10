# Small patterns

A table of cases keeps boundary tests short and readable:

```ts
import { describe, expect, it } from 'vitest';

describe('title length', () => {
  it.each([
    ['ab', false],
    ['abc', true],
    ['a'.repeat(120), true],
    ['a'.repeat(121), false],
  ])('%s is accepted: %s', (title, ok) => {
    expect(isValidTitle(title)).toBe(ok);
  });
});
```

Fake time, restored after each test:

```ts
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});
```

Waiting on a condition rather than a delay, with a bound so a broken test fails instead of hanging:

```ts
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setImmediate(r));
  }
}
```

Prefer an event or a promise the code already gives you when one exists; a polling helper is for when it does not.
