import type { AppRoles } from '../src/server/auth/roles.js';
import type { Config } from '../src/server/config.js';

/** Builds an X-MS-CLIENT-PRINCIPAL header value like the platform's sign-in does. */
export function principalHeader({ name = 'Test User', roles = [] as string[] } = {}): string {
  const principal = {
    auth_typ: 'aad',
    name_typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    role_typ: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: '11111111-1111-1111-1111-111111111111' },
      { typ: 'name', val: name },
      { typ: 'preferred_username', val: 'jana@contoso.com' },
      ...roles.map((role) => ({ typ: 'roles', val: role })),
    ],
  };
  return Buffer.from(JSON.stringify(principal)).toString('base64');
}

/** Headers of a signed-in user with these app roles. */
export function signedIn(...roles: string[]): Record<string, string> {
  return { 'x-ms-client-principal': principalHeader({ roles }) };
}

/**
 * The roles the tests use, whatever .platform/roles.json says: one per level, and one without a
 * level (it gives no access). The tests check the policy by level, not the app's role names.
 */
export const TEST_ROLES: AppRoles = {
  signIn: true,
  roles: [
    { value: 'Reader', displayName: 'Reader', description: 'Can see the data.', level: 'read' },
    { value: 'Editor', displayName: 'Editor', description: 'Can change the data.', level: 'write' },
    { value: 'Admin', displayName: 'Admin', description: 'Can change the settings.', level: 'admin' },
    { value: 'Guest', displayName: 'Guest', description: 'Has no level yet.', level: null },
  ],
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { port: 0, logLevel: 'fatal', onAzure: false, devUser: null, ...overrides };
}
