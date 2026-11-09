import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, type Auth, type User } from 'firebase/auth';

const input = 'w-full rounded-chip border border-line bg-bg px-2 py-2 text-fg';
const button = 'rounded-chip px-3 py-2 text-sm font-medium disabled:opacity-50';

/** Firebase Auth gate. The signed-in frame, including sign-out, belongs to the shell. */
export function AuthGate({ auth, emulator, children }: { auth: Auth; emulator: boolean; children: (user: User) => ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => onAuthStateChanged(auth, setUser), [auth]);

  async function submit(e: FormEvent<HTMLFormElement>, create: boolean): Promise<void> {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? '');
    const password = String(f.get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      if (create) await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setError('Sign-in did not work. Check the email and password.');
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) return <p className="p-6 text-muted" role="status">Checking sign-in</p>;
  if (user === null) {
    return (
      <main className="mx-auto max-w-sm px-4 py-12">
        <p className="font-mono text-mono text-muted">SelariKru</p>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-muted">{emulator ? 'Using the local Firebase Auth Emulator.' : 'Use the owner account.'}</p>
        <form className="mt-6 space-y-4 rounded-card border border-line bg-panel p-4" onSubmit={(e) => void submit(e, false)}>
          <div>
            <label htmlFor="email" className="mb-1 block text-sm text-muted">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required className={input} />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm text-muted">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required className={input} />
          </div>
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={`${button} bg-active text-bg`}>Sign in</button>
            {emulator ? (
              <button type="button" disabled={busy} className={`${button} border border-line bg-panel-2 text-fg`} onClick={(e) => void submit({ preventDefault() {}, currentTarget: e.currentTarget.form! } as FormEvent<HTMLFormElement>, true)}>
                Create emulator account
              </button>
            ) : null}
          </div>
        </form>
      </main>
    );
  }
  return <>{children(user)}</>;
}
