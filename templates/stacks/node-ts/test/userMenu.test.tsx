import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Me } from '../src/client/api';
import { NoRole } from '../src/client/App';
import { SIGN_OUT_URL, SWITCH_USER_URL, UserMenu } from '../src/client/UserMenu';

const me: Me = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Jana Nováková',
  email: 'jana@contoso.com',
  roles: [{ value: 'Editor', displayName: 'Editor', description: 'Can change stock levels.', level: 'write' }],
  level: 'write',
  isDevUser: false,
};

describe('user menu', () => {
  it('shows the user, their roles with what each may do, Sign out and Sign in as another user', () => {
    const html = renderToStaticMarkup(<UserMenu me={me} defaultOpen />);
    expect(html).toContain('Jana Nováková');
    expect(html).toContain('jana@contoso.com');
    expect(html).toContain('<strong>Editor</strong>');
    expect(html).toContain('Can change stock levels.');
    expect(SIGN_OUT_URL).toBe('/.auth/logout?post_logout_redirect_uri=/');
    expect(SWITCH_USER_URL).toBe('/.auth/login/aad?prompt=select_account&post_login_redirect_uri=/');
    expect(html).toContain(`href="${SIGN_OUT_URL}"`);
    expect(html).toContain(`href="${SWITCH_USER_URL.replace('&', '&amp;')}"`);
    expect(html).toContain('aria-expanded="true"');
  });

  it('is a button that opens and closes a panel', () => {
    const html = renderToStaticMarkup(<UserMenu me={me} />);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    expect(html).toContain('hidden=""');
  });

  it('locally shows the fake user and no links to the platform sign-in', () => {
    const html = renderToStaticMarkup(<UserMenu me={{ ...me, isDevUser: true }} defaultOpen />);
    expect(html).toContain('DEV_FAKE_USER');
    expect(html).not.toContain('/.auth/');
  });

  it('tells a user without a role to ask the owner', () => {
    expect(renderToStaticMarkup(<NoRole isDevUser={false} />)).toContain('Ask the app');
    const html = renderToStaticMarkup(<UserMenu me={{ ...me, roles: [], level: null }} defaultOpen />);
    expect(html).toContain('You have no role in this app yet.');
  });
});
