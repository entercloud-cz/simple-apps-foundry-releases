// Small helper for calling the app's own API. Same origin, so the sign-in cookie
// set by the platform is sent automatically: no tokens in the browser.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

/** What a role lets its users do: read (see the data), write (also change it), admin (also the settings). */
export type Level = 'read' | 'write' | 'admin';

/** One of the user's roles, as the portal describes it (.platform/roles.json). */
export interface Role {
  value: string;
  displayName: string;
  /** What the role may do, in the owner's words. */
  description: string;
  /** null: the role gives no access in this app yet. */
  level: Level | null;
}

/** The signed-in user (GET /api/me). */
export interface Me {
  id: string;
  name: string;
  email: string | null;
  roles: Role[];
  /** The user's highest level; null: no role in this app yet. */
  level: Level | null;
  /** True on your computer: the fake user from DEV_FAKE_USER, no platform sign-in. */
  isDevUser: boolean;
}
