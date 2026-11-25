import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((err: unknown) =>
        setError(err instanceof ApiError && err.status === 401 ? 'You are not signed in.' : 'Could not load your profile.'),
      );
  }, []);

  return (
    <main className="page">
      <header className="header">
        <h1>{document.title}</h1>
        {/* /.auth/logout is provided by the platform's sign-in (not available locally). */}
        {me && <a href="/.auth/logout">Sign out</a>}
      </header>

      {error && <p role="alert">{error}</p>}
      {!me && !error && <p>Loading…</p>}
      {me && (
        <section>
          <p>Hello, {me.name}.</p>
          <p>Your roles: {me.roles.length > 0 ? me.roles.join(', ') : 'none'}</p>
        </section>
      )}
    </main>
  );
}
