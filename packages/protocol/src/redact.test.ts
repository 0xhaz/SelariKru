import { describe, expect, it } from 'vitest';
import { redactSecrets, REDACTED } from './index.ts';

describe('redactSecrets', () => {
  it.each([
    ['key sk_live_CANARY0123456789abcdef here', 'sk_live_CANARY0123456789abcdef'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['aws AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['password=hunter2hunter2', 'hunter2hunter2'],
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', 'MIIabc'],
  ])('removes %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Add a vote button to the board')).toBe('Add a vote button to the board');
  });
});
