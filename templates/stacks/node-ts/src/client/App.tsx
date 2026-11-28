import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { UserMenu } from './UserMenu';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError && err.status === 401
            ? 'You are not signed in. On your computer, set DEV_FAKE_USER in .env.'
            : 'Could not load your profile.',
        ),
      );
  }, []);

  return (
    <div className="page">
      <header className="header">
        <h1>{document.title}</h1>
        {/* Who is signed in, their roles, Sign out (/.auth/logout) and Sign in as another user. Keep it. */}
        {me && <UserMenu me={me} />}
      </header>

      <main>
        {error && <p role="alert">{error}</p>}
        {!me && !error && <p>Loading…</p>}
        {me && (me.level ? <Home me={me} /> : <NoRole isDevUser={me.isDevUser} />)}
      </main>
    </div>
  );
}

/** The start page. Build the app's pages from here. */
export function Home({ me }: { me: Me }) {
  return (
    <section>
      <p>Hello, {me.name}.</p>
    </section>
  );
}

/**
 * A signed-in user without a role (or only with roles that give no access) sees this instead of
 * pages whose requests the server would refuse.
 */
export function NoRole({ isDevUser }: { isDevUser: boolean }) {
  return (
    <section className="card" aria-labelledby="no-role-heading">
      <h2 id="no-role-heading">You have no role in this app yet</h2>
      {isDevUser ? (
        <p>On your computer, give the fake user a role: set DEV_FAKE_ROLES in .env, for example Reader.</p>
      ) : (
        <p>Ask the app's owner to give you one. Once you have it, sign out and sign in again.</p>
      )}
    </section>
  );
}
