import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { User } from './principal.js';

// The app's roles as the portal knows them, from .platform/roles.json. The platform writes that
// file into the repository (when it creates it, and with `platform agent-files update`); never
// edit it by hand: change the roles in the portal. The container image carries it (Dockerfile).
//
// Every role has a level: read (sees the app's data), write (also adds and changes it) or admin
// (also changes the app's settings). Levels nest: admin includes write, write includes read.
// A role without a level, or a role the sign-in carries that the file doesn't name, gives no
// access at all.

export const LEVELS = ['read', 'write', 'admin'] as const;
export type Level = (typeof LEVELS)[number];

export interface RoleDefinition {
  /** The role value in the sign-in token, e.g. "Reader" (case-sensitive). */
  value: string;
  displayName: string;
  /** What the role may do, in a sentence (the owner's words from the portal). */
  description: string;
  /** null: the role gives no access in the app. */
  level: Level | null;
}

export interface AppRoles {
  /** false for an anonymous (public) app: nobody signs in. */
  signIn: boolean;
  roles: RoleDefinition[];
}

/** The core's default roles: used when .platform/roles.json is missing (an older repository). */
export const DEFAULT_ROLES: AppRoles = {
  signIn: true,
  roles: [
    { value: 'Reader', displayName: 'Reader', description: "Can see the app and its data, but can't change anything.", level: 'read' },
    { value: 'Editor', displayName: 'Editor', description: "Can do what a Reader can, and add and change the app's everyday data.", level: 'write' },
    { value: 'Admin', displayName: 'Admin', description: "Can do everything in the app, including its settings and other users' data.", level: 'admin' },
  ],
};

const RolesFileSchema = z.object({
  signIn: z.boolean().default(true),
  roles: z.array(
    z.object({
      value: z.string().min(1),
      displayName: z.string().optional(),
      description: z.string().optional(),
      level: z.unknown().optional(),
    }),
  ),
});

export class RolesFileError extends Error {}

/** Reads the roles file's JSON text. Throws RolesFileError when it isn't a roles file. */
export function parseRoles(text: string): AppRoles {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RolesFileError('.platform/roles.json is not valid JSON');
  }
  const parsed = RolesFileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RolesFileError(`.platform/roles.json is not valid: ${problems.join('; ')}`);
  }
  return {
    signIn: parsed.data.signIn,
    roles: parsed.data.roles.map((r) => ({
      value: r.value,
      displayName: r.displayName || r.value,
      description: r.description ?? '',
      // An unknown level is no level: the role gives no access (`platform check` warns, PC067).
      level: LEVELS.includes(r.level as Level) ? (r.level as Level) : null,
    })),
  };
}

/** The roles from the file, or the core's defaults when there is no file. */
export function loadRoles(file: string): AppRoles {
  return existsSync(file) ? parseRoles(readFileSync(file, 'utf8')) : DEFAULT_ROLES;
}

/** The roles the file names that the user has, in the file's order. */
export function rolesOf(user: User, appRoles: AppRoles): RoleDefinition[] {
  return appRoles.roles.filter((r) => user.roles.includes(r.value));
}

/** The user's highest level, or null when none of their roles gives access. */
export function levelOf(user: User | null, appRoles: AppRoles): Level | null {
  if (!user) return null;
  let best = -1;
  for (const role of rolesOf(user, appRoles)) {
    if (role.level) best = Math.max(best, LEVELS.indexOf(role.level));
  }
  return best >= 0 ? (LEVELS[best] ?? null) : null;
}

/** True when `level` includes `needed` (admin includes write, write includes read). */
export function levelAllows(level: Level | null, needed: Level): boolean {
  return level !== null && LEVELS.indexOf(level) >= LEVELS.indexOf(needed);
}
