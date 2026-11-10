import { describe, expect, it } from 'vitest';
import { canReauthenticateWithPassword, reauthOutcomeOf } from './reauth.ts';

describe('signing in again in place', () => {
  it('offers the password form only to an account that signs in with a password', () => {
    expect(canReauthenticateWithPassword({ email: 'a@b.test', providerData: [{ providerId: 'password' }] })).toBe(true);
    expect(canReauthenticateWithPassword({ email: 'a@b.test', providerData: [{ providerId: 'google.com' }, { providerId: 'password' }] })).toBe(true);
    expect(canReauthenticateWithPassword({ email: 'a@b.test', providerData: [{ providerId: 'google.com' }] })).toBe(false);
    expect(canReauthenticateWithPassword({ email: 'a@b.test', providerData: [] })).toBe(false);
    expect(canReauthenticateWithPassword({ email: null, providerData: [{ providerId: 'password' }] })).toBe(false);
    expect(canReauthenticateWithPassword(null)).toBe(false);
  });

  it('maps rate limiting to its own outcome, and any other failure to a failed sign-in', () => {
    expect(reauthOutcomeOf({ code: 'auth/too-many-requests' })).toBe('too_many');
    expect(reauthOutcomeOf({ code: 'auth/wrong-password' })).toBe('failed');
    expect(reauthOutcomeOf({ code: 'auth/invalid-credential' })).toBe('failed');
    expect(reauthOutcomeOf(new Error('x'))).toBe('failed');
    expect(reauthOutcomeOf(null)).toBe('failed');
  });
});
