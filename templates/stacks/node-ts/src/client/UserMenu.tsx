import { useEffect, useId, useRef, useState } from 'react';
import type { Me } from './api';

// The platform's sign-in pages (built-in authentication of the platform, not the app's code). They
// exist only on the platform: on your computer the fake user from DEV_FAKE_USER is signed in, and
// the menu says so instead of linking there.
export const SIGN_OUT_URL = '/.auth/logout?post_logout_redirect_uri=/';
export const SWITCH_USER_URL = '/.auth/login/aad?prompt=select_account&post_login_redirect_uri=/';

/**
 * Who is signed in: name, email, their roles with what each may do, Sign out and Sign in as
 * another user. Every page of an app with sign-in keeps it (the platform's check looks for it).
 */
export function UserMenu({ me, defaultOpen = false }: { me: Me; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const rolesLabelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the menu and puts the focus back on its button; a click elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button secondary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="visually-hidden">Your account: </span>
        {me.name}
      </button>
      <div id={panelId} className="card user-menu-panel" hidden={!open}>
        <p className="user-menu-name">{me.name}</p>
        {me.email && <p className="muted">{me.email}</p>}

        <p id={rolesLabelId} className="user-menu-label">
          Your roles
        </p>
        {me.roles.length > 0 ? (
          <ul className="user-menu-roles" aria-labelledby={rolesLabelId}>
            {me.roles.map((role) => (
              <li key={role.value}>
                <strong>{role.displayName}</strong>
                {role.description && <span className="muted">: {role.description}</span>}
                {!role.level && <span className="muted"> (gives no access in this app yet)</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">You have no role in this app yet.</p>
        )}

        {me.isDevUser ? (
          <p className="muted user-menu-note">
            On your computer you are the fake user from DEV_FAKE_USER, with the roles in DEV_FAKE_ROLES. Signing in and
            out is the platform's: it works once the app runs there.
          </p>
        ) : (
          <ul className="user-menu-actions">
            <li>
              <a href={SIGN_OUT_URL}>Sign out</a>
            </li>
            <li>
              <a href={SWITCH_USER_URL}>Sign in as another user</a>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
