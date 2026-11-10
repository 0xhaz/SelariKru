/** What a re-authentication attempt came to. The password itself is never kept: it goes to Firebase Auth and nowhere else. */
export type ReauthOutcome = 'ok' | 'failed' | 'too_many' | 'unreachable';

/** True only when the signed-in account has a password to confirm: an account that signs in another way has none, and a different form would be a lie. */
export function canReauthenticateWithPassword(user: { readonly email: string | null; readonly providerData: readonly { readonly providerId: string }[] } | null): boolean {
  return user !== null && user.email !== null && user.providerData.some((p) => p.providerId === 'password');
}

export function reauthOutcomeOf(error: unknown): Exclude<ReauthOutcome, 'ok'> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
  if (code === 'auth/too-many-requests') return 'too_many';
  // The request never reached Firebase Auth: nothing is wrong with the password, so the person is not told to check it.
  if (code === 'auth/network-request-failed') return 'unreachable';
  return 'failed';
}

/** What the form says for each failed outcome. */
export const REAUTH_MESSAGE: Readonly<Record<Exclude<ReauthOutcome, 'ok'>, string>> = {
  failed: 'The sign-in did not work. Check the password and try again.',
  too_many: 'Too many sign-in attempts. Wait a few minutes, then try again.',
  unreachable: 'Could not reach the sign-in service; try again.',
};
