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

  it.each([
    'task_sk_live_CANARY0123456789abcdefXYZ',
    'x_ghp_abcdefghijklmnopqrstuvwxyz0123',
    'a_AIzaSyA1234567890abcdefghijklmnopqrstu',
    'prefix_AKIAABCDEFGHIJKLMNOP',
    'my-glpat-abcdefghij0123456789',
    'id9xoxb-1234567890-abcdefghij',
    'abc_eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl',
    'foo_srt_abcdefghijklmnopqrstuvwxyz012345',
    'job:sk-ant-api03-abcdefghijklmnop0123',
  ])('redacts a prefixed token %s', (input) => {
    const out = redactSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/CANARY|abcdefghij|AKIAABCD|eyJhbGci/);
  });

  it.each([
    'Fix Bearer authentication handling',
    'pk-migration-for-feedback-table',
    'src/sk-button-component-variants.tsx',
    'token:refresh',
    'credentials:store',
    'secret:rotation-policy',
    'Add password reset page',
    'api-key-management/list.ts',
  ])('does not flag %s', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('still redacts Bearer and token assignments with a token-shaped value', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghij0123456789klmn')).not.toContain('abcdefghij0123456789klmn');
    expect(redactSecrets('token: abcdefghij0123456789klmn')).not.toContain('abcdefghij0123456789klmn');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Add a vote button to the board')).toBe('Add a vote button to the board');
  });
});
