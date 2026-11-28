/**
 * What an app role may do, in a sentence: shown in the portal and rendered into the app repository's AGENTS.md
 * (`platform app roles` prints the current ones), so the app team's AI agent implements the roles as meant.
 *
 * An app's own role (app.yaml authentication.roles) carries its description and level; a default role (an app without
 * roles) takes instance.yaml authentication.defaultAppRoleDescriptions and defaultAppRoleLevels, else the core's text
 * and level below (ADR-0078). Browser-safe: the portal uses the same texts (exported as ./roles).
 */

/** The core's descriptions of its default roles (instance.schema.json defaultAppRoles), in English. */
export const BUILT_IN_ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Reader: "Can see the app and its data, but can't change anything.",
  Editor: "Can do what a Reader can, and add and change the app's everyday data.",
  Admin: "Can do everything in the app, including its settings and other users' data.",
};

/** ADR-0078: what a role may do in the app's default access policy. Nested: admin includes write, write includes read. */
export type RoleLevel = "read" | "write" | "admin";
export const ROLE_LEVELS: readonly RoleLevel[] = ["read", "write", "admin"];

/** The core's levels of its default roles. */
export const BUILT_IN_ROLE_LEVELS: Readonly<Record<string, RoleLevel>> = { Reader: "read", Editor: "write", Admin: "admin" };

/** An example of a good description, for the portal's role form (EN; the portal translates it). */
export const ROLE_DESCRIPTION_EXAMPLE = "Can approve the team's expense claims and see the team's monthly report.";

export interface DescribedRole {
  value: string;
  displayName: string;
  description?: string;
  /** ADR-0078; none = no access in the app. */
  level?: RoleLevel;
}

/** Whether a value is a role level (ADR-0078). */
export const isRoleLevel = (v: unknown): v is RoleLevel => v === "read" || v === "write" || v === "admin";

/** The level of a default role: the instance's, else the core's, else none (no access). */
export function defaultRoleLevel(value: string, instanceLevels?: Readonly<Record<string, string>>): RoleLevel | undefined {
  const own = instanceLevels && Object.hasOwn(instanceLevels, value) ? instanceLevels[value] : undefined;
  if (isRoleLevel(own)) return own;
  return Object.hasOwn(BUILT_IN_ROLE_LEVELS, value) ? BUILT_IN_ROLE_LEVELS[value] : undefined;
}

/** The description of a default role: the instance's, else the core's, else none. */
export function defaultRoleDescription(value: string, instanceDescriptions?: Readonly<Record<string, string>>): string | undefined {
  const own = instanceDescriptions && Object.hasOwn(instanceDescriptions, value) ? instanceDescriptions[value] : undefined;
  if (own) return own;
  return Object.hasOwn(BUILT_IN_ROLE_DESCRIPTIONS, value) ? BUILT_IN_ROLE_DESCRIPTIONS[value] : undefined;
}

/**
 * The app's roles with what each may do: app.yaml's roles as they are (their description, if any), else the
 * instance's default roles with their default descriptions.
 */
export function describedRoles(
  appRoles: readonly { value: string; displayName: string; description?: string; level?: string }[] | undefined,
  defaultRoles: readonly string[],
  instanceDescriptions?: Readonly<Record<string, string>>,
  instanceLevels?: Readonly<Record<string, string>>,
): DescribedRole[] {
  if (appRoles) {
    return appRoles.map((r) => ({ value: r.value, displayName: r.displayName, ...(r.description ? { description: r.description } : {}), ...(isRoleLevel(r.level) ? { level: r.level } : {}) }));
  }
  return defaultRoles.map((value) => {
    const description = defaultRoleDescription(value, instanceDescriptions);
    const level = defaultRoleLevel(value, instanceLevels);
    return { value, displayName: value, ...(description ? { description } : {}), ...(level ? { level } : {}) };
  });
}
