/** What a re-authentication attempt came to. The password itself is never kept: it goes to Firebase Auth and nowhere else. */
export type ReauthOutcome = 'ok' | 'failed' | 'too_many';

/** True only when the signed-in account has a password to confirm: an account that signs in another way has none, and a different form would be a lie. */
export function canReauthenticateWithPassword(user: { readonly email: string | null; readonly providerData: readonly { readonly providerId: string }[] } | null): boolean {
  return user !== null && user.email !== null && user.providerData.some((p) => p.providerId === 'password');
}

export function reauthOutcomeOf(error: unknown): Exclude<ReauthOutcome, 'ok'> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
  return code === 'auth/too-many-requests' ? 'too_many' : 'failed';
}
