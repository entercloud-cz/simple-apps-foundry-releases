// Reads the signed-in user from the X-MS-CLIENT-PRINCIPAL header.
//
// The platform's sign-in (Azure Container Apps built-in authentication, "Easy Auth")
// signs users in with Microsoft Entra ID before a request reaches the app, and adds
// this header: base64-encoded JSON with the user's claims. Never implement your own
// login. Locally there is no Easy Auth: use DEV_FAKE_USER / DEV_FAKE_ROLES instead.
//
// This file has no framework dependencies so it can be copied into any Node app.

export interface User {
  /** Entra object id. Stable: use it as the key when you store data about a user. */
  id: string;
  /** Display name, for showing in the UI. */
  name: string;
  /** Sign-in name, usually the email address. Can change: never use it as a key. */
  email?: string;
  /** App role values assigned to the user (via Entra groups), e.g. ["Reader"]. */
  roles: string[];
}

export const PRINCIPAL_HEADER = 'x-ms-client-principal';

interface Claim {
  typ: string;
  val: string;
}

interface ClientPrincipal {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: Claim[];
}

const OBJECT_ID_TYPES = ['http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid'];
const ROLE_TYPES = ['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];
const EMAIL_TYPES = [
  'preferred_username',
  'email',
  'upn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];

/** Returns the user, or null when the header is missing or malformed. */
export function parseClientPrincipal(header: string | string[] | undefined): User | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;

  let principal: ClientPrincipal;
  try {
    principal = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as ClientPrincipal;
  } catch {
    return null;
  }
  const claims = Array.isArray(principal?.claims)
    ? principal.claims.filter((c) => typeof c?.typ === 'string' && typeof c?.val === 'string')
    : [];
  const values = (types: string[]) => claims.filter((c) => types.includes(c.typ)).map((c) => c.val);
  const first = (types: string[]) => values(types)[0];

  const id = first(OBJECT_ID_TYPES);
  if (!id) return null;

  const roleTypes = principal.role_typ ? [principal.role_typ, ...ROLE_TYPES] : ROLE_TYPES;
  const email = first(EMAIL_TYPES);
  const name =
    first(['name']) ?? (principal.name_typ ? first([principal.name_typ]) : undefined) ?? email ?? id;

  return { id, name, email, roles: [...new Set(values(roleTypes))] };
}

/** Local development mock, built from DEV_FAKE_USER and DEV_FAKE_ROLES (comma-separated). */
export function devUser(email: string | undefined, roles: string | undefined): User | null {
  if (!email) return null;
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: email.split('@')[0] ?? email,
    email,
    roles: (roles ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  };
}

export function hasAnyRole(user: User | null, roles: string[]): boolean {
  return user !== null && roles.some((r) => user.roles.includes(r));
}
