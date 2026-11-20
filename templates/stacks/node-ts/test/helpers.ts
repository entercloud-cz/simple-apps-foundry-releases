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

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { port: 0, logLevel: 'fatal', onAzure: false, devUser: null, ...overrides };
}
